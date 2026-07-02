-- ============================================================
-- TRADE TAP — two-way wishlist↔trade matches between two users
-- ------------------------------------------------------------
-- Caller and the partner (passed by user_id) get a single result
-- set listing every card where one side wants what the other has,
-- in either direction. MUTUAL trades (both directions hit) sort
-- to the top.
--   * i_want_they_have  = my wishlist ∩ their trade
--   * they_want_i_have  = their wishlist ∩ my trade
-- A row appears if either direction holds; both flags true = mutual.
-- Card lookups join `cards` on (game, card_code) so the consumer
-- gets name + image_url for free.
-- See memory: project-pawpawko-mobile-trade-tap.
-- ============================================================

create or replace function public.trade_matches(p_partner_user_id uuid)
returns table (
  game                  text,
  card_code             text,
  card_name             text,
  card_image_url        text,
  i_want_they_have      boolean,
  they_want_i_have      boolean,
  my_trade_binder_id    uuid,
  their_trade_binder_id uuid,
  mutual                boolean
)
language sql
stable
security definer
set search_path = public as $$
  with me as (select auth.uid() as user_id),
  my_wish as (
    select b.category as game, l.card_code
      from public.binders b
      join public.listings l on l.binder_id = b.id
      join me on b.user_id = me.user_id
     where b.flair = 'wishlist'
  ),
  my_trade as (
    select b.category as game, l.card_code, b.id as binder_id
      from public.binders b
      join public.listings l on l.binder_id = b.id
      join me on b.user_id = me.user_id
     where b.flair = 'trade'
  ),
  their_wish as (
    select b.category as game, l.card_code
      from public.binders b
      join public.listings l on l.binder_id = b.id
     where b.user_id = p_partner_user_id and b.flair = 'wishlist'
  ),
  their_trade as (
    select b.category as game, l.card_code, b.id as binder_id
      from public.binders b
      join public.listings l on l.binder_id = b.id
     where b.user_id = p_partner_user_id and b.flair = 'trade'
  ),
  all_codes as (
    select distinct game, card_code from (
      -- cards I want that they have
      select mw.game, mw.card_code
        from my_wish mw
        join their_trade tt on tt.game = mw.game and tt.card_code = mw.card_code
      union
      -- cards they want that I have
      select tw.game, tw.card_code
        from their_wish tw
        join my_trade mt on mt.game = tw.game and mt.card_code = tw.card_code
    ) u
  )
  select c.game,
         c.card_code,
         cd.name      as card_name,
         cd.image_url as card_image_url,
         (exists (select 1 from my_wish    mw where mw.game = c.game and mw.card_code = c.card_code)
            and exists (select 1 from their_trade tt where tt.game = c.game and tt.card_code = c.card_code)) as i_want_they_have,
         (exists (select 1 from their_wish tw where tw.game = c.game and tw.card_code = c.card_code)
            and exists (select 1 from my_trade    mt where mt.game = c.game and mt.card_code = c.card_code)) as they_want_i_have,
         (select binder_id from my_trade    where game = c.game and card_code = c.card_code limit 1) as my_trade_binder_id,
         (select binder_id from their_trade where game = c.game and card_code = c.card_code limit 1) as their_trade_binder_id,
         ((exists (select 1 from my_wish    mw where mw.game = c.game and mw.card_code = c.card_code)
             and exists (select 1 from their_trade tt where tt.game = c.game and tt.card_code = c.card_code))
          and
          (exists (select 1 from their_wish tw where tw.game = c.game and tw.card_code = c.card_code)
             and exists (select 1 from my_trade    mt where mt.game = c.game and mt.card_code = c.card_code))) as mutual
    from all_codes c
    join public.cards cd on cd.game = c.game and cd.card_code = c.card_code
   order by mutual desc,
            c.game asc,
            c.card_code asc;
$$;
revoke all on function public.trade_matches(uuid) from public;
grant execute on function public.trade_matches(uuid) to authenticated;

-- Phase 2: Recent Taps history. One row per caller × partner × day,
-- so repeat taps on the same day update existing rows instead of
-- polluting history.
create table if not exists public.trade_tap_history (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  partner_user_id uuid not null references auth.users(id) on delete cascade,
  tapped_at       timestamptz not null default now(),
  match_count     int not null default 0,
  -- Trick: store the date as a generated column so the unique constraint
  -- gives us "one tap per partner per day" without needing an expression
  -- index (which Postgres allows but Supabase Studio can't display nicely).
  tapped_on       date generated always as ((tapped_at at time zone 'UTC')::date) stored
);
create unique index if not exists trade_tap_history_user_partner_day_idx
  on public.trade_tap_history (user_id, partner_user_id, tapped_on);
create index if not exists trade_tap_history_user_idx
  on public.trade_tap_history (user_id, tapped_at desc);

alter table public.trade_tap_history enable row level security;

drop policy if exists "tap history select own" on public.trade_tap_history;
create policy "tap history select own"
  on public.trade_tap_history
  for select
  using (auth.uid() = user_id);

drop policy if exists "tap history delete own" on public.trade_tap_history;
create policy "tap history delete own"
  on public.trade_tap_history
  for delete
  using (auth.uid() = user_id);

-- Insert/update is RPC-only. Caller must be authenticated and the
-- partner must be a real auth.users row (FK guards that).
create or replace function public.record_trade_tap(p_partner_user_id uuid, p_match_count int)
returns uuid
language plpgsql
security definer
set search_path = public as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;
  if p_partner_user_id is null then
    raise exception 'p_partner_user_id is required';
  end if;
  if p_partner_user_id = auth.uid() then
    raise exception 'cannot record a trade tap with yourself';
  end if;
  insert into public.trade_tap_history (user_id, partner_user_id, match_count)
  values (auth.uid(), p_partner_user_id, greatest(coalesce(p_match_count, 0), 0))
  on conflict (user_id, partner_user_id, tapped_on) do update
    set match_count = excluded.match_count,
        tapped_at   = now()
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.record_trade_tap(uuid, int) from public;
grant execute on function public.record_trade_tap(uuid, int) to authenticated;
