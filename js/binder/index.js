// ============================================
// Binder page — unified view + (owner-only) edit
// URL: /binders/<slug>  (Netlify rewrites to binder.html?slug=<slug>)
// Falls back to ?user=<userId> for backwards compat.
// ============================================

import { state } from './state.js';
import { startBinderDemo } from './demo.js';
import { wireAestheticsToggle, enterAesthetics, exitAesthetics, attachDragHandlers, openMovePagePicker } from './aesthetics.js';
import { initCardBrowser } from './browser.js';
import { toggleSearch } from './search.js';
import { binderContent, editBtn, doneBtn, actionsBar, applyLayout, setUrlParam, applyGameUI, getPageSize, listingLabel, escapeHtml, wireImgFallbacks, ICON_PIN, ICON_TRAIN, ICON_SHOP, metaRow } from './helpers.js';

const setupNotice = document.getElementById('setupNotice');
setupNotice.innerHTML = window.PK.notReadyMessage();

const params       = new URLSearchParams(location.search);
let   binderId     = params.get('id');           // binder UUID (canonical)
const slug         = (params.get('slug') || '').toLowerCase();   // pretty share link
const userId       = params.get('user');         // legacy fallback
const autoEditMode = params.get('edit') === '1' || params.get('aesthetics') === '1';
const autoAesthetics = params.get('aesthetics') === '1';
// Signed-out interactive demo (embedded in a carousel on my-binders.html):
// ?demo=optcg|pokemon runs the REAL binder view on an in-memory binder — no
// saves (every DB write is DEMO-gated).
if (state.DEMO) document.body.classList.add('binder-demo');

// Modules can't top-level return: the old '!SB_READY' and 'no binder'
// early returns became the pair of guards on the init() call at the bottom.
const NO_BINDER = !binderId && !slug && !userId && !state.DEMO;
if (window.SB_READY && NO_BINDER) {
  document.getElementById('binderStatus').textContent = 'No binder specified.';
}


async function init() {
  if (state.DEMO) { await startBinderDemo(); return; }
  const me = await window.PK.currentUser();
  state.viewerUserId = me?.id || null;
  const isLoggedIn = !!me;

  // Resolve slug → binderId via RPC before the main load path. Slug format is
  // <owner>-<binder-name>-<first-8-hex-of-uuid>; the suffix is the disambiguator.
  if (!binderId && slug) {
    const { data: resolvedId, error: resolveErr } =
      await window.sb.rpc('resolve_binder_slug', { p_slug: slug });
    if (!resolveErr && resolvedId) binderId = resolvedId;
  }

  // 1. Load binder + owner profile
  let binder, profErr;
  if (binderId) {
    if (isLoggedIn) {
      const { data: brow, error: berr } = await window.sb
        .from('binders')
        .select('id, user_id, name, description, sleeve_image_url, binder_background_url, flair, category, layout')
        .eq('id', binderId)
        .maybeSingle();
      if (berr) profErr = berr;
      else if (brow) {
        const { data: prow } = await window.sb
          .from('profiles')
          .select('display_name, discord_handle, boroughs, subway_stops, local_shops')
          .eq('user_id', brow.user_id)
          .maybeSingle();
        binder = { ...brow, ...(prow || {}), binder_name: brow.name, binder_description: brow.description };
      }
    } else {
      const { data, error } = await window.sb.rpc('get_binder_public', { p_binder_id: binderId });
      profErr = error;
      const row = data && data[0];
      if (row) binder = { id: row.id, user_id: row.user_id, display_name: row.display_name,
                          binder_name: row.binder_name, binder_description: row.binder_description,
                          sleeve_image_url: row.sleeve_image_url, binder_background_url: row.binder_background_url,
                          flair: row.flair, category: row.category, layout: row.layout };
    }
  } else if (userId) {
    // Legacy: user_id param → grab their first binder
    const { data: blist } = await window.sb.from('binders').select('id').eq('user_id', userId).order('created_at').limit(1);
    if (blist && blist[0]) { location.replace('binder.html?id=' + encodeURIComponent(blist[0].id)); return; }
  }

  if (profErr || !binder) {
    document.getElementById('binderStatus').textContent = 'Binder not found.';
    return;
  }

  state.currentBinderId = binder.id;
  state.ownerUserId = binder.user_id;
  state.isOwner = isLoggedIn && state.viewerUserId === state.ownerUserId;
  // Shared binders: a collaborator (e.g. a partner) co-edits the same binder.
  state.isCollab = false;
  if (isLoggedIn && !state.isOwner) {
    const { data: cr } = await window.sb
      .from('binder_collaborators').select('user_id')
      .eq('binder_id', state.currentBinderId).eq('user_id', state.viewerUserId).maybeSingle();
    state.isCollab = !!cr;
  }
  state.canEdit = state.isOwner || state.isCollab;
  state.sleeveImageUrl = binder.sleeve_image_url || null;
  state.binderCategory = ['pokemon', 'cyberpunk'].includes(binder.category) ? binder.category : 'optcg';
  state.binderFlair = binder.flair || null;
  applyGameUI(state.binderCategory);
  const profile = binder;  // alias for the rest of the function

  // 2. Render header
  const displayName = profile.display_name || 'someone';
  const binderName  = profile.binder_name || 'binder';
  const titleText = `${displayName}'s ${binderName}`;
  const editIcon = state.isOwner
    ? `<button type="button" id="binderNameEditBtn" class="binder-name-edit-btn" aria-label="Edit binder name" title="Edit name">
         <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
           <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.04a1 1 0 0 0 0-1.42l-2.5-2.5a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 2-1.66Z"/>
         </svg>
       </button>`
    : '';
  document.getElementById('binderTitle').innerHTML =
    `${escapeHtml(displayName)}'s <span class="binder-name-group"><em id="binderNameView">${escapeHtml(binderName)}</em>${editIcon}</span>`;
  document.title = `${titleText} | Pawpaw Ko`;
  setupShare(profile);
  setupCollab();   // owner: manage sharing; collaborator: shows who it's shared with
  renderCategory(profile.category || 'optcg');
  renderFlair(profile.flair || 'trade');
  applyLayout(profile.layout || '4x3');
  if (state.isOwner) { wireFlairSelect(); wireBinderNameEdit(); }   // binder-row metadata is owner-only (RLS enforces it too); collaborators co-edit cards only

  if (isLoggedIn) {
    const rows = [];
    const boroughs = (profile.boroughs || []).join(', ');
    const subway   = (profile.subway_stops || []).join(', ');
    const shops    = (profile.local_shops || []).join(', ');
    if (boroughs) rows.push(metaRow(ICON_PIN,   boroughs));
    if (subway)   rows.push(metaRow(ICON_TRAIN, subway));
    if (shops)    rows.push(metaRow(ICON_SHOP,  shops));
    document.getElementById('binderMeta').innerHTML = rows.join('');

    // Show Discord contact only when viewer can't edit (co-editors don't need it)
    if (!state.canEdit && profile.discord_handle) {
      document.getElementById('binderContact').innerHTML =
        `Contact on Discord: <strong>${escapeHtml(profile.discord_handle)}</strong>`;
    }
  } else {
    document.getElementById('binderMeta').innerHTML =
      `<span class="locked-pill"><a href="account.html">Sign in</a> to see location & contact</span>`;
  }

  // 3. Show edit button (owner or collaborator) or search toggle (viewers)
  if (state.canEdit) {
    actionsBar.style.display = '';
    editBtn.addEventListener('click', enterEdit);
    doneBtn.addEventListener('click', exitEdit);
    if (autoEditMode) enterEdit();
    if (autoAesthetics) enterAesthetics();
  } else {
    const toggleWrap = document.getElementById('binderSearchToggle');
    const toggle     = document.getElementById('searchThisBinder');
    if (toggleWrap) toggleWrap.style.display = '';
    if (toggle) toggle.addEventListener('click', toggleSearch);
  }

  // Live-sync edits between co-owners viewing the same binder at once.
  if (state.canEdit) subscribeBinderRealtime();

  // Restore the page the user was last on for this binder (survives refresh).
  const savedPage = parseInt(sessionStorage.getItem('pawpaw:binderPage:' + state.currentBinderId), 10);
  if (savedPage > 1) state.pendingKeepPage = savedPage;
  loadListings(state.canEdit, isLoggedIn);
}

