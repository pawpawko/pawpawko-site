-- ============================================================
-- Shared decks (couples / co-owners)
-- ============================================================
-- Mirrors shared binders: a deck is owned by one account (decks.user_id)
-- but can be co-edited by ONE collaborator. Restriction: a deck may only be
-- shared with the partner you already share a TRADE BINDER with for that deck's
-- game — so cards either partner marks owned land in the right shared binder,
-- and unowned shared-deck cards are tracked in BOTH partners' wishlist binders.
--
-- Requires binder_sharing_migration.sql + notifications_migration.sql +
-- decks_migration.sql first. Idempotent; apply in the Supabase SQL editor.

-- ---------- collaborators table ----------
create table if not exists public.deck_collaborators (
  deck_id    uuid not null references public.decks(id)   on delete cascade,
  user_id    uuid not null references auth.users(id)     on delete cascade,
  added_by   uuid references auth.users(id),
  created_at timestamptz default now(),
  primary key (deck_id, user_id)
);
create index if not exists deck_collaborators_user_idx on public.deck_collaborators(user_id);
-- One partner per deck (couples, not groups). Hard backstop; share_deck /
-- respond_deck_invite also guard for friendly errors.
create unique index if not exists one_collaborator_per_deck
  on public.deck_collaborators (deck_id);

-- ---------- membership helper (owner OR collaborator) ----------
create or replace function public.is_deck_member(p_deck_id uuid, p_uid uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.decks d
                  where d.id = p_deck_id and d.user_id = p_uid)
      or exists (select 1 from public.deck_collaborators c
                  where c.deck_id = p_deck_id and c.user_id = p_uid);
$$;
revoke all on function public.is_deck_member(uuid, uuid) from public;
grant execute on function public.is_deck_member(uuid, uuid) to authenticated;

-- ---------- RLS: members read + co-edit; owner-only insert/delete ----------
drop policy if exists "decks_select" on public.decks;
create policy "decks_select" on public.decks for select
  using (is_public or public.is_deck_member(id, auth.uid()));
drop policy if exists "decks_update" on public.decks;
create policy "decks_update" on public.decks for update
  using (public.is_deck_member(id, auth.uid()));
-- decks_insert / decks_delete stay owner-only (unchanged).

drop policy if exists "deck_cards_select" on public.deck_cards;
create policy "deck_cards_select" on public.deck_cards for select
  using (exists (select 1 from public.decks d
                  where d.id = deck_id and (d.is_public or public.is_deck_member(d.id, auth.uid()))));
drop policy if exists "deck_cards_write" on public.deck_cards;
create policy "deck_cards_write" on public.deck_cards for all
  using (public.is_deck_member(deck_id, auth.uid()))
  with check (public.is_deck_member(deck_id, auth.uid()));

-- ---------- deck_collaborators RLS ----------
alter table public.deck_collaborators enable row level security;
drop policy if exists "deck_collab_read"   on public.deck_collaborators;
drop policy if exists "deck_collab_insert" on public.deck_collaborators;
drop policy if exists "deck_collab_delete" on public.deck_collaborators;
-- members can see who a deck is shared with (NOT public)
create policy "deck_collab_read" on public.deck_collaborators for select
  using (public.is_deck_member(deck_id, auth.uid()));
-- only the deck OWNER can add a collaborator
create policy "deck_collab_insert" on public.deck_collaborators for insert
  with check (exists (select 1 from public.decks d
                       where d.id = deck_id and d.user_id = auth.uid()));
-- owner can remove anyone; a collaborator can remove themselves
create policy "deck_collab_delete" on public.deck_collaborators for delete
  using (exists (select 1 from public.decks d
                  where d.id = deck_id and d.user_id = auth.uid())
         or user_id = auth.uid());

