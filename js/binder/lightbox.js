// Card lightbox (tap to expand + swipe/arrow through the binder), incl. its
// document-level keydown listener. Moved verbatim from the old
// js/binder-view.js; only the export keyword and the imports were added.

import { state } from './state.js';
import { escapeHtml, listingLabel, wireImgFallbacks } from './helpers.js';
import { burstSparkles, markReceived } from './index.js';

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

export function openLightbox(index) {
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