const FLAIR_LABELS = { trade: 'Trade Binder', wishlist: 'Wishlist Binder', flex: 'Flex Binder', lgs: 'Local Game Store' };
const CATEGORY_LABELS = { optcg: 'OPTCG', pokemon: 'Pokémon', cyberpunk: 'Cyberpunk' };

export function renderCategory(category) {
  const el = document.getElementById('binderCategory');
  if (!el) return;
  const cat = category || 'optcg';
  el.textContent = CATEGORY_LABELS[cat] || CATEGORY_LABELS.optcg;
  el.className = `category-pill cat-${cat}`;
  el.style.display = '';
}

export function renderFlair(flair) {
  const current = flair || 'trade';
  const pill = document.getElementById('binderFlair');
  pill.textContent = FLAIR_LABELS[current] || FLAIR_LABELS.trade;
  pill.className = `binder-flair-pill flair-${current}`;
  pill.style.display = '';
  document.querySelectorAll('#binderFlairChips .binder-flair-chip').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.flair === current);
  });
}

function wireBinderNameEdit() {
  const view = document.getElementById('binderNameView');
  const btn  = document.getElementById('binderNameEditBtn');
  if (!view || !btn) return;
  let original = view.textContent;
  const stop = async (commit) => {
    view.removeAttribute('contenteditable');
    view.classList.remove('editing');
    const next = view.textContent.trim();
    if (!commit || !next || next === original) { view.textContent = original; return; }
    const { error } = await window.sb.from('binders')
      .update({ name: next }).eq('id', state.currentBinderId);
    if (error) { alert('Could not rename binder: ' + error.message); view.textContent = original; return; }
    original = next;
    document.title = `${document.getElementById('binderTitle').textContent.split("'s")[0]}'s ${next} | Pawpaw Ko`;
  };
  btn.addEventListener('click', () => {
    original = view.textContent;
    view.setAttribute('contenteditable', 'plaintext-only');
    view.classList.add('editing');
    view.focus();
    // Place caret at end
    const r = document.createRange(); r.selectNodeContents(view); r.collapse(false);
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  view.addEventListener('blur', () => stop(true));
  view.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); view.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); stop(false); view.blur(); }
  });
}

function wireFlairSelect() {
  document.querySelectorAll('#binderFlairChips .binder-flair-chip').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      const newFlair = btn.dataset.flair;
      const { error } = await window.sb.from('binders')
        .update({ flair: newFlair }).eq('id', state.currentBinderId);
      if (error) { alert('Could not update flair: ' + error.message); return; }
      renderFlair(newFlair);
    });
  });
}