-- ---------- per-member wishlist sync helper ----------
-- Mirrors a deck's currently-missing cards into ONE member's wishlist binder
-- (creating it if absent). Used on accept to seed a new collaborator, and on
-- unshare to tear their deck-claimed rows back out.
create or replace function public.resync_deck_member_wishlist(p_deck_id uuid, p_member uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_deck public.decks%rowtype; r record; v_binder uuid; v_missing int;
begin
  select * into v_deck from public.decks where id = p_deck_id;
  if not found then return; end if;

  select id into v_binder from public.binders
   where user_id = p_member and category = v_deck.game and flair = 'wishlist' limit 1;

  for r in select card_code, quantity, owned from public.deck_cards where deck_id = p_deck_id loop
    v_missing := greatest(r.quantity - r.owned, 0);
    if v_missing > 0 then
      if v_binder is null then
        insert into public.binders (user_id, name, category, flair)
        values (p_member, 'Wishlist', v_deck.game, 'wishlist') returning id into v_binder;
      end if;
      if exists (select 1 from public.listings where binder_id = v_binder and card_code = r.card_code) then
        update public.listings set deck_id = v_deck.id, quantity = v_missing
         where binder_id = v_binder and card_code = r.card_code;
      else
        insert into public.listings (binder_id, card_code, quantity, listing_type, deck_id)
        values (v_binder, r.card_code, v_missing, 'trade', v_deck.id);
      end if;
    end if;
  end loop;
end $$;
revoke all on function public.resync_deck_member_wishlist(uuid, uuid) from public;
grant execute on function public.resync_deck_member_wishlist(uuid, uuid) to authenticated;

-- ---------- wishlist sync trigger: fan out to ALL deck members ----------
-- Now SECURITY DEFINER: a co-editor's edit must be able to write the OTHER
-- member's wishlist binder/listings (which they don't own → RLS would block a
-- plain invoker). Loops over owner + collaborators.
create or replace function public.deck_cards_sync_wishlist()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_deck    public.decks%rowtype;
  v_code    text;
  v_missing int;
  v_binder  uuid;
  v_member  uuid;
begin
  select * into v_deck from public.decks where id = coalesce(new.deck_id, old.deck_id);
  if not found then return coalesce(new, old); end if;  -- deck mid-cascade-delete

  v_code := coalesce(new.card_code, old.card_code);
  v_missing := case when tg_op = 'DELETE' then 0
                    else greatest(new.quantity - new.owned, 0) end;

  for v_member in
    select v_deck.user_id
    union
    select user_id from public.deck_collaborators where deck_id = v_deck.id
  loop
    select id into v_binder from public.binders
     where user_id = v_member and category = v_deck.game and flair = 'wishlist' limit 1;

    if v_missing > 0 then
      if v_binder is null then
        insert into public.binders (user_id, name, category, flair)
        values (v_member, 'Wishlist', v_deck.game, 'wishlist') returning id into v_binder;
      end if;
      if exists (select 1 from public.listings where binder_id = v_binder and card_code = v_code) then
        update public.listings set deck_id = v_deck.id, quantity = v_missing
         where binder_id = v_binder and card_code = v_code;
      else
        insert into public.listings (binder_id, card_code, quantity, listing_type, deck_id)
        values (v_binder, v_code, v_missing, 'trade', v_deck.id);
      end if;
    elsif v_binder is not null then
      delete from public.listings
       where binder_id = v_binder and card_code = v_code and deck_id = v_deck.id;
    end if;
  end loop;

  return coalesce(new, old);
end $$;
-- trigger definition unchanged (decks_migration.sql created it); re-create to be safe.
drop trigger if exists deck_cards_sync_wishlist on public.deck_cards;
create trigger deck_cards_sync_wishlist
  after insert or update or delete on public.deck_cards
  for each row execute function public.deck_cards_sync_wishlist();

-- ---------- notify the partner when a shared-deck card is collected ----------
-- Fires when owned increases on a SHARED deck. Notifies the other member(s),
-- coalescing repeated collects of the same card into one running "xN" notice.
create or replace function public.deck_cards_notify_collect()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_deck       public.decks%rowtype;
  v_actor      uuid := auth.uid();
  v_actor_name text;
  v_card_name  text;
  v_delta      int;
  v_member     uuid;
