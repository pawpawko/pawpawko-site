// Shared DOM refs, game option lists, and stateless / state-reading helpers
// for the binder view modules (js/binder/). Moved verbatim from the old
// js/binder-view.js; only export keywords and the state.js import were added.

import { state } from './state.js';

export const binderContent = document.getElementById('binderContent');
export const editBtn       = document.getElementById('editBtn');
export const doneBtn       = document.getElementById('doneBtn');
export const actionsBar    = document.getElementById('binderActions');

// Game-specific option lists for the card-browser filters.
export const OPTCG_COLORS     = ['Red', 'Blue', 'Green', 'Purple', 'Black', 'Yellow'];
export const OPTCG_TYPES      = ['LEADER', 'CHARACTER', 'EVENT', 'STAGE'];
export const OPTCG_ATTRIBUTES = ['Slash', 'Strike', 'Special', 'Wisdom', 'Ranged'];
export const OPTCG_RARITIES   = ['L', 'C', 'UC', 'R', 'SR', 'SEC', 'P'];
export const POKEMON_TYPES = [
  'Grass','Fire','Water','Lightning','Psychic','Fighting',
  'Darkness','Metal','Dragon','Colorless','Fairy'
];
export const POKEMON_SUPERTYPES = ['Pokémon', 'Trainer', 'Energy'];
// Rarity sort order, rarest → most common (per game; values are disjoint so
// one combined list is fine). Unknown / null rarities sort last.
export const RARITY_ORDER = [
  // One Piece (rarest first; leaders + promos grouped at the end)
  'SEC', 'SP CARD', 'TR', 'SR', 'R', 'UC', 'C', 'L', 'P',
  // Cyberpunk (rarest first)
  'Epic',
  // Pokémon (+ Cyberpunk shares Rare/Uncommon/Common)
  'Rare Secret', 'Rare Holo EX', 'Rare Holo', 'Rare', 'Uncommon', 'Common', 'Promo'
];
export const POKEMON_SUBTYPES = [
  'Basic','Stage 1','Stage 2','V','VMAX','VSTAR','ex','EX','GX',
  'BREAK','Mega','LEGEND','Tag Team','Radiant','Item','Tool','Stadium','Supporter'
];
export const POKEMON_RARITIES = [
  'Common','Uncommon','Rare','Rare Holo','Rare Holo EX','Rare Holo GX','Rare Holo V','Rare Holo VMAX',
  'Rare Ultra','Rare Secret','Rare Rainbow','Radiant Rare','Amazing Rare',
  'Illustration Rare','Special Illustration Rare','Hyper Rare','Double Rare','Promo'
];
export const POKEMON_HP_BUCKETS = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300];

// Cyberpunk TCG: color + card_type, classifications (tags, the types[] column),
// RAM (deck-building stat), rarities. See scripts/import_cyberpunk_cards.py.
export const CYBERPUNK_COLORS   = ['Red', 'Blue', 'Green', 'Yellow'];
export const CYBERPUNK_TYPES    = ['Legend', 'Unit', 'Gear', 'Program'];
export const CYBERPUNK_RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic'];
export const CYBERPUNK_RAM      = [1, 2, 3, 4, 5, 6];
export const CYBERPUNK_TAGS = [
  '6th Street', 'Aldecado', 'Arasaka', 'Braindance', 'Corpo', 'Cyberware', 'Doll',
  'Drone', 'Extreme', 'Ganger', 'Maelstrom', 'Merc', 'Militech', 'Mox', 'Mystic',
  'NCPD', 'Netrunner', 'Nomad', 'Quickhack', 'Raffen Shiv', 'Ripperdoc', 'Rocker',
  'Samurai', 'Scavenger', 'Trauma Team', 'Tyger Claws', 'Valentino', 'Vehicle',
  'Voodoo Boys', 'Weapon', 'Zetatech'
];

export function applyLayout(layout) {
  state.binderLayout = (layout === '3x3') ? '3x3' : '4x3';
  binderContent.classList.toggle('layout-3x3', state.binderLayout === '3x3');
  binderContent.classList.toggle('layout-4x3', state.binderLayout === '4x3');
  state.currentPage = 1;
}

