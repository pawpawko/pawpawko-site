-- ============================================================
-- Cyberpunk TCG support — additive columns on public.cards
-- ============================================================
-- Adds the Cyberpunk-specific card attributes that don't map onto an
-- existing column. Everything else reuses the shared schema:
--
--   color        <- Cyberpunk color (Red / Blue / Green / Yellow)
--   type         <- card_type      (Legend / Unit / Gear / Program)
--   cost         <- Eddie cost (top-left of the card)
--   power        <- power (Units; null for most Gear/Program/Legends)
--   rarity       <- Common / Uncommon / Rare / Epic / ...
--   effect_text  <- rules_text (keyword markup like {Play}, {Call}, {Go Solo})
--   types text[] <- classifications / tags (Arasaka, Corpo, Netrunner, ...)
--   series       <- set display name ("Welcome to Night City — Retail")
--   set_id       <- set code        ("welcometonightcityretail")
--   number       <- collector / print number ("005a")
--   image_url(_lg) <- R2-mirrored card art (cyberpunk/ namespace)
--   release_order <- launch-wave order (all current sets share one wave)
--
-- Rows are keyed by the composite PK (game, card_code); game = 'cyberpunk',
-- card_code = netdeck external_id (e.g. 'cb-v-streetkid'). These columns are
-- nullable + additive, so optcg/pokemon rows are untouched.
--
-- Idempotent. cards stays world-readable; service-role writes only (no RLS change).

-- 0) Allowlist 'cyberpunk' on the game discriminator. The multi-game migration
--    (2026-05-18) created `cards_game_check check (game in ('optcg','pokemon'))`,
--    which rejects every cyberpunk row. Drop + re-add it widened to three games.
--    Idempotent: re-running drops and recreates the same widened constraint.
do $$ begin
  if exists (select 1 from pg_constraint where conname = 'cards_game_check') then
    alter table public.cards drop constraint cards_game_check;
  end if;
  alter table public.cards add constraint cards_game_check
    check (game in ('optcg','pokemon','cyberpunk'));
end $$;

-- RAM: the core deck-building constraint. Each card has a single RAM value tied
-- to its color; a card is deck-legal only if its RAM <= the sum of your three
-- Legends' RAM in that card's color. Legends carry the RAM *limit* they grant.
alter table public.cards add column if not exists ram int;

-- Eddiable: card has a Sell tag (can be sold from hand for 1 Eddie/turn).
alter table public.cards add column if not exists is_eddiable boolean;

-- Keyword abilities printed on the card (concave-highlight keywords such as
-- Quick / Blocker / Go Solo). Empty for the launch set but populated going
-- forward as the source enumerates them.
alter table public.cards add column if not exists keywords text[];

-- Illustrator credit ("Illustrated by ...").
alter table public.cards add column if not exists artist text;

-- Source-reported deck legality flag (e.g. 'legal'). Feeds the future
-- deck-builder's ban/restriction logic — see scripts/cyberpunk_deck_rules.json.
alter table public.cards add column if not exists legality text;

comment on column public.cards.ram is
  'Cyberpunk TCG RAM value. Deck-building constraint: a card is legal only if '
  'its RAM <= sum of the deck''s three Legends'' RAM in the card''s color. '
  'Legends store the per-color RAM limit they grant. See cyberpunk_deck_rules.json.';

create index if not exists cards_ram_idx on public.cards(ram);