begin
  v_delta := new.owned - coalesce(old.owned, 0);
  if v_delta <= 0 then return new; end if;             -- only on owned increase
  if not exists (select 1 from public.deck_collaborators where deck_id = new.deck_id) then
    return new;                                         -- not a shared deck
  end if;

  select * into v_deck from public.decks where id = new.deck_id;
  select display_name into v_actor_name from public.profiles where user_id = v_actor;
  select name into v_card_name from public.cards
   where game = v_deck.game and card_code = new.card_code;

  for v_member in
    select v_deck.user_id
     where v_deck.user_id <> coalesce(v_actor, '00000000-0000-0000-0000-000000000000'::uuid)
    union
    select user_id from public.deck_collaborators
     where deck_id = new.deck_id
       and user_id <> coalesce(v_actor, '00000000-0000-0000-0000-000000000000'::uuid)
  loop
    -- Coalesce into an existing unread collect notice (same deck+card+actor).
    update public.notifications
       set data = jsonb_set(data, '{qty}',
                            to_jsonb(coalesce((data->>'qty')::int, 0) + v_delta)),
           read = false, created_at = now()
     where user_id = v_member and type = 'deck_card_collected' and read = false
       and (data->>'deck_id')::uuid = new.deck_id
       and data->>'card_code' = new.card_code
       and (data->>'by_user')::uuid = v_actor;
    if not found then
      insert into public.notifications (user_id, type, status, data)
      values (v_member, 'deck_card_collected', 'info',
              jsonb_build_object('deck_id', new.deck_id, 'deck_name', v_deck.name,
                                 'card_code', new.card_code,
                                 'card_name', coalesce(v_card_name, new.card_code),
                                 'qty', v_delta,
                                 'by_user', v_actor, 'by_name', coalesce(v_actor_name, 'Someone')));
    end if;
  end loop;

  return new;
end $$;
drop trigger if exists deck_cards_notify_collect on public.deck_cards;
create trigger deck_cards_notify_collect
  after update on public.deck_cards
  for each row execute function public.deck_cards_notify_collect();

