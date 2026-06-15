-- ============================================================
-- Shared binders (couples / co-owners)
-- ============================================================
-- A binder is owned by one account (binders.user_id) but can be co-edited by
-- one or more "collaborator" accounts. Both accounts point at the SAME binder
-- row + listings, so any edit by either updates the shared binder. Concurrent
-- access works because Postgres handles concurrent writes and RLS grants both
-- accounts write access (the client also subscribes to Realtime to refresh).
--
-- Idempotent — safe to re-run. Apply in the Supabase SQL editor.

-- ---------- collaborators table ----------
create table if not exists public.binder_collaborators (
  binder_id  uuid not null references public.binders(id) on delete cascade,
  user_id    uuid not null references auth.users(id)     on delete cascade,
  added_by   uuid references auth.users(id),
  created_at timestamptz default now(),
  primary key (binder_id, user_id)
);
create index if not exists binder_collaborators_user_idx on public.binder_collaborators(user_id);

-- ---------- membership helper ----------
-- owner OR collaborator. SECURITY DEFINER so RLS policies can call it without
-- recursive policy checks on binders/binder_collaborators.
create or replace function public.is_binder_member(p_binder_id uuid, p_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.binders b
                  where b.id = p_binder_id and b.user_id = p_uid)
      or exists (select 1 from public.binder_collaborators c
                  where c.binder_id = p_binder_id and c.user_id = p_uid);
$$;
revoke all on function public.is_binder_member(uuid, uuid) from public;
grant execute on function public.is_binder_member(uuid, uuid) to authenticated;

-- ---------- binders RLS: members can update; only owner deletes ----------
drop policy if exists "binders_update" on public.binders;
create policy "binders_update" on public.binders for update
  using (public.is_binder_member(id, auth.uid()));
-- binders_insert (owner-only) and binders_delete (owner-only) are unchanged.

-- ---------- listings RLS: any binder member can write ----------
drop policy if exists "listings_insert" on public.listings;
drop policy if exists "listings_update" on public.listings;
drop policy if exists "listings_delete" on public.listings;
create policy "listings_insert" on public.listings for insert
  with check (public.is_binder_member(binder_id, auth.uid()));
create policy "listings_update" on public.listings for update
  using (public.is_binder_member(binder_id, auth.uid()));
create policy "listings_delete" on public.listings for delete
  using (public.is_binder_member(binder_id, auth.uid()));

-- ---------- binder_collaborators RLS ----------
alter table public.binder_collaborators enable row level security;
drop policy if exists "binder_collab_read"   on public.binder_collaborators;
drop policy if exists "binder_collab_insert" on public.binder_collaborators;
drop policy if exists "binder_collab_delete" on public.binder_collaborators;
-- members can see who a binder is shared with
create policy "binder_collab_read" on public.binder_collaborators for select
  using (public.is_binder_member(binder_id, auth.uid()));
-- only the binder OWNER can add a collaborator
create policy "binder_collab_insert" on public.binder_collaborators for insert
  with check (exists (select 1 from public.binders b
                       where b.id = binder_id and b.user_id = auth.uid()));
-- the owner can remove anyone; a collaborator can remove themselves
create policy "binder_collab_delete" on public.binder_collaborators for delete
  using (exists (select 1 from public.binders b
                  where b.id = binder_id and b.user_id = auth.uid())
         or user_id = auth.uid());

-- ---------- RPC: share a binder with another account by display name ----------
-- returns void: a TABLE return whose OUT column is named user_id collides with
-- the user_id table column in the INSERT below ("ambiguous" error 42702). The
-- client refreshes the collaborator list separately, so no return value needed.
drop function if exists public.share_binder(uuid, text);
create or replace function public.share_binder(p_binder_id uuid, p_display_name text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_partner uuid;
begin
  select b.user_id into v_owner from public.binders b where b.id = p_binder_id;
  if v_owner is null then raise exception 'Binder not found'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'Only the binder owner can share it'; end if;

  select p.user_id into v_partner from public.profiles p
   where lower(p.display_name) = lower(btrim(p_display_name))
   limit 1;
  if v_partner is null then raise exception 'No account found with that name'; end if;
  if v_partner = v_owner then raise exception 'That account already owns this binder'; end if;

  insert into public.binder_collaborators (binder_id, user_id, added_by)
  values (p_binder_id, v_partner, auth.uid())
  on conflict (binder_id, user_id) do nothing;
end $$;
revoke all on function public.share_binder(uuid, text) from public;
grant execute on function public.share_binder(uuid, text) to authenticated;

-- ---------- RPC: remove a collaborator (owner, or self) ----------
drop function if exists public.unshare_binder(uuid, uuid);
create or replace function public.unshare_binder(p_binder_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  select b.user_id into v_owner from public.binders b where b.id = p_binder_id;
  if v_owner is null then raise exception 'Binder not found'; end if;
  if v_owner is distinct from auth.uid() and p_user_id is distinct from auth.uid() then
    raise exception 'Not allowed';
  end if;
  delete from public.binder_collaborators
   where binder_id = p_binder_id and user_id = p_user_id;
end $$;
revoke all on function public.unshare_binder(uuid, uuid) from public;
grant execute on function public.unshare_binder(uuid, uuid) to authenticated;

-- ---------- RPC: collaborators of a binder (member-readable, with names) ----------
drop function if exists public.binder_collaborators_list(uuid);
create or replace function public.binder_collaborators_list(p_binder_id uuid)
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = public as $$
  select c.user_id, p.display_name
  from public.binder_collaborators c
  join public.profiles p on p.user_id = c.user_id
  where c.binder_id = p_binder_id
    and public.is_binder_member(p_binder_id, auth.uid())
  order by c.created_at;
$$;
revoke all on function public.binder_collaborators_list(uuid) from public;
grant execute on function public.binder_collaborators_list(uuid) to authenticated;

-- ---------- RPC: binders shared WITH the caller (for My Binders) ----------
drop function if exists public.shared_binders();
create or replace function public.shared_binders()
returns setof public.binders
language sql stable security definer set search_path = public as $$
  select b.*
  from public.binders b
  join public.binder_collaborators c on c.binder_id = b.id
  where c.user_id = auth.uid();
$$;
revoke all on function public.shared_binders() from public;
grant execute on function public.shared_binders() to authenticated;