export function setUrlParam(key, value) {
  const url = new URL(window.location.href);
  if (value === null || value === undefined) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  window.history.replaceState({}, '', url);
}

// Toggle filter groups and sort-options that are scoped to one game.
// data-game-filter / data-game-opt hold a space-separated list of games (a
// filter shared by >1 game, e.g. "optcg cyberpunk"); elements whose list
// doesn't include the current game are hidden so they neither render nor get
// read by the load/filter code paths (which check the input value, '' = off).
export function applyGameUI(category) {
  const gamesOf = v => (v || '').split(/\s+/).filter(Boolean);
  document.querySelectorAll('[data-game-filter]').forEach(el => {
    el.style.display = gamesOf(el.dataset.gameFilter).includes(category) ? '' : 'none';
  });
  document.querySelectorAll('#aestheticsSort [data-game-opt]').forEach(opt => {
    opt.hidden = !gamesOf(opt.dataset.gameOpt).includes(category);
  });
  // Update the Search placeholder so the example card-code matches.
  const searchInput = document.getElementById('cbName');
  if (searchInput) {
    searchInput.placeholder = category === 'pokemon'
      ? 'Pikachu, sv1-1, …'
      : category === 'cyberpunk'
      ? 'V, Adam Smasher, cb-…'
      : 'Luffy, OP01-001, …';
  }
}

export const getPageSize = () => (state.binderLayout === '3x3' ? 9 : 12);

export function listingLabel(t) {
  return ({trade:'Trade Only', sell:'Sell Only', free:'Free', combo:'Trade or Sell'})[t] || t;
}
export const escapeHtml = window.PK.escapeHtml;

// Swap a broken card image for a text placeholder without an inline onerror
// handler (keeps us CSP-clean — no inline event handlers). Markup opts in with
// <img data-fallback="<placeholder class list>" data-code="<placeholder text>">;
// after the HTML is inserted, call wireImgFallbacks(root) on the container.
export function wireImgFallbacks(root) {
  if (!root) return;
  root.querySelectorAll('img[data-fallback]').forEach(img => {
    img.addEventListener('error', () => {
      const ph = document.createElement('div');
      ph.className = img.dataset.fallback;
      ph.textContent = img.dataset.code || '';
      img.replaceWith(ph);
    }, { once: true });
  });
}

// ----- Meta row icons -----
export const ICON_PIN = '<svg class="meta-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>';
export const ICON_TRAIN = '<svg class="meta-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c-4 0-8 .5-8 4v9.5C4 17.4 5.6 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.9 0 3.5-1.6 3.5-3.5V6c0-3.5-3.6-4-8-4zm-3.5 14a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12v5z"/></svg>';
export const ICON_SHOP = '<svg class="meta-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.9 8.89l-1.05-4.37c-.22-.9-1-1.52-1.91-1.52H5.05c-.9 0-1.69.63-1.9 1.52L2.1 8.89c-.24 1.02-.02 2.06.62 2.88.08.11.19.19.28.29V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6.94c.09-.09.2-.18.28-.28.64-.82.87-1.87.62-2.89zM13 19H5v-5.04c.13.01.26.04.39.04.91 0 1.74-.38 2.36-1 .62.62 1.45 1 2.39 1 .91 0 1.74-.38 2.36-1 .62.62 1.45 1 2.39 1V19zm5.61-6c-.6 0-1.18-.25-1.61-.69L16 11.06l-1.01 1.26c-.43.43-1 .68-1.61.68-.6 0-1.18-.25-1.61-.69L11 11.06l-1.01 1.26c-.43.43-1 .68-1.61.68-.6 0-1.18-.25-1.61-.69L6 11.06l-1.01 1.26c-.43.44-1.01.68-1.61.68z"/></svg>';

export function metaRow(icon, text) {
  return `<span class="meta-row">${icon}<span>${escapeHtml(text)}</span></span>`;
}