-- ---------- RPC: share a deck (invite a partner by display name) ----------
-- Mirrors share_binder: you type the partner's display name. The named account
-- MUST be your trade-binder co-owner for this deck's game.
drop function if exists public.share_deck(uuid);
drop function if exists public.share_deck(uuid, text);
create or replace function public.share_deck(p_deck_id uuid, p_display_name text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_owner uuid; v_game text; v_dname text; v_partner uuid; v_named uuid; v_fname text; v_leader text;
begin
  select user_id, game, name, leader_card_code into v_owner, v_game, v_dname, v_leader
    from public.decks where id = p_deck_id;
  if v_owner is null then raise exception 'Deck not found'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'Only the deck owner can share it'; end if;

  select user_id into v_named from public.profiles
   where lower(display_name) = lower(btrim(p_display_name)) limit 1;
  if v_named is null then raise exception 'No account found with that name'; end if;
  if v_named = v_owner then raise exception 'That account already owns this deck'; end if;

  -- The named account must be your trade-binder partner for this game:
  -- the other member of your shared trade binder (you as owner OR collaborator).
  select case when b.user_id = auth.uid() then c.user_id else b.user_id end
    into v_partner
    from public.binder_collaborators c
    join public.binders b on b.id = c.binder_id
   where b.flair = 'trade' and b.category = v_game
     and (b.user_id = auth.uid() or c.user_id = auth.uid())
   limit 1;
  if v_partner is null then
    raise exception 'Share a trade binder with your partner first — decks can only be shared with that partner';
  end if;
  if v_partner is distinct from v_named then
    raise exception 'You can only share a deck with your trade-binder partner';
  end if;

  -- One partner per deck; no double invites.
  if exists (select 1 from public.deck_collaborators c where c.deck_id = p_deck_id) then
    raise exception 'This deck already has a partner'; end if;
  if exists (select 1 from public.notifications n
              where n.type = 'deck_invite' and n.status = 'pending'
                and (n.data->>'deck_id')::uuid = p_deck_id) then
    raise exception 'An invite for this deck is already pending';
  end if;

  select display_name into v_fname from public.profiles where user_id = auth.uid();
  insert into public.notifications (user_id, type, status, data)
  values (v_partner, 'deck_invite', 'pending',
          jsonb_build_object('deck_id', p_deck_id, 'deck_name', v_dname,
                             'leader_card_code', v_leader, 'game', v_game,
                             'from_user', auth.uid(), 'from_name', coalesce(v_fname, 'Someone')));
end $$;
revoke all on function public.share_deck(uuid, text) from public;
grant execute on function public.share_deck(uuid, text) to authenticated;

-- ---------- RPC: respond to a deck invite ----------
drop function if exists public.respond_deck_invite(uuid, boolean);
create or replace function public.respond_deck_invite(p_notification_id uuid, p_accept boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare n public.notifications; v_deck uuid; v_from uuid; v_game text; v_name text; v_by text; v_partner uuid; v_leader text;
begin
  select * into n from public.notifications
   where id = p_notification_id and user_id = auth.uid() and type = 'deck_invite';
  if n.id is null then raise exception 'Invite not found'; end if;
  if n.status <> 'pending' then raise exception 'This invite was already handled'; end if;

  v_deck := (n.data->>'deck_id')::uuid;
  v_from := (n.data->>'from_user')::uuid;
  select display_name into v_by from public.profiles where user_id = auth.uid();
  select game, name, leader_card_code into v_game, v_name, v_leader from public.decks where id = v_deck;

  if p_accept then
    if v_game is null then raise exception 'That deck no longer exists'; end if;
    if exists (select 1 from public.deck_collaborators c where c.deck_id = v_deck) then
      raise exception 'This deck already has a partner';
    end if;
    -- Re-confirm the trade-binder partnership still holds for this game.
    select case when b.user_id = v_from then c.user_id else b.user_id end
      into v_partner
      from public.binder_collaborators c
      join public.binders b on b.id = c.binder_id
     where b.flair = 'trade' and b.category = v_game
       and (b.user_id = v_from or c.user_id = v_from)
     limit 1;
    if v_partner is distinct from auth.uid() then
      raise exception 'You are no longer your partner''s trade-binder co-owner for this game';
    end if;

    -- The shared deck REPLACES the recipient's own deck for this leader: destroy
    -- it so they don't keep two decks for the same leader. The delete cascades
    -- its deck_cards and fires decks_cleanup_wishlist to pull its wishlist rows.
    delete from public.decks
     where user_id = auth.uid() and game = v_game
       and leader_card_code = v_leader and id <> v_deck;

    insert into public.deck_collaborators (deck_id, user_id, added_by)
    values (v_deck, auth.uid(), v_from)
    on conflict (deck_id, user_id) do nothing;
    -- Seed the new collaborator's wishlist with the deck's missing cards.
    perform public.resync_deck_member_wishlist(v_deck, auth.uid());

    update public.notifications set status = 'accepted', read = true where id = p_notification_id;
    insert into public.notifications (user_id, type, status, data)
    values (v_from, 'deck_invite_accepted', 'info',
            jsonb_build_object('deck_id', v_deck, 'deck_name', v_name, 'by_name', coalesce(v_by, 'Someone')));
  else
    update public.notifications set status = 'declined', read = true where id = p_notification_id;
    insert into public.notifications (user_id, type, status, data)
    values (v_from, 'deck_invite_declined', 'info',
            jsonb_build_object('deck_id', v_deck, 'deck_name', v_name, 'by_name', coalesce(v_by, 'Someone')));
  end if;
end $$;
revoke all on function public.respond_deck_invite(uuid, boolean) from public;
grant execute on function public.respond_deck_invite(uuid, boolean) to authenticated;

-- ---------- RPC: remove a deck collaborator (owner, or self) ----------
drop function if exists public.unshare_deck(uuid, uuid);
create or replace function public.unshare_deck(p_deck_id uuid, p_user_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.decks where id = p_deck_id;
  if v_owner is null then raise exception 'Deck not found'; end if;
  if v_owner is distinct from auth.uid() and p_user_id is distinct from auth.uid() then
    raise exception 'Not allowed';
  end if;
  delete from public.deck_collaborators where deck_id = p_deck_id and user_id = p_user_id;
  -- Pull the removed member's deck-claimed wishlist rows back out.
  delete from public.listings
   where deck_id = p_deck_id
     and binder_id in (select id from public.binders where user_id = p_user_id and flair = 'wishlist');
end $$;
revoke all on function public.unshare_deck(uuid, uuid) from public;
grant execute on function public.unshare_deck(uuid, uuid) to authenticated;

-- ---------- RPC: collaborators of a deck (member-readable, with names) ----------
drop function if exists public.deck_collaborators_list(uuid);
create or replace function public.deck_collaborators_list(p_deck_id uuid)
returns table (user_id uuid, display_name text)
language sql stable security definer set search_path = public as $$
  select c.user_id, p.display_name
  from public.deck_collaborators c
  join public.profiles p on p.user_id = c.user_id
  where c.deck_id = p_deck_id
    and public.is_deck_member(p_deck_id, auth.uid())
  order by c.created_at;
$$;
revoke all on function public.deck_collaborators_list(uuid) from public;
grant execute on function public.deck_collaborators_list(uuid) to authenticated;

-- ---------- RPC: decks shared WITH the caller (for My Decks) ----------
drop function if exists public.shared_decks();
create or replace function public.shared_decks()
returns setof public.decks
language sql stable security definer set search_path = public as $$
  select d.*
  from public.decks d
  join public.deck_collaborators c on c.deck_id = d.id
  where c.user_id = auth.uid();
$$;
revoke all on function public.shared_decks() from public;
grant execute on function public.shared_decks() to authenticated;

-- ---------- RPC: the caller's trade-binder partner for a deck's game ----------
-- Powers the share form's autofill: a deck can only be shared with the partner
-- you co-own a trade binder with for that game, so prefill that name. Returns
-- no rows when no trade binder is shared (UI leaves the box empty; share_deck
-- then raises the "share a trade binder first" error on submit). Owner-only.
drop function if exists public.deck_trade_partner(uuid);
create or replace function public.deck_trade_partner(p_deck_id uuid)
returns table (user_id uuid, display_name text)
language plpgsql stable security definer set search_path = public as $$
declare v_game text; v_partner uuid;
begin
  select d.game into v_game from public.decks d
   where d.id = p_deck_id and d.user_id = auth.uid();
  if v_game is null then return; end if;             -- not found / not owner
  -- Same partner resolution share_deck uses: the other member of the shared
  -- trade binder for this game (caller as owner OR collaborator).
  select case when b.user_id = auth.uid() then c.user_id else b.user_id end
    into v_partner
    from public.binder_collaborators c
    join public.binders b on b.id = c.binder_id
   where b.flair = 'trade' and b.category = v_game
     and (b.user_id = auth.uid() or c.user_id = auth.uid())
   limit 1;
  if v_partner is null then return; end if;
  return query
    select pr.user_id, pr.display_name from public.profiles pr
     where pr.user_id = v_partner;
end $$;
revoke all on function public.deck_trade_partner(uuid) from public;
grant execute on function public.deck_trade_partner(uuid) to authenticated;

-- ---------- RPC: the pending invite for a deck (owner-only) ----------
-- After share_deck the partner holds a pending deck_invite notification, but
-- notifications are RLS read-own so the OWNER can't see it directly. This lets
-- the owner's UI replace "+ Add partner" with the invited partner's name while
-- acceptance is pending. SECURITY DEFINER, gated to the deck owner.
drop function if exists public.deck_pending_invite(uuid);
create or replace function public.deck_pending_invite(p_deck_id uuid)
returns table (user_id uuid, display_name text, notification_id uuid)
language sql stable security definer set search_path = public as $$
  select n.user_id, p.display_name, n.id
  from public.notifications n
  join public.decks d on d.id = (n.data->>'deck_id')::uuid
  join public.profiles p on p.user_id = n.user_id
  where n.type = 'deck_invite' and n.status = 'pending'
    and (n.data->>'deck_id')::uuid = p_deck_id
    and d.user_id = auth.uid()                        -- only the deck owner
  limit 1;
$$;
revoke all on function public.deck_pending_invite(uuid) from public;
grant execute on function public.deck_pending_invite(uuid) to authenticated;

-- ---------- RPC: rescind a still-pending deck invite (owner-only) ----------
-- Lets the owner cancel a mistaken/stale invite that hasn't been accepted yet,
-- so the "+ Add partner" affordance can come back. (unshare_deck handles the
-- already-accepted case.)
drop function if exists public.rescind_deck_invite(uuid);
create or replace function public.rescind_deck_invite(p_deck_id uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.decks where id = p_deck_id;
  if v_owner is null then raise exception 'Deck not found'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'Only the deck owner can do that'; end if;
  delete from public.notifications
   where type = 'deck_invite' and status = 'pending'
     and (data->>'deck_id')::uuid = p_deck_id;
end $$;
revoke all on function public.rescind_deck_invite(uuid) from public;
grant execute on function public.rescind_deck_invite(uuid) to authenticated;
