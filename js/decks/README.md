# js/decks/ — decks.html editor modules

- `index.js` is the entry (`<script type="module">` in decks.html): init + wiring, deck list, editor core, card zoom, serialized deck-card writes, signed-out demo. The split-out sections: `helpers.js`, `state.js`, `collab.js` (shared-deck realtime + invites), `bench.js` (bench + drag-and-drop), `browser.js` (Add-Cards overlay), `import-export.js`, `prices.js`, `stats.js`, `cyberpunk.js` (DECK_MODULES plugin).
- Cross-module mutable state lives in `state.js` as one exported `state` object (`state.deck`, `state.deckCards`, …) — a 1:1 mirror of the old IIFE top-block; window globals (PK, sb, config) still come from the classic scripts, which always run before module scripts.
- Modules are deferred — the DOM exists at import time.
