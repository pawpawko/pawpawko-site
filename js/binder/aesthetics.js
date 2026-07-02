// Aesthetics mode (rearrange cards): layout sorts, drag-and-drop reorder,
// move-to-page picker, and sort_order persistence. Moved verbatim from the
// old js/binder-view.js; only export keywords and the imports were added.

import { state } from './state.js';
import { binderContent, setUrlParam, applyLayout, getPageSize, RARITY_ORDER, POKEMON_TYPES, POKEMON_SUPERTYPES } from './helpers.js';
import { renderCurrentPage } from './index.js';

// ---------- Aesthetics mode (rearrange cards) ----------
let aestheticsWired = false;

export function wireAestheticsToggle() {
  if (aestheticsWired) return;
  const btn = document.getElementById('aestheticsToggle');
  if (!btn) return;
  aestheticsWired = true;
  btn.addEventListener('click', () => {
    state.aestheticsMode ? exitAesthetics() : enterAesthetics();
  });
}
const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Purple', 'Black', 'Yellow'];
let aestheticsSortMode = 'custom-4x3';

async function saveLayout(layout) {
  applyLayout(layout);
  if (state.DEMO) return;
  if (!state.isOwner) return;   // layout is an owner-only binder-row setting (RLS enforces it); apply locally for collaborators but don't fire a rejected UPDATE
  const { error } = await window.sb.from('binders')
    .update({ layout }).eq('id', state.currentBinderId);
  if (error) console.warn('layout save failed:', error.message);
}

function applySortMode(mode) {
  aestheticsSortMode = mode;
  if (mode === 'custom-4x3' || mode === 'custom-3x3') {
    const targetLayout = (mode === 'custom-3x3') ? '3x3' : '4x3';
    if (targetLayout !== state.binderLayout) saveLayout(targetLayout);
    // Custom sort = use saved sort_order (natural order of allListings).
    state.currentListings = state.allListings.slice();
  } else if (mode === 'release') {
    state.currentListings = state.allListings.slice().sort((a, b) =>
      (b.cards?.release_order || 0) - (a.cards?.release_order || 0) ||
      String(a.card_code).localeCompare(b.card_code));
  } else if (mode === 'color') {
    const rank = c => { const i = COLOR_ORDER.indexOf(c?.cards?.color); return i < 0 ? 99 : i; };
    state.currentListings = state.allListings.slice().sort((a, b) =>
      rank(a) - rank(b) ||
      (a.cards?.cost || 0) - (b.cards?.cost || 0) ||
      String(a.card_code).localeCompare(b.card_code));
  } else if (mode === 'cost') {
    state.currentListings = state.allListings.slice().sort((a, b) =>
      (a.cards?.cost ?? 99) - (b.cards?.cost ?? 99) ||
      String(a.card_code).localeCompare(b.card_code));
  } else if (mode === 'ram') {
    state.currentListings = state.allListings.slice().sort((a, b) =>
      (a.cards?.ram ?? 99) - (b.cards?.ram ?? 99) ||
      String(a.card_code).localeCompare(b.card_code));
  } else if (mode === 'rarity') {
    // Group by rarity (rarest first); within each rarity, newest release first.
    const rank = c => { const i = RARITY_ORDER.indexOf(c?.cards?.rarity); return i < 0 ? 99 : i; };
    state.currentListings = state.allListings.slice().sort((a, b) =>
      rank(a) - rank(b) ||
      (b.cards?.release_order || 0) - (a.cards?.release_order || 0) ||
      String(a.card_code).localeCompare(b.card_code));
  } else if (mode === 'ptype') {
    // Pokémon elemental type. Sort by the first listed type, fall
    // back alphabetical; ties broken by HP desc then card_code.
    const rank = c => {
      const t = (c?.cards?.types || [])[0];
      const i = POKEMON_TYPES.indexOf(t);
      return i < 0 ? 99 : i;
    };
    state.currentListings = state.allListings.slice().sort((a, b) =>
      rank(a) - rank(b) ||
      (b.cards?.hp || 0) - (a.cards?.hp || 0) ||
      String(a.card_code).localeCompare(b.card_code));
  } else if (mode === 'hp') {
    state.currentListings = state.allListings.slice().sort((a, b) =>
      (b.cards?.hp ?? -1) - (a.cards?.hp ?? -1) ||
      String(a.card_code).localeCompare(b.card_code));
  } else if (mode === 'supertype') {
    const rank = c => {
      const i = POKEMON_SUPERTYPES.indexOf(c?.cards?.supertype);
      return i < 0 ? 99 : i;
    };
    state.currentListings = state.allListings.slice().sort((a, b) =>
      rank(a) - rank(b) ||
      String(a.card_code).localeCompare(b.card_code));
  }
  state.currentPage = 1;
  renderCurrentPage();
}