export function enterEdit() {
  binderContent.classList.add('editing');
  document.body.classList.add('binder-editing');
  actionsBar.style.display = 'none';   // hides Edit Binder button row
  doneBtn.style.display = '';          // Done lives in the title row
  if (!state.cardBrowserInited) initCardBrowser();
  wireAestheticsToggle();
  setUrlParam('edit', '1');
}
export function exitEdit() {
  binderContent.classList.remove('editing');
  document.body.classList.remove('binder-editing');
  actionsBar.style.display = '';       // show Edit Binder again
  doneBtn.style.display = 'none';
  if (state.aestheticsMode) exitAesthetics();
  setUrlParam('edit', null);
  setUrlParam('aesthetics', null);
}

export async function loadListings(showEditControls, isLoggedIn) {
  state.lastShowEditControls = showEditControls;
  state.lastIsLoggedIn = isLoggedIn;
  const statusEl = document.getElementById('binderStatus');
  if (state.DEMO) { renderDeckFilter(); renderBinderUpdated(state.allListings); filterBinderListings(); return; }

  // Two-query pattern for both paths: fetch listings (or call the
  // public RPC), then look up matching cards by (game, card_code) and
  // attach as a synthetic `cards` field per listing. Previously the
  // authenticated path used PostgREST's embedded join (`cards(...)`),
  // but the multi-game migration dropped the FK from listings →
  // cards, so PostgREST's schema cache no longer resolves that.
  let listings, lerr;
  let rawListings = null;
  if (isLoggedIn) {
    const res = await window.sb
      .from('listings')
      .select('id, quantity, listing_type, notes, card_code, sort_order, created_at, deck_id')
      .eq('binder_id', state.currentBinderId)
      .order('sort_order', { ascending: true, nullsFirst: false })
      // Un-placed cards (null sort_order) append at the end: oldest first,
      // newest last. So auto-added rows (e.g. deck wishlist sync) land at
      // the bottom of the binder rather than jumping to page one.
      .order('created_at', { ascending: true });
    lerr = res.error;
    rawListings = res.data;
  } else {
    const { data, error } = await window.sb.rpc('get_binder_listings_public', { p_binder_id: state.currentBinderId });
    lerr = error;
    rawListings = data;
  }

  if (!lerr) {
    const codes = (rawListings || []).map(r => r.card_code);
    let cardsByCode = {};
    if (codes.length) {
      const { data: cards } = await window.sb.from('cards')
        .select('card_code, name, image_url, image_url_lg, color, type, cost, attribute, rarity, series, release_order, supertype, subtypes, types, hp, ram')
        .eq('game', state.binderCategory)
        .in('card_code', codes);
      (cards || []).forEach(c => { cardsByCode[c.card_code] = c; });
    }
    listings = (rawListings || []).map(r => ({ ...r, cards: cardsByCode[r.card_code] || {} }));
  }

  if (lerr) {
    statusEl.textContent = 'Error loading listings: ' + lerr.message;
    return;
  }

  // Deck-origin enrichment (owner-only, wishlist binders): the auto wishlist
  // sync stamps deck-sourced rows with listings.deck_id, where quantity = the
  // copies still missing for that deck. Look up the deck names so the tile can
  // attribute the card. Kept owner-only — the public RPC never returns deck_id,
  // so anon viewers of a shared wishlist never see (possibly private) deck names.
  state.decksById = {};
  if (state.isOwner && state.binderFlair === 'wishlist') {
    const deckIds = [...new Set((listings || []).map(l => l.deck_id).filter(Boolean))];
    if (deckIds.length) {
      const { data: decks } = await window.sb
        .from('decks').select('id, name, leader_card_code').in('id', deckIds);
      (decks || []).forEach(d => { state.decksById[d.id] = d; });
    }
  }

  state.allListings = listings || [];
  renderDeckFilter();
  renderBinderUpdated(state.allListings);
  // Render through the filter path so an active filter (e.g. while adding
  // cards with "Show all" un-toggled) persists across reloads instead of
  // snapping back to the full binder. With "Show all" checked or no filters
  // set, this resolves to the full list anyway.
  filterBinderListings();
}

