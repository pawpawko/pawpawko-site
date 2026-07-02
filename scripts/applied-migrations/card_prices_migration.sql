-- ============================================================
-- card_prices_migration.sql
-- Cached single-card price fields on public.cards, populated by
-- scripts/update_prices.py (cheapest USD print price, TCGplayer via Limitless).
-- Powers the deck editor's "Cost to Finish" button (price of missing cards).
--
-- Idempotent — safe to re-run. cards stays world-readable (RLS unchanged);
-- writes remain service-role only, exactly like the rest of the card data.
-- ============================================================

alter table public.cards add column if not exists price_usd        numeric(10,2);
alter table public.cards add column if not exists price_updated_at timestamptz;

comment on column public.cards.price_usd is
  'Cheapest USD price across this card number''s prints (TCGplayer via Limitless). Maintained by scripts/update_prices.py; null = no price found yet.';
comment on column public.cards.price_updated_at is
  'When price_usd was last refreshed by scripts/update_prices.py.';