function wireAestheticsSort() {
  const sel = document.getElementById('aestheticsSort');
  if (!sel || sel.dataset.wired) return;
  sel.dataset.wired = '1';
  sel.addEventListener('change', () => applySortMode(sel.value));
}

export function enterAesthetics() {
  state.aestheticsMode = true;
  binderContent.classList.add('aesthetics');
  document.getElementById('aestheticsToggle').setAttribute('aria-pressed', 'true');
  const sel = document.getElementById('aestheticsSort');
  if (sel) {
    sel.style.display = '';
    // Default the dropdown to whichever custom layout the binder currently uses.
    const NON_CUSTOM_SORTS = ['release','rarity','color','cost','ram','ptype','hp','supertype'];
    if (!NON_CUSTOM_SORTS.includes(aestheticsSortMode)) {
      aestheticsSortMode = (state.binderLayout === '3x3') ? 'custom-3x3' : 'custom-4x3';
    }
    sel.value = aestheticsSortMode;
  }
  wireAestheticsSort();
  moveExcludeToggle('filter-bar');
  setUrlParam('aesthetics', '1');
  setUrlParam('edit', '1');
  renderCurrentPage();
}
export async function exitAesthetics() {
  state.aestheticsMode = false;
  binderContent.classList.remove('aesthetics');
  const btn = document.getElementById('aestheticsToggle');
  if (btn) btn.setAttribute('aria-pressed', 'false');
  const sel = document.getElementById('aestheticsSort');
  if (sel) sel.style.display = 'none';
  moveExcludeToggle('header');
  setUrlParam('aesthetics', null);
  // If an auto-sort (release / rarity / color / cost / …) is active, bake the
  // sorted order in as the binder's new saved order so it persists after
  // exiting — otherwise the view would snap back to the old custom order.
  // (Manual custom layouts are already saved on drag.) Guard on equal length
  // so a stray filtered view can never drop cards.
  const isAuto = aestheticsSortMode !== 'custom-4x3' && aestheticsSortMode !== 'custom-3x3';
  if (isAuto && state.currentListings.length === state.allListings.length) {
    state.allListings = state.currentListings.slice();
    await persistPositions();
    aestheticsSortMode = (state.binderLayout === '3x3') ? 'custom-3x3' : 'custom-4x3';
    if (sel) sel.value = aestheticsSortMode;
  }
  state.currentListings = state.allListings.slice();
  renderCurrentPage();
}

function moveExcludeToggle(target) {
  const toggle = document.getElementById('excludeBinderToggle');
  if (!toggle) return;
  if (target === 'filter-bar') {
    // Wrap Clear filters + toggle in a flex row at the end of the filter bar.
    const filterBar = document.getElementById('editFilters');
    const clearBtn  = document.getElementById('cbClear');
    if (!filterBar || !clearBtn) return;
    let endRow = document.getElementById('filterEndRow');
    if (!endRow) {
      endRow = document.createElement('div');
      endRow.id = 'filterEndRow';
      endRow.className = 'filter-end-row';
      filterBar.appendChild(endRow);
    }
    toggle.classList.add('exclude-toggle-bottom');
    endRow.appendChild(toggle);    // toggle on the left
    endRow.appendChild(clearBtn);  // Clear filters on the right
  } else {
    // Restore Clear back to filter bar directly; toggle back to cards header.
    const filterBar = document.getElementById('editFilters');
    const clearBtn  = document.getElementById('cbClear');
    const endRow    = document.getElementById('filterEndRow');
    const header    = document.querySelector('.binder-cards-header');
    if (clearBtn && filterBar) filterBar.appendChild(clearBtn);
    if (header && toggle.parentElement !== header) {
      toggle.classList.remove('exclude-toggle-bottom');
      header.appendChild(toggle);
    }
    if (endRow) endRow.remove();
  }
}

