-- ============================================================
-- cards.block_number — printed Block Icon, captured at import
-- ============================================================
-- The Block Icon printed on each card (1–5, or 'X'), scraped from
-- en.onepiece-cardgame.com by scripts/import_cards.py. REFERENCE DATA ONLY.
--
-- IMPORTANT: this is the card's ORIGINAL block cohort, NOT its current
-- rotation block, so it CANNOT be used to derive Standard legality.
-- Proven by counterexample: OP04-016 and OP05-003 both print icon "1",
-- yet their real (Limitless) blocks are 4 and 2 and both are Standard-legal
-- — Bandai's "Block Number update" reassigns the current block while the
-- card list keeps the original. Rotation stays set-based + manual exemptions
-- (rotated_sets / rotation_exempt_cards). scripts/rules_check.py only uses
-- this column for display/sanity, never for rotation decisions.

alter table public.cards add column if not exists block_number text;

comment on column public.cards.block_number is
  'Printed Block Icon (1-5 or X) scraped from the official card list — the '
  'ORIGINAL block cohort, NOT the current rotation block. Reference only; '
  'never derive legality from it (OP05-003 prints 1 but is Standard-legal). '
  'Rotation is set-based + manual exemptions. See scripts/rules_check.py.';
