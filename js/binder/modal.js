// Add-to-binder modal: opened from a card-browser tile; saves/removes
// listings (DEMO-gated in the signed-out demo). Moved verbatim from the
// old js/binder-view.js; only the imports were added (openAddListing and
// wireAddListingModal kept the export keywords they already carried).

import { state } from './state.js';
import { loadCards } from './browser.js';
import { loadListings } from './index.js';

// ------------------- Add-to-binder modal -------------------
let activeCard = null;

export function wireAddListingModal() {
  document.getElementById('addListingClose').addEventListener('click', closeAddListing);
  document.getElementById('alSave').addEventListener('click', saveListing);
  document.getElementById('alRemove').addEventListener('click', removeAllListingsForCard);
}

export async function openAddListing(card) {
  activeCard = card;
  const alImg = document.getElementById('alCardImg');
  alImg.referrerPolicy = 'no-referrer';
  alImg.onerror = () => { alImg.style.visibility = 'hidden'; };
  alImg.onload = () => { alImg.style.visibility = 'visible'; };
  alImg.src = card.image_url || '';
  document.getElementById('alCardName').textContent = card.name || card.card_code;
  document.getElementById('alCardCode').textContent = card.card_code;
  document.getElementById('alQty').value = 1;
  document.getElementById('alType').value = localStorage.getItem('pawpaw:lastListingType') || 'trade';
  // A wishlist is a "want" list — trade/sell/free status is meaningless, so
  // hide the listing-type picker (cards still save with an inert default).
  const alTypeRow = document.getElementById('alTypeRow');
  if (alTypeRow) alTypeRow.style.display = (state.binderFlair === 'wishlist') ? 'none' : '';
  document.getElementById('alError').textContent = '';
  document.getElementById('addListingModal').style.display = '';

  // If this card is already in the binder, surface a Remove option
  let existing;
  if (state.DEMO) { existing = state.allListings.filter(l => l.card_code === card.card_code); }
  else { const { data } = await window.sb.from('listings').select('id').eq('binder_id', state.currentBinderId).eq('card_code', card.card_code); existing = data; }
  const removeBtn = document.getElementById('alRemove');
  if (existing && existing.length > 0) {
    removeBtn.style.display = '';
    removeBtn.textContent = `Remove all from binder (${existing.length} listing${existing.length === 1 ? '' : 's'})`;
  } else {
    removeBtn.style.display = 'none';
  }
}
function closeAddListing() {
  document.getElementById('addListingModal').style.display = 'none';
  activeCard = null;
}

async function removeAllListingsForCard() {
  if (!activeCard) return;
  if (!confirm(`Remove all listings for ${activeCard.name || activeCard.card_code}?`)) return;
  if (state.DEMO) { state.allListings = state.allListings.filter(l => l.card_code !== activeCard.card_code); closeAddListing(); loadListings(true, true); loadCards(); return; }
  const { error } = await window.sb
    .from('listings').delete().eq('binder_id', state.currentBinderId).eq('card_code', activeCard.card_code);
  if (error) { document.getElementById('alError').textContent = error.message; return; }
  closeAddListing();
  loadListings(true, true);
  loadCards(); // refresh browse grid in case "only my binder" is on
}

let savingListing = false;
async function saveListing() {
  if (!activeCard || savingListing) return; // guard against double-submit
  const errEl = document.getElementById('alError');
  errEl.textContent = '';
  const qty   = parseInt(document.getElementById('alQty').value, 10);
  const isWishlist = state.binderFlair === 'wishlist';
  // Wishlist cards carry no trade/sell status — store an inert default.
  const ltype = isWishlist ? 'trade' : document.getElementById('alType').value;
  const notes = null;
  if (!qty || qty < 1) { errEl.textContent = 'Quantity must be at least 1'; return; }

  if (state.DEMO) {
    state.allListings.push({ id: 'demo-' + (++state.demoSeq), card_code: activeCard.card_code, quantity: qty,
      listing_type: ltype, notes, sort_order: state.allListings.length, created_at: new Date().toISOString(), cards: activeCard });
    state.pendingFocusCode = activeCard.card_code;
    closeAddListing();
    loadListings(true, true);
    return;
  }

  savingListing = true;
  const { error } = await window.sb.from('listings').insert({
    binder_id: state.currentBinderId,
    card_code: activeCard.card_code,
    quantity: qty,
    listing_type: ltype,
    notes,
  });
  savingListing = false;
  if (error) { errEl.textContent = error.message; return; }
  if (!isWishlist) localStorage.setItem('pawpaw:lastListingType', ltype);
  // Land on the page where the just-added card sits (new cards append at the
  // end) instead of snapping back to page 1.
  state.pendingFocusCode = activeCard.card_code;
  closeAddListing();
  loadListings(true, true);   // refresh main grid (still in edit mode)
}