function renderBinderUpdated(listings) {
  const el = document.getElementById('binderUpdated');
  if (!el) return;
  const stamps = (listings || [])
    .map(l => l.created_at)
    .filter(Boolean)
    .map(s => new Date(s).getTime())
    .filter(t => !isNaN(t));
  if (!stamps.length) { el.textContent = ''; return; }
  const latestMs = Math.max(...stamps);
  const diffMs = Date.now() - latestMs;
  const minutes = Math.floor(diffMs / 60000);
  const hours   = Math.floor(diffMs / 3600000);
  let label;
  if (diffMs < 60000) {
    label = 'just now';
  } else if (minutes < 60) {
    label = `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  } else if (hours < 24) {
    label = `${hours} hour${hours === 1 ? '' : 's'} ago`;
  } else {
    label = new Date(latestMs).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  el.textContent = `Last updated ${label}`;
}

// Re-render when crossing the mobile breakpoint so page-size adapts.
let lastPageSize = getPageSize();
window.addEventListener('resize', () => {
  const ps = getPageSize();
  if (ps !== lastPageSize) { lastPageSize = ps; state.currentPage = 1; renderCurrentPage(); }
});

export function renderListings(listings) {
  state.currentListings = listings || [];
  if (state.pendingKeepPage != null) {
    // Stay on the page the user was on (e.g. after "Got it"); renderCurrentPage
    // clamps to the new total if a card dropped off.
    state.currentPage = state.pendingKeepPage;
    state.pendingKeepPage = null;
  } else {
    // Default to page 1, unless a card was flagged to focus (e.g. just added) —
    // then jump to the page that card lands on.
    state.currentPage = 1;
    if (state.pendingFocusCode) {
      const idx = state.currentListings.findIndex(l => l.card_code === state.pendingFocusCode);
      if (idx >= 0) state.currentPage = Math.floor(idx / getPageSize()) + 1;
      state.pendingFocusCode = null;
    }
  }
  renderCurrentPage();
}

export function renderCurrentPage() {
  const grid     = document.getElementById('cardGrid');
  const statusEl = document.getElementById('binderStatus');
  const pagEl    = document.getElementById('binderPagination');
  const pagTopEl = document.getElementById('binderPaginationTop');
  grid.innerHTML = '';
  pagEl.innerHTML = '';
  if (pagTopEl) pagTopEl.innerHTML = '';

  const total      = state.currentListings.length;
  const totalPages = Math.max(1, Math.ceil(total / getPageSize()));
  if (state.currentPage > totalPages) state.currentPage = totalPages;
  // Remember the current page so a browser refresh lands here again.
  try { sessionStorage.setItem('pawpaw:binderPage:' + state.currentBinderId, state.currentPage); } catch (e) {}
  const start = (state.currentPage - 1) * getPageSize();
  const pageItems = state.currentListings.slice(start, start + getPageSize());

  // Status
  const filteredSuffix = (total !== state.allListings.length) ? ` of ${state.allListings.length}` : '';
  if (total === 0) {
    statusEl.textContent = state.lastShowEditControls
      ? 'No cards yet. Click Edit Binder, then add some.'
      : 'No cards in this binder yet.';
  } else {
    statusEl.textContent = `${total}${filteredSuffix} listing${total === 1 ? '' : 's'}` +
      (totalPages > 1 ? ` · Page ${state.currentPage} of ${totalPages}` : '');
  }

  // Render 25 slots — fill with cards, then empty placeholders to fill the 5x5
  for (let i = 0; i < getPageSize(); i++) {
    const l = pageItems[i];
    if (l) {
      const tile = buildListingTile(l);
      if (state.aestheticsMode) {
        tile.classList.add('aesthetics-tile');
        attachDragHandlers(tile, l);
        tile.addEventListener('click', e => {
          // Intercept any inner clicks — open move-to-page picker instead.
          e.preventDefault();
          e.stopPropagation();
          openMovePagePicker(l);
        }, true);
      } else {
        // View mode: tap a card to expand it, then swipe/arrow through the binder.
        const idx = start + i;   // index into currentListings
        tile.classList.add('expandable');
        tile.addEventListener('click', e => {
          // Don't hijack edit-mode controls or inner buttons (Got it, etc.).
          if (binderContent.classList.contains('editing')) return;
          if (e.target.closest('button, input, select, textarea, a, label')) return;
          openLightbox(idx);
        });
      }
      grid.appendChild(tile);
    } else {
      const empty = document.createElement('div');
      empty.className = 'card-tile empty-slot';
      if (state.sleeveImageUrl) {
        empty.classList.add('has-sleeve');
        empty.style.backgroundImage = `url(${state.sleeveImageUrl})`;
      }
      grid.appendChild(empty);
    }
  }

  // Pagination controls — mirror the same ‹ 1 2 3 › row above and below the grid.
  const goToPage = (p) => { state.currentPage = p; renderCurrentPage(); };
  const buildPagination = (container) => {
    if (!container || totalPages <= 1) return;
    container.appendChild(pageButton('‹', state.currentPage > 1, () => goToPage(state.currentPage - 1)));
    for (let p = 1; p <= totalPages; p++) {
      container.appendChild(pageButton(String(p), true, () => goToPage(p), p === state.currentPage));
    }
    container.appendChild(pageButton('›', state.currentPage < totalPages, () => goToPage(state.currentPage + 1)));
  };
  buildPagination(pagTopEl);
  buildPagination(pagEl);

  // Side arrows flanking the grid — flip a page at a time.
  const sidePrev = document.getElementById('binderSidePrev');
  const sideNext = document.getElementById('binderSideNext');
  if (sidePrev && sideNext) {
    const multi = totalPages > 1;
    sidePrev.style.display = multi ? '' : 'none';
    sideNext.style.display = multi ? '' : 'none';
    sidePrev.disabled = state.currentPage <= 1;
    sideNext.disabled = state.currentPage >= totalPages;
    sidePrev.onclick = () => { if (state.currentPage > 1) goToPage(state.currentPage - 1); };
    sideNext.onclick = () => { if (state.currentPage < totalPages) goToPage(state.currentPage + 1); };
  }

  if (state.lastShowEditControls) wireEditHandlers();
}

function pageButton(label, enabled, onClick, isActive) {
  const b = document.createElement('button');
  b.className = 'page-btn' + (isActive ? ' active' : '');
  b.textContent = label;
  b.disabled = !enabled;
  if (enabled) b.addEventListener('click', onClick);
  return b;
}

// ------------------- Card lightbox (tap to expand + swipe through binder) -------------------
// Navigates across the whole current view (currentListings), so a swipe crosses
// page boundaries and respects any active filter/sort.
let lightboxEl = null;
let lightboxIndex = 0;
let lightboxTouchX = null;
let lightboxTouchY = null;

function ensureLightbox() {
  if (lightboxEl) return lightboxEl;
  const el = document.createElement('div');
  el.className = 'binder-lightbox';
  el.hidden = true;
  el.innerHTML = `
    <button class="bl-close" type="button" aria-label="Close">✕</button>
    <button class="bl-nav bl-prev" type="button" aria-label="Previous card">‹</button>
    <div class="bl-stage">
      <div class="bl-imgwrap"></div>
      <div class="bl-info">
        <div class="bl-name"></div>
        <div class="bl-meta"><span class="bl-code"></span><span class="bl-qty"></span></div>
        <div class="bl-pills"></div>
        <div class="bl-actions"></div>
      </div>
    </div>
    <button class="bl-nav bl-next" type="button" aria-label="Next card">›</button>
    <div class="bl-counter"></div>`;
  document.body.appendChild(el);

  el.querySelector('.bl-close').addEventListener('click', closeLightbox);
  el.querySelector('.bl-prev').addEventListener('click', e => { e.stopPropagation(); lightboxStep(-1); });
  el.querySelector('.bl-next').addEventListener('click', e => { e.stopPropagation(); lightboxStep(1); });
  // Tap the dimmed backdrop (only) to dismiss.
  el.addEventListener('click', e => { if (e.target === el) closeLightbox(); });

  // Horizontal swipe → flip a card; vertical swipes are ignored (page scroll).
  el.addEventListener('touchstart', e => {
    const t = e.changedTouches[0];
    lightboxTouchX = t.clientX; lightboxTouchY = t.clientY;
  }, { passive: true });
  el.addEventListener('touchend', e => {
    if (lightboxTouchX == null) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - lightboxTouchX;
    const dy = t.clientY - lightboxTouchY;
    lightboxTouchX = lightboxTouchY = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy)) lightboxStep(dx < 0 ? 1 : -1);
  }, { passive: true });

  return (lightboxEl = el);
}

// One keydown listener for the lightbox (arrows to flip, Esc to close).
document.addEventListener('keydown', e => {
  if (!lightboxEl || lightboxEl.hidden) return;
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === 'ArrowLeft') lightboxStep(-1);
  else if (e.key === 'ArrowRight') lightboxStep(1);
});

function openLightbox(index) {
  if (!state.currentListings.length) return;
  ensureLightbox();
  lightboxIndex = Math.max(0, Math.min(index, state.currentListings.length - 1));
  renderLightbox();
  lightboxEl.hidden = false;
  document.body.style.overflow = 'hidden';   // freeze background scroll
}

function closeLightbox() {
  if (!lightboxEl) return;
  lightboxEl.hidden = true;
  document.body.style.overflow = '';
}

function lightboxStep(dir) {
  const next = lightboxIndex + dir;
  if (next < 0 || next >= state.currentListings.length) return;
  lightboxIndex = next;
  renderLightbox();
}

function renderLightbox() {
  const el = lightboxEl;
  if (!el) return;
  const total = state.currentListings.length;
  if (!total) { closeLightbox(); return; }
  if (lightboxIndex > total - 1) lightboxIndex = total - 1;
  const l = state.currentListings[lightboxIndex];
  const c = l.cards || {};
  const url = c.image_url_lg || c.image_url || '';

  const blImgWrap = el.querySelector('.bl-imgwrap');
  blImgWrap.innerHTML = url
    ? `<img class="bl-img" referrerpolicy="no-referrer" alt="${escapeHtml(c.name || l.card_code)}" src="${escapeHtml(url)}" data-fallback="bl-placeholder" data-code="${escapeHtml(l.card_code)}">`
    : `<div class="bl-placeholder">${escapeHtml(l.card_code)}</div>`;
  wireImgFallbacks(blImgWrap);

  el.querySelector('.bl-name').textContent = c.name || l.card_code;
  el.querySelector('.bl-code').textContent = l.card_code;
  el.querySelector('.bl-qty').textContent  = `×${l.quantity}`;

  const deck = l.deck_id ? state.decksById[l.deck_id] : null;
  const isWishlist = state.binderFlair === 'wishlist';
  let pills = '';
  if (l.listing_type && !deck && !isWishlist) {
    pills += `<span class="listing-pill listing-${l.listing_type}">${listingLabel(l.listing_type)}</span>`;
  }
  if (deck) pills += `<span class="deck-pill">🃏 ${escapeHtml(deck.name || 'deck')}</span>`;
  el.querySelector('.bl-pills').innerHTML = pills;

  // Wishlist owners get the same "GOT IT!" action the mobile expanded view has.
  // Mirrors the tile's received-btn: sparkle, close the lightbox, then mark
  // received (which decrements/removes the row and re-renders the grid).
  const actions = el.querySelector('.bl-actions');
  if (isWishlist && state.lastShowEditControls) {
    actions.innerHTML = `<button class="received-btn bl-gotit" type="button" title="Mark this card as collected">GOT IT!</button>`;
    actions.querySelector('.bl-gotit').addEventListener('click', e => {
      e.stopPropagation();
      burstSparkles(e.clientX, e.clientY);
      closeLightbox();
      markReceived(l);
    });
  } else {
    actions.innerHTML = '';
  }

  el.querySelector('.bl-prev').disabled = lightboxIndex <= 0;
  el.querySelector('.bl-next').disabled = lightboxIndex >= total - 1;
  el.querySelector('.bl-counter').textContent = `${lightboxIndex + 1} / ${total}`;
}

function buildListingTile(l) {
  const c = l.cards || {};
  const tile = document.createElement('div');
  tile.className = 'card-tile';
  if (state.sleeveImageUrl) {
    tile.classList.add('has-sleeve');
    tile.style.backgroundImage = `url(${state.sleeveImageUrl})`;
  }
  const deck = l.deck_id ? state.decksById[l.deck_id] : null;
  const isWishlist = state.binderFlair === 'wishlist';
  // Wishlist cards have no trade/sell status — never show the listing pill.
  const typePill = (l.listing_type && !deck && !isWishlist)
    ? `<span class="listing-pill listing-${l.listing_type}">${listingLabel(l.listing_type)}</span>`
    : '';
  const deckPill = deck
    ? `<span class="deck-pill" title="Needed for your &quot;${escapeHtml(deck.name || 'deck')}&quot; deck">🃏 ${escapeHtml(deck.name || 'deck')}</span>`
    : '';
  const qtyBadge = `<span class="card-qty-badge${deck ? ' card-qty-badge-need' : ''}">×${l.quantity}</span>`;
  // Owner action on a wishlist binder: mark a card as received (got it).
  const receivedBtn = (isWishlist && state.lastShowEditControls)
    ? `<button class="received-btn" data-id="${l.id}" title="Mark this card as collected">GOT IT!</button>`
    : '';
  const notesHtml = '';
  const editControls = state.lastShowEditControls ? `
    <div class="card-edit-controls">
      <label>Qty <input type="number" min="1" value="${l.quantity}" data-id="${l.id}" class="qty-input form-input small"></label>
      ${isWishlist ? '' : `<select class="type-select form-input small" data-id="${l.id}">
        ${(window.LISTING_TYPES || []).map(t =>
          `<option value="${t.value}" ${l.listing_type === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
      </select>`}
      <button class="btn small delete-btn" data-id="${l.id}">Remove</button>
    </div>` : '';
  tile.innerHTML = `
    <div class="card-tile-img">
      ${c.image_url ? `<img referrerpolicy="no-referrer" src="${escapeHtml(c.image_url)}" alt="${escapeHtml(c.name || l.card_code)}" data-fallback="card-placeholder" data-code="${escapeHtml(l.card_code)}">` : `<div class="card-placeholder">${escapeHtml(l.card_code)}</div>`}
    </div>
    <div class="card-tile-body">
      <div class="card-tile-meta">
        <span class="card-tile-code">${escapeHtml(l.card_code)}</span>
        ${qtyBadge}
      </div>
      ${typePill}
      ${isWishlist ? `<div class="deck-pill-slot">${deckPill}</div>` : deckPill}
      ${receivedBtn}
      ${notesHtml}
      ${editControls}
    </div>`;
  wireImgFallbacks(tile);
  return tile;
}

// Populate + reveal the "For deck" filter on wishlist binders (owner-only).
// Options: All cards / Deck cards only / Manual only / one per deck present.
let deckFilterWired = false;
function renderDeckFilter() {
  const group = document.getElementById('deckFilterGroup');
  const sel   = document.getElementById('cbDeck');
  if (!group || !sel) return;

  const deckIds = [...new Set(state.allListings.map(l => l.deck_id).filter(Boolean))]
    .filter(id => state.decksById[id]);
  if (!state.isOwner || state.binderFlair !== 'wishlist' || !deckIds.length) {
    group.style.display = 'none';
    sel.value = '';
    return;
  }

  const prev = sel.value;
  let html = '<option value="">All cards</option>'
    + '<option value="__deck__">Deck cards only</option>'
    + '<option value="__manual__">Manual only</option>';
  deckIds
    .map(id => state.decksById[id])
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    .forEach(d => { html += `<option value="${d.id}">${escapeHtml(d.name || 'Deck')}</option>`; });
  sel.innerHTML = html;
  // Restore the prior selection if it still exists in the new option set.
  sel.value = [...sel.options].some(o => o.value === prev) ? prev : '';

  if (!deckFilterWired) {
    sel.addEventListener('change', filterBinderListings);
    deckFilterWired = true;
  }
  group.style.display = '';
}

export function filterBinderListings() {
  // Bypass filters entirely when "Show all (ignore filters)" toggle is on
  const exclude = document.getElementById('cbExcludeBinder');
  if (exclude && exclude.checked) {
    renderListings(state.allListings);
    return;
  }

  const deckSel = (document.getElementById('cbDeck') || {}).value || '';

  const name   = document.getElementById('cbName').value.trim().toLowerCase();
  const series = document.getElementById('cbSeries').value;
  const ctype  = document.getElementById('cbType').value;
  const rarity = document.getElementById('cbRarity').value;

  // OPTCG-only filter values; hidden inputs read as ''
  const color     = document.getElementById('cbColor').value;
  const cost      = document.getElementById('cbCost').value;
  const attribute = document.getElementById('cbAttribute').value;
  // Pokémon-only filter values; hidden inputs read as ''
  const supertype = document.getElementById('cbSupertype').value;
  const subtype   = document.getElementById('cbSubtype').value;
  const hpMin     = document.getElementById('cbHp').value;

  const filtered = state.allListings.filter(l => {
    const c = l.cards || {};
    if (deckSel === '__deck__'   && !l.deck_id) return false;
    if (deckSel === '__manual__' &&  l.deck_id) return false;
    if (deckSel && deckSel !== '__deck__' && deckSel !== '__manual__' && l.deck_id !== deckSel) return false;
    if (name) {
      const haystack = `${(c.name || '').toLowerCase()} ${l.card_code.toLowerCase()}`;
      if (!haystack.includes(name)) return false;
    }
    if (series && c.series !== series) return false;
    if (rarity && c.rarity !== rarity) return false;

    if (state.binderCategory === 'pokemon') {
      // `type` here means elemental type, stored as text[] in `types`.
      if (ctype && !(Array.isArray(c.types) && c.types.includes(ctype))) return false;
      if (supertype && c.supertype !== supertype) return false;
      if (subtype && !(Array.isArray(c.subtypes) && c.subtypes.includes(subtype))) return false;
      if (hpMin && (c.hp == null || c.hp < parseInt(hpMin, 10))) return false;
    } else if (state.binderCategory === 'cyberpunk') {
      const tag = document.getElementById('cbTag').value;
      const ram = document.getElementById('cbRam').value;
      if (color && c.color !== color) return false;
      if (ctype && c.type !== ctype) return false;
      if (cost !== '' && c.cost !== parseInt(cost, 10)) return false;
      if (tag && !(Array.isArray(c.types) && c.types.includes(tag))) return false;  // classifications
      if (ram !== '' && c.ram !== parseInt(ram, 10)) return false;
    } else {
      if (color && !((c.color || '').includes(color))) return false;
      if (ctype && c.type !== ctype) return false;
      if (cost !== '' && c.cost !== undefined && c.cost !== parseInt(cost, 10)) return false;
      if (attribute && c.attribute !== attribute) return false;
    }
    return true;
  });
  renderListings(filtered);
}

function wireEditHandlers() {
  const grid = document.getElementById('cardGrid');
  grid.querySelectorAll('.qty-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const id = inp.dataset.id, q = parseInt(inp.value, 10);
      if (!q || q < 1) return;
      if (state.DEMO) { const l = state.allListings.find(x => x.id === id); if (l) l.quantity = q; return; }
      await window.sb.from('listings').update({ quantity: q }).eq('id', id);
    });
  });
  grid.querySelectorAll('.type-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      if (state.DEMO) { const l = state.allListings.find(x => x.id === sel.dataset.id); if (l) l.listing_type = sel.value; return; }
      await window.sb.from('listings').update({ listing_type: sel.value }).eq('id', sel.dataset.id);
    });
  });
  grid.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Remove this listing?')) return;
      if (state.DEMO) { state.allListings = state.allListings.filter(l => l.id !== btn.dataset.id); loadListings(true, true); return; }
      await window.sb.from('listings').delete().eq('id', btn.dataset.id);
      loadListings(true, true);
    });
  });
  grid.querySelectorAll('.received-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      burstSparkles(e.clientX, e.clientY);
      const l = state.allListings.find(x => x.id === btn.dataset.id);
      if (l) markReceived(l);
    });
  });
}

