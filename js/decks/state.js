// Shared mutable state for the decks editor modules (js/decks/).
// Mirrors 1:1 the variables that sat at the top of the old js/decks.js IIFE,
// plus the three formerly mid-file lets that cross module seams (bench,
// deckValid, dcPending) — same names, same initial values, same comments.
// Modules read/write these as properties (state.deck, state.deckCards, …)
// exactly where the old code used the bare variables. Do not restructure.

export const state = {
  user: null,
  deck: null,            // current decks row
  isDeckOwner: true,     // viewer owns the open deck (vs. a shared-deck collaborator)
  openSeq: 0,            // bumped per openDeck() so a stale load can't render over a newer deck
  leaderCard: null,      // cards row for the leader (base print)
  leaderArts: [],        // base + _p alt-art prints of the leader
  artIdx: 0,             // current art (persisted per deck in localStorage)
  cardArt: {},           // base card code -> print row shown on the grid tile (arrow override, else art_mix majority)
  artOverride: {},       // base card code -> print code picked with the zoom arrows (per-user display pref, localStorage)
  printInfo: {},         // print card_code -> cards row (images) for prints referenced by art_mix / overrides
  ARTMIX_OK: true,       // flips false when deck_cards.art_mix isn't migrated yet (feature stays dark)
  deckCards: [],         // deck_cards rows
  cardInfo: {},          // card_code -> cards row
  ownedElsewhere: {},    // base card_code -> { qty, binders:[name] } across your non-wishlist binders
  exceptions: {},        // card_code -> max_copies (null = unlimited, 0 = banned)
  rotatedPrefixes: new Set(),  // set prefixes out of Standard (e.g. OP01)
  rotationExempt: new Set(),   // base codes legal despite a rotated prefix
  DEMO: false,           // true when no user: real editor, no DB writes
  bench: [],             // [{ code, qty, owned }]
  deckValid: false,
  dcPending: 0,
};
