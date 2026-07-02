// Stateless / state-reading helpers shared by the decks editor modules
// (js/decks/). Moved verbatim from the old js/decks.js; only export
// keywords and the state.js import were added.

import { state } from './state.js';

export const GAME = 'optcg';
export const $ = (id) => document.getElementById(id);

export const isBase = (code) => !/_p\d+$/i.test(code);
export const baseCode = (code) => String(code).split('_')[0];
// art_mix: {alt print code -> copies} on a deck_cards row; base copies are
// implied (quantity - sum). '{}'/absent = all base.
export const artMixOf = (r) => (r && r.art_mix && typeof r.art_mix === 'object') ? r.art_mix : {};
export const altCountOf = (r) => Object.values(artMixOf(r)).reduce((s, n) => s + (n > 0 ? n : 0), 0);
// One Piece color letters (U = Blue, since B is taken by Black). Used for the
// default deck name: "Green/Blue Uta" -> "GU Uta Deck".
const COLOR_ABBREV = { Red: 'R', Green: 'G', Blue: 'U', Purple: 'P', Black: 'B', Yellow: 'Y' };
export const colorAbbrev = (color) => String(color || '').split('/')
  .map(c => COLOR_ABBREV[c.trim()] || (c.trim()[0] || '').toUpperCase()).join('');
export const standardLegal = (code) =>
  !state.rotatedPrefixes.has(baseCode(code).split('-')[0]) || state.rotationExempt.has(baseCode(code));
export const pillValue = (groupId) =>
  document.querySelector(`#${groupId} .pill-choice-btn.active`)?.dataset.value;
export const setPill = (groupId, value) => {
  document.querySelectorAll(`#${groupId} .pill-choice-btn`).forEach(b =>
    b.classList.toggle('active', b.dataset.value === value));
};
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const esc = window.PK.escapeHtml;

// copy cap for a base code: undefined exception -> 4; null -> unlimited; n -> n
export function capFor(code) {
  if (!(code in state.exceptions)) return 4;
  return state.exceptions[code]; // null = unlimited
}

// Sort helper shared by the deck grid, the bench, and decklist export.
export const byCostThenCode = (a, b) => {
  const ca = state.cardInfo[a.card_code] || {}, cb = state.cardInfo[b.card_code] || {};
  return (ca.cost ?? 99) - (cb.cost ?? 99) || String(a.card_code).localeCompare(b.card_code);
};