// Celebratory star + confetti burst at a point — fired when a card is "Got it".
function burstSparkles(x, y) {
  const colors = ['#d8b751', '#ffd964', '#4d9de0', '#7ec96a', '#e06c9f', '#ffffff'];
  const count = 16;
  for (let i = 0; i < count; i++) {
    const p = document.createElement('span');
    const isStar = Math.random() < 0.5;
    p.className = isStar ? 'spark spark-star' : 'spark spark-confetti';
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const dist = 42 + Math.random() * 58;
    const color = colors[Math.floor(Math.random() * colors.length)];
    p.style.left = x + 'px';
    p.style.top = y + 'px';
    if (isStar) { p.textContent = '★'; p.style.color = color; }
    else { p.style.background = color; }
    p.style.setProperty('--dx', `${Math.cos(angle) * dist}px`);
    p.style.setProperty('--dy', `${Math.sin(angle) * dist - 12}px`); // slight upward kick
    p.style.setProperty('--rot', `${Math.random() * 720 - 360}deg`);
    p.style.animationDelay = `${Math.random() * 50}ms`;
    document.body.appendChild(p);
    p.addEventListener('animationend', () => p.remove());
  }
}

// Mark a wishlist card as received (you got a copy). For a deck-pointed card,
// confirm adding the copy to that deck as owned — the deck_cards trigger then
// shrinks/removes the wishlist row automatically. For a manual wishlist card,
// drop one copy (delete the row when it hits zero).
let receiveQueue = Promise.resolve(); // serializes "Got it" DB writes so clicks don't race

