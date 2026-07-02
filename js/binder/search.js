// Non-owner search mode: the "Search this binder" toggle viewers get in
// place of the edit button, reusing the card-browser filter bar. Moved
// verbatim from the old js/binder-view.js; only the export keyword and the
// imports were added.

import { state } from './state.js';
import { binderContent } from './helpers.js';
import { populateDropdowns } from './browser.js';
import { filterBinderListings, renderListings } from './index.js';

// ----- Non-owner search mode -----
let searchInited = false;
export function toggleSearch() {
  const btn = document.getElementById('searchThisBinder');
  const wasPressed = btn.getAttribute('aria-pressed') === 'true';
  const nowPressed = !wasPressed;
  btn.setAttribute('aria-pressed', String(nowPressed));
  if (nowPressed) {
    binderContent.classList.add('searching');
    if (!searchInited) {
      initSearchFilters();
      searchInited = true;
    }
    filterBinderListings();
  } else {
    binderContent.classList.remove('searching');
    renderListings(state.allListings);
  }
}

async function initSearchFilters() {
  await populateDropdowns();
  ['cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity','cbSupertype','cbSubtype','cbHp'].forEach(id => {
    document.getElementById(id).addEventListener('change', filterBinderListings);
  });
  document.getElementById('cbName').addEventListener('input', () => {
    clearTimeout(state.cbDebounceTimer);
    state.cbDebounceTimer = setTimeout(filterBinderListings, 250);
  });
  document.getElementById('cbClear').addEventListener('click', () => {
    ['cbName','cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity','cbSupertype','cbSubtype','cbHp','cbTag','cbRam'].forEach(id => {
      document.getElementById(id).value = '';
    });
    filterBinderListings();
  });
}
