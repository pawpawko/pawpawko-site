-- ============================================================
-- AUTO-SEARCH presence (mobile feature)
-- ------------------------------------------------------------
-- A user opts in via the Jolly icon. While active, their row in
-- user_presence is upserted every 60s with coarse-rounded lat/lng
-- (~110m grid) and an optional event_code. Discovery is hybrid:
--   * GPS proximity (≤ 500 m) — ad-hoc encounters
--   * Event code match (≤ 2 mi / 3220 m) — organized events
-- Rows auto-expire after 1 hour without re-ping. Re-tap = extend.
-- Privacy: the table is RPC-only (no direct select); RPCs never
-- echo lat/lng back to callers. Only the row owner can delete.
-- See memory: project-pawpawko-mobile-auto-search.
-- ============================================================

create extension if not exists cube;
create extension if not exists earthdistance;

create table if not exists public.user_presence (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  lat        double precision not null,
  lng        double precision not null,
  event_code text,
  last_ping  timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '1 hour')
);

create index if not exists user_presence_geo_idx
  on public.user_presence using gist (ll_to_earth(lat, lng));
create index if not exists user_presence_event_idx
  on public.user_presence (lower(event_code))
  where event_code is not null;
create index if not exists user_presence_expires_idx
  on public.user_presence (expires_at);

alter table public.user_presence enable row level security;

drop policy if exists "presence delete own" on public.user_presence;
create policy "presence delete own"
  on public.user_presence
  for delete
  using (auth.uid() = user_id);

-- Upsert caller's presence row. Coarsens lat/lng (~110 m). Refreshes
-- expires_at on every call so re-tapping Jolly extends the session.
-- TTL is 1 hour without an event code, 4 hours with one (event sessions
-- run longer because organized meetups last longer).
-- event_code is normalized to lowercase + trimmed; empty string clears.
create or replace function public.upsert_presence(
  p_lat        double precision,
  p_lng        double precision,
  p_event_code text default null
) returns void
language plpgsql
security definer
set search_path = public as $$
declare
  v_code text;
  v_ttl  interval;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;
  v_code := nullif(lower(btrim(coalesce(p_event_code, ''))), '');
  v_ttl  := case when v_code is not null then interval '4 hours' else interval '1 hour' end;
  insert into public.user_presence (user_id, lat, lng, event_code, last_ping, expires_at)
  values (
    auth.uid(),
    round(p_lat::numeric, 3)::double precision,
    round(p_lng::numeric, 3)::double precision,
    v_code,
    now(),
    now() + v_ttl
  )
  on conflict (user_id) do update
    set lat        = excluded.lat,
        lng        = excluded.lng,
        event_code = excluded.event_code,
        last_ping  = excluded.last_ping,
        expires_at = excluded.expires_at;
end;
$$;
revoke all on function public.upsert_presence(double precision, double precision, text) from public;
grant execute on function public.upsert_presence(double precision, double precision, text) to authenticated;

-- Force-clear caller's presence row (explicit OFF).
create or replace function public.clear_presence()
returns void
language sql
security definer
set search_path = public as $$
  delete from public.user_presence where user_id = auth.uid();
$$;
revoke all on function public.clear_presence() from public;
grant execute on function public.clear_presence() to authenticated;

-- Hybrid nearby trade binders. Filters:
--   * presence not expired
--   * not the caller themselves
--   * (within 500 m) OR (matching event_code within 2 mi)
--   * binder.flair = 'trade'
-- Returns the same shape as search_binders plus a distance_m column
-- so the UI can show "120m away" etc. The two-way distance is computed
-- once in the WITH clause and reused in the WHERE.
create or replace function public.nearby_trade_binders(
  p_lat        double precision,
  p_lng        double precision,
  p_event_code text default null
) returns table (
  binder_id          uuid,
  user_id            uuid,
  display_name       text,
  binder_name        text,
  binder_description text,
  sleeve_image_url   text,
  flair              text,
  category           text,
  last_updated_at    timestamptz,
  distance_m         double precision
)
language sql
stable
security definer
set search_path = public as $$
  with code as (
    select nullif(lower(btrim(coalesce(p_event_code, ''))), '') as v
  ),
  caller_pt as (
    select ll_to_earth(p_lat, p_lng) as pt
  ),
  active as (
    select up.user_id,
           up.event_code,
           earth_distance(ll_to_earth(up.lat, up.lng), (select pt from caller_pt)) as distance_m
      from public.user_presence up
     where up.expires_at > now()
       and up.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  hits as (
    select a.user_id, a.distance_m
      from active a, code
     where a.distance_m <= 500
        or (code.v is not null and a.event_code = code.v and a.distance_m <= 3220)
  )
  select b.id as binder_id,
         b.user_id,
         p.display_name,
         b.name as binder_name,
         b.description as binder_description,
         b.sleeve_image_url,
         b.flair,
         b.category,
         coalesce((select max(l.created_at) from public.listings l where l.binder_id = b.id), b.created_at) as last_updated_at,
         h.distance_m
    from hits h
    join public.binders b on b.user_id = h.user_id
    join public.profiles p on p.user_id = b.user_id
   where b.flair = 'trade'
   order by h.distance_m asc, last_updated_at desc
   limit 200;
$$;
revoke all on function public.nearby_trade_binders(double precision, double precision, text) from public;
grant execute on function public.nearby_trade_binders(double precision, double precision, text) to authenticated;

-- Phase 2: wishlist matches across the same hybrid nearby set.
-- Returns one row per (nearby trade binder × matched card_code group):
-- binder_id, owner_display_name, the matched card codes the caller
-- has on any of their wishlist binders for the SAME game.
create or replace function public.nearby_wishlist_matches(
  p_lat        double precision,
  p_lng        double precision,
  p_event_code text default null
) returns table (
  binder_id          uuid,
  owner_user_id      uuid,
  owner_display_name text,
  category           text,
  matched_card_codes text[]
)
language sql
stable
security definer
set search_path = public as $$
  with code as (
    select nullif(lower(btrim(coalesce(p_event_code, ''))), '') as v
  ),
  caller_pt as (
    select ll_to_earth(p_lat, p_lng) as pt
  ),
  active as (
    select up.user_id,
           up.event_code,
           earth_distance(ll_to_earth(up.lat, up.lng), (select pt from caller_pt)) as distance_m
      from public.user_presence up
     where up.expires_at > now()
       and up.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  hits as (
    select a.user_id, a.distance_m
      from active a, code
     where a.distance_m <= 500
        or (code.v is not null and a.event_code = code.v and a.distance_m <= 3220)
  ),
  -- Caller's wishlist card_codes per game.
  my_wishes as (
    select b.category, l.card_code
      from public.binders b
      join public.listings l on l.binder_id = b.id
     where b.user_id = auth.uid()
       and b.flair  = 'wishlist'
  )
  select b.id as binder_id,
         b.user_id as owner_user_id,
         p.display_name as owner_display_name,
         b.category,
         array_agg(distinct l.card_code order by l.card_code) as matched_card_codes
    from hits h
    join public.binders  b on b.user_id = h.user_id and b.flair = 'trade'
    join public.profiles p on p.user_id = b.user_id
    join public.listings l on l.binder_id = b.id
    join my_wishes m on m.category = b.category and m.card_code = l.card_code
   group by b.id, b.user_id, p.display_name, b.category
   order by array_length(array_agg(distinct l.card_code), 1) desc nulls last
   limit 200;
$$;
revoke all on function public.nearby_wishlist_matches(double precision, double precision, text) from public;
grant execute on function public.nearby_wishlist_matches(double precision, double precision, text) to authenticated;