function markReceived(l) {
  // No confirm() here on purpose: a per-click native dialog gets suppressed by
  // the browser after a few rapid clicks ("prevent additional dialogs"), which
  // silently dropped clicks. The deck pill already signals deck-linked cards,
  // and the sparkle + dropping count are the feedback.
  // Optimistic local update — instant feedback, no full reload between clicks:
  // one copy collected ⇒ decrement the wishlist row, remove it at zero.
  const idx = state.allListings.findIndex(x => x.id === l.id);
  if (idx >= 0) {
    const row = state.allListings[idx];
    if ((row.quantity || 1) > 1) state.allListings[idx] = { ...row, quantity: row.quantity - 1 };
    else state.allListings.splice(idx, 1);
  }
  state.pendingKeepPage = state.currentPage; // stay on the page the user is viewing
  filterBinderListings();        // re-render the current view from the updated cache

  // Persist in the background, serialized so concurrent clicks can't read a
  // stale owned/quantity and lose increments.
  receiveQueue = receiveQueue
    .then(() => persistReceive(l))
    .catch(err => console.warn('mark-collected failed:', err && err.message));
}

async function persistReceive(l) {
  if (state.DEMO) return;
  if (l.deck_id) {
    // Add one owned copy to the deck; its trigger shrinks/removes this row.
    const { data: dc } = await window.sb.from('deck_cards')
      .select('quantity, owned').eq('deck_id', l.deck_id).eq('card_code', l.card_code).maybeSingle();
    if (dc) {
      const newOwned = Math.min(dc.quantity, (dc.owned || 0) + 1);
      await window.sb.from('deck_cards').update({ owned: newOwned })
        .eq('deck_id', l.deck_id).eq('card_code', l.card_code);
    } else {
      await window.sb.from('listings').delete().eq('id', l.id);
    }
  } else {
    // Re-read the live quantity so chained clicks decrement correctly.
    const { data: cur } = await window.sb.from('listings').select('quantity').eq('id', l.id).maybeSingle();
    if (!cur) return; // already gone
    if ((cur.quantity || 1) > 1) {
      await window.sb.from('listings').update({ quantity: cur.quantity - 1 }).eq('id', l.id);
    } else {
      await window.sb.from('listings').delete().eq('id', l.id);
    }
  }
}