// Drag-and-drop reorder within currentListings.
// Persists by writing `sort_order` (0..N-1) for affected rows.
let dragSrcId = null;
export function attachDragHandlers(tile, listing) {
  tile.setAttribute('draggable', 'true');
  tile.dataset.listingId = listing.id;
  tile.addEventListener('dragstart', e => {
    dragSrcId = listing.id;
    tile.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', listing.id); } catch (_) {}
  });
  tile.addEventListener('dragend', () => {
    tile.classList.remove('dragging');
    document.querySelectorAll('.card-tile.drag-over').forEach(el => el.classList.remove('drag-over'));
  });
  tile.addEventListener('dragover', e => {
    if (!dragSrcId || dragSrcId === listing.id) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tile.classList.add('drag-over');
  });
  tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
  tile.addEventListener('drop', async e => {
    e.preventDefault();
    tile.classList.remove('drag-over');
    const srcId = dragSrcId;
    const dstId = listing.id;
    dragSrcId = null;
    if (!srcId || srcId === dstId) return;
    await moveListing(srcId, dstId);
  });
}

async function moveListing(srcId, dstId) {
  // If user reorders while in an auto-sort, that becomes the new custom.
  if (aestheticsSortMode !== 'custom-4x3' && aestheticsSortMode !== 'custom-3x3') {
    state.allListings = state.currentListings.slice();
    aestheticsSortMode = (state.binderLayout === '3x3') ? 'custom-3x3' : 'custom-4x3';
    const sel = document.getElementById('aestheticsSort');
    if (sel) sel.value = aestheticsSortMode;
  }
  const srcIdx = state.allListings.findIndex(l => l.id === srcId);
  const dstIdx = state.allListings.findIndex(l => l.id === dstId);
  if (srcIdx < 0 || dstIdx < 0) return;
  const [moved] = state.allListings.splice(srcIdx, 1);
  state.allListings.splice(dstIdx, 0, moved);
  await persistPositions();
  state.currentListings = state.allListings.slice();
  renderCurrentPage();
}

async function persistPositions() {
  if (state.DEMO) { state.allListings.forEach((l, i) => { l.sort_order = i; }); return; }
  // Write sort_order = index for every listing. Could be optimized to only the affected range.
  const updates = state.allListings.map((l, i) => ({ id: l.id, sort_order: i, binder_id: state.currentBinderId, card_code: l.card_code, quantity: l.quantity, listing_type: l.listing_type }));
  // Use single upsert keyed on id.
  const { error } = await window.sb.from('listings').upsert(updates, { onConflict: 'id' });
  if (error) console.warn('reorder save failed:', error.message);
  state.allListings.forEach((l, i) => { l.sort_order = i; });
}

// "Move to page N" click handler — replaces openAddListing in aesthetics mode.
export async function openMovePagePicker(listing) {
  const total = state.currentListings.length;
  const pageSize = getPageSize();
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages < 2) { alert('Only one page so far.'); return; }
  const input = prompt(`Move "${listing.cards?.name || listing.card_code}" to which page? (1–${totalPages})`);
  const target = parseInt((input || '').trim(), 10);
  if (!target || target < 1 || target > totalPages) return;
  const srcIdx = state.allListings.findIndex(l => l.id === listing.id);
  if (srcIdx < 0) return;
  // Remove and re-insert at end-of-target-page sort_order.
  const [moved] = state.allListings.splice(srcIdx, 1);
  // After removal, target-page end index is min(target*pageSize, len) - 1, then +1 for insertion point.
  const insertAt = Math.min(target * pageSize, state.allListings.length);
  state.allListings.splice(insertAt, 0, moved);
  await persistPositions();
  state.currentListings = state.allListings.slice();
  state.currentPage = target;
  renderCurrentPage();
}
