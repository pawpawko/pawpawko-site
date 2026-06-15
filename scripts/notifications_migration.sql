-- ============================================================
-- Notifications + binder-invite accept/decline flow
-- ============================================================
-- Requires binder_sharing_migration.sql first. Idempotent; apply in the
-- Supabase SQL editor.
--
-- Sharing a binder no longer adds the partner immediately. share_binder now
-- creates a PENDING 'binder_invite' notification for the partner. The partner
-- accepts (becomes a collaborator; their own trade binder for that game is
-- replaced) or declines. Either way the inviter gets an info notification.

-- ---------- notifications table ----------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,  -- recipient
  type       text not null,            -- binder_invite | binder_invite_accepted | binder_invite_declined
  status     text not null default 'info',  -- pending | accepted | declined | info
  data       jsonb not null default '{}'::jsonb,
  read       boolean not null default false,
  created_at timestamptz default now()
);
create index if not exists notifications_user_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;
-- Recipients can read their own; all writes happen through SECURITY DEFINER RPCs
-- so callers can't forge a notification or flip status without going through the
-- accept/decline logic.
drop policy if exists "notifications_read" on public.notifications;
create policy "notifications_read" on public.notifications for select
  using (user_id = auth.uid());

-- ---------- share_binder → create a pending invite ----------
drop function if exists public.share_binder(uuid, text);
create or replace function public.share_binder(p_binder_id uuid, p_display_name text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_partner uuid; v_bname text; v_fname text; v_flair text;
begin
  select b.user_id, b.name, b.flair into v_owner, v_bname, v_flair from public.binders b where b.id = p_binder_id;
  if v_owner is null then raise exception 'Binder not found'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'Only the binder owner can share it'; end if;
  -- Only trade binders can have a partner (wishlist/flex/lgs are not shareable).
  if v_flair is distinct from 'trade' then raise exception 'Only trade binders can be shared with a partner'; end if;
  -- One partner per binder: block if it already has a collaborator OR any pending invite.
  if exists (select 1 from public.binder_collaborators c where c.binder_id = p_binder_id) then
    raise exception 'This binder already has a partner'; end if;
  if exists (select 1 from public.notifications n
              where n.type = 'binder_invite' and n.status = 'pending'
                and (n.data->>'binder_id')::uuid = p_binder_id) then
    raise exception 'An invite for this binder is already pending';
  end if;

  select p.user_id into v_partner from public.profiles p
   where lower(p.display_name) = lower(btrim(p_display_name))
   limit 1;
  if v_partner is null then raise exception 'No account found with that name'; end if;
  if v_partner = v_owner then raise exception 'That account already owns this binder'; end if;

  select display_name into v_fname from public.profiles where user_id = auth.uid();
  insert into public.notifications (user_id, type, status, data)
  values (v_partner, 'binder_invite', 'pending',
          jsonb_build_object('binder_id', p_binder_id, 'binder_name', v_bname,
                             'from_user', auth.uid(), 'from_name', coalesce(v_fname, 'Someone')));
end $$;
revoke all on function public.share_binder(uuid, text) from public;
grant execute on function public.share_binder(uuid, text) to authenticated;

-- ---------- respond to an invite (accept / decline) ----------
drop function if exists public.respond_binder_invite(uuid, boolean);
create or replace function public.respond_binder_invite(p_notification_id uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare n public.notifications; v_binder uuid; v_from uuid;
        v_flair text; v_cat text; v_name text; v_by text; v_old uuid;
begin
  select * into n from public.notifications
   where id = p_notification_id and user_id = auth.uid() and type = 'binder_invite';
  if n.id is null then raise exception 'Invite not found'; end if;
  if n.status <> 'pending' then raise exception 'This invite was already handled'; end if;

  v_binder := (n.data->>'binder_id')::uuid;
  v_from   := (n.data->>'from_user')::uuid;
  select display_name into v_by from public.profiles where user_id = auth.uid();
  select flair, category, name into v_flair, v_cat, v_name from public.binders where id = v_binder;

  if p_accept then
    if v_binder is null or v_cat is null then raise exception 'That binder no longer exists'; end if;
    if v_flair is distinct from 'trade' then raise exception 'Only trade binders can be shared with a partner'; end if;
    -- One partner per binder: if someone already joined (e.g. two invites were
    -- out and one was accepted first), reject this accept with a clear message
    -- instead of letting the unique index throw a raw error.
    if exists (select 1 from public.binder_collaborators c where c.binder_id = v_binder) then
      raise exception 'This binder already has a partner';
    end if;
    -- Merge (non-destructive): fold the partner's own trade binder for this game
    -- into the shared binder instead of deleting it, so no cards are lost. The
    -- couple then co-edits the single shared binder.
    select id into v_old from public.binders
     where user_id = auth.uid() and category = v_cat and flair = 'trade'
     limit 1;
    if v_old is not null and v_old is distinct from v_binder then
      -- 1. Overlapping cards: add the partner's quantity onto the shared row.
      update public.listings sh
         set quantity = sh.quantity + ov.qty
        from (select card_code, sum(quantity) as qty
                from public.listings where binder_id = v_old group by card_code) ov
       where sh.binder_id = v_binder and sh.card_code = ov.card_code;
      -- 2. Drop the partner's rows that were just folded in.
      delete from public.listings
       where binder_id = v_old
         and card_code in (select card_code from public.listings where binder_id = v_binder);
      -- 3. Move the remaining (non-overlapping) cards into the shared binder;
      --    null sort_order so they append at the end of the existing layout.
      update public.listings set binder_id = v_binder, sort_order = null
       where binder_id = v_old;
      -- 4. The partner's old binder is now empty — remove it.
      delete from public.binders where id = v_old;
    end if;
    insert into public.binder_collaborators (binder_id, user_id, added_by)
    values (v_binder, auth.uid(), v_from)
    on conflict (binder_id, user_id) do nothing;
    update public.notifications set status = 'accepted', read = true where id = p_notification_id;
    insert into public.notifications (user_id, type, status, data)
    values (v_from, 'binder_invite_accepted', 'info',
            jsonb_build_object('binder_name', v_name, 'by_name', coalesce(v_by, 'Someone')));
  else
    update public.notifications set status = 'declined', read = true where id = p_notification_id;
    insert into public.notifications (user_id, type, status, data)
    values (v_from, 'binder_invite_declined', 'info',
            jsonb_build_object('binder_name', v_name, 'by_name', coalesce(v_by, 'Someone')));
  end if;
end $$;
revoke all on function public.respond_binder_invite(uuid, boolean) from public;
grant execute on function public.respond_binder_invite(uuid, boolean) to authenticated;

-- ---------- mark the caller's notifications read ----------
drop function if exists public.mark_notifications_read();
create or replace function public.mark_notifications_read()
returns void
language sql security definer set search_path = public as $$
  update public.notifications set read = true
   where user_id = auth.uid() and read = false;
$$;
revoke all on function public.mark_notifications_read() from public;
grant execute on function public.mark_notifications_read() to authenticated;