// ---- Shared binders: manage co-owners (couples) ----
function setupCollab() {
  const el = document.getElementById('binderCollab');
  if (!el) return;
  if (!state.canEdit) { el.style.display = 'none'; return; }
  // Only trade binders support a co-editing partner — wishlist/flex/lgs can't
  // be shared. (Collaborators only ever exist on trade binders, so the
  // collaborator-view branch below is unaffected.)
  if (state.isOwner && state.binderFlair !== 'trade') { el.style.display = 'none'; return; }
  el.style.display = '';

  const refresh = async () => {
    const { data: collabs } = await window.sb
      .rpc('binder_collaborators_list', { p_binder_id: state.currentBinderId });
    if (state.isOwner) {
      const list = collabs || [];
      const chips = list.map(c =>
        `<span class="collab-chip">${escapeHtml(c.display_name || 'partner')}<button class="collab-remove" data-uid="${c.user_id}" title="Remove" aria-label="Remove">×</button></span>`).join('');
      // One partner per binder — only offer "Add" when there isn't one yet.
      const addBtn = list.length === 0
        ? `<button class="btn small" id="collabAddBtn">+ Add partner</button>` : '';
      el.innerHTML = `
        <div class="collab-row">
          <span class="collab-label">Share with</span>
          ${chips}
          ${addBtn}
        </div>
        <p class="auth-error" id="collabError"></p>`;
      const addEl = el.querySelector('#collabAddBtn');
      if (addEl) addEl.addEventListener('click', addCollab);
      el.querySelectorAll('.collab-remove').forEach(b =>
        b.addEventListener('click', () => removeCollab(b.dataset.uid)));
    } else {
      // Collaborator view — read-only note that this is a shared binder.
      el.innerHTML = `<div class="collab-row"><span class="collab-label">Shared binder</span> <span class="collab-none">you're a co-editor</span></div>`;
    }
  };

  const addCollab = async () => {
    const errEl = document.getElementById('collabError');
    if (errEl) { errEl.textContent = ''; errEl.style.color = ''; }
    const name = prompt("Enter your partner's display name to share this binder with them:");
    if (!name || !name.trim()) return;
    const { error } = await window.sb.rpc('share_binder', { p_binder_id: state.currentBinderId, p_display_name: name.trim() });
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    await refresh();
    const e2 = document.getElementById('collabError');
    if (e2) { e2.style.color = '#7ec96a'; e2.textContent = `Invite sent to ${name.trim()} — they'll get a notification to accept.`; }
  };
  const removeCollab = async (uid) => {
    if (!confirm('Remove this person from the binder?')) return;
    const { error } = await window.sb.rpc('unshare_binder', { p_binder_id: state.currentBinderId, p_user_id: uid });
    const errEl = document.getElementById('collabError');
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    refresh();
  };

  refresh();
}

