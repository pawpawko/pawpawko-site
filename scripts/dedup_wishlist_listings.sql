-- Dedup wishlist listings created by the swipe-up race (mobile).
-- A burst of swipe-up gestures on one card could insert several identical
-- (binder_id, card_code) rows before the first count-check landed. This keeps
-- the OLDEST row per (binder_id, card_code) in wishlist binders and deletes the
-- rest. Run section 1 first to inspect; only then run section 2.
--
-- Safe to re-run: once dups are gone, section 2 deletes nothing.

-- ── 1. PREVIEW: which rows would be deleted (everything except the oldest) ──
with ranked as (
  select l.id,
         l.binder_id,
         l.card_code,
         l.created_at,
         row_number() over (
           partition by l.binder_id, l.card_code
           order by l.created_at asc, l.id asc
         ) as rn
  from public.listings l
  join public.binders b on b.id = l.binder_id
  where b.flair = 'wishlist'
)
select * from ranked where rn > 1 order by binder_id, card_code, created_at;

-- ── 2. DELETE the duplicates (keeps rn = 1, the oldest) ──
-- Uncomment and run once the preview above looks right.
-- with ranked as (
--   select l.id,
--          row_number() over (
--            partition by l.binder_id, l.card_code
--            order by l.created_at asc, l.id asc
--          ) as rn
--   from public.listings l
--   join public.binders b on b.id = l.binder_id
--   where b.flair = 'wishlist'
-- )
-- delete from public.listings
-- where id in (select id from ranked where rn > 1);
