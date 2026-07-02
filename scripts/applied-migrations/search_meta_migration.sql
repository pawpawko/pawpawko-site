-- Adds a cached "searcher" predicate to cards, for the decks stats feature
-- (search hit-rate). One Piece has no searcher label in its metadata, so the
-- predicate is parsed from effect_text by scripts/search_meta.py and written by
-- the service role (same trust model as cards.price_usd — cards stays
-- world-readable, no RLS change).
--
-- Idempotent; safe to re-run. Apply in the Supabase SQL editor (DDL can't go via
-- REST). After applying, populate with either:
--   python scripts/analyze_searchers.py --write     (backfill existing cards)
--   python scripts/import_cards.py --full           (re-import; also backfills)
-- New cards get search_meta automatically on every subsequent import.

alter table public.cards
  add column if not exists search_meta jsonb;

comment on column public.cards.search_meta is
  'Parsed One Piece searcher predicate (null = not a recognized searcher). '
  'Shape: {kind,look,take,filters[],union,gated,trigger,template,confidence,source}. '
  'Written service-role only by scripts/search_meta.py; see search_meta_migration.sql.';

-- Cheap "is this a searcher?" filtering for the deck stats query.
create index if not exists cards_is_searcher_idx
  on public.cards ((search_meta is not null));