// Live-sync: when a co-editor changes a card, refresh this view. Best-effort —
// requires Realtime to be enabled for public.listings in Supabase; if it's
// off, both can still edit and see changes on manual refresh.
let realtimeChannel = null;
function subscribeBinderRealtime() {
  if (!window.sb || !window.sb.channel || !state.currentBinderId) return;
  if (realtimeChannel) { try { window.sb.removeChannel(realtimeChannel); } catch (e) {} realtimeChannel = null; }
  realtimeChannel = window.sb
    .channel('binder-' + state.currentBinderId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'listings', filter: 'binder_id=eq.' + state.currentBinderId },
      () => {
        if (state.aestheticsMode) return; // don't yank the grid out from under a drag
        state.pendingKeepPage = state.currentPage;
        loadListings(state.canEdit, state.lastIsLoggedIn);
      })
    .subscribe();
}

function setupShare(profile) {
  const btn       = document.getElementById('shareBtn');
  const popover   = document.getElementById('sharePopover');
  const urlInput  = document.getElementById('shareUrl');
  const copyBtn   = document.getElementById('shareCopyBtn');
  const feedback  = document.getElementById('shareFeedback');
  if (!btn) return;

  const shareUrl = `${location.origin}/binder.html?id=${state.currentBinderId}`;
  urlInput.value = shareUrl;

  btn.style.display = '';

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = popover.style.display === 'none';
    popover.style.display = opening ? '' : 'none';
    if (opening) {
      urlInput.focus();
      urlInput.select();
    }
  });
  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target) && !btn.contains(e.target)) popover.style.display = 'none';
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      feedback.textContent = 'Copied!';
    } catch (err) {
      urlInput.select();
      document.execCommand && document.execCommand('copy');
      feedback.textContent = 'Copied (fallback).';
    }
    setTimeout(() => { feedback.textContent = ''; }, 2000);
  });
}

if (window.SB_READY && !NO_BINDER) init();
