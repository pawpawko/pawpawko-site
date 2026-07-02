import { state } from './state.js';
import { GAME, $, esc, capFor, byCostThenCode } from './helpers.js';
import { cardZoom, localSetRow, localRemoveRow, renderDeckLocal, queueDeckWrite, readDeckCard, setCardAbsolute } from './index.js';

// ---------------- bench (local-only staging) + drag-and-drop ----------------
// The bench holds extra candidate cards that are NOT in the 50. It lives per
// deck in localStorage only, so server-side validity / wishlist sync /
// Cost-to-Finish (all keyed off the 50 in deck_cards) are untouched. Drag a
// bench card onto a deck card to swap, or onto the deck/bench to move across.
let dragSrc = null;        // { zone:'deck'|'bench', code } while dragging

function benchKey(id) { return `pawpaw:deckBench:${id}`; }
export function saveBench() { if (state.DEMO) return; try { localStorage.setItem(benchKey(state.deck.id), JSON.stringify(state.bench)); } catch (e) {} }
function readBenchLocal() {
  try {
    const a = JSON.parse(localStorage.getItem(benchKey(state.deck.id)) || '[]');
    return Array.isArray(a) ? a.filter(x => x && x.code && x.qty > 0).map(x => ({ code: x.code, qty: x.qty, owned: Math.max(0, Math.min(x.qty, x.owned || 0)) })) : [];
  } catch (e) { return []; }
}
export async function loadBench() {
  state.bench = readBenchLocal();
  const need = state.bench.map(b => b.code).filter(c => !state.cardInfo[c]);
  if (need.length) {
    const { data } = await window.sb.from('cards')
      .select('card_code,name,color,cost,type,image_url,image_url_lg,counter,effect_text,types')
      .eq('game', GAME).in('card_code', need);
    (data || []).forEach(c => { state.cardInfo[c.card_code] = c; });
  }
  renderBench();
}
function updateBenchBtn() {
  const btn = $('edBenchBtn');
  if (!btn) return;
  const sec = $('edBenchSection');
  const open = sec && sec.style.display !== 'none';
  btn.textContent = `Bench ${open ? '▴' : '▾'}`; // arrow reflects open/closed
}
export function benchAdd(code, qty, owned) {
  const o = Math.max(0, Math.min(qty, owned || 0));
  const e = state.bench.find(x => x.code === code);
  if (e) { e.qty += qty; e.owned = Math.min(e.qty, (e.owned || 0) + o); }
  else state.bench.push({ code, qty, owned: o });
  saveBench(); renderBench();
}
export function benchRemove(code) {
  const i = state.bench.findIndex(x => x.code === code);
  if (i >= 0) state.bench.splice(i, 1);
  saveBench(); renderBench();
}
export function toggleBench() {
  const sec = $('edBenchSection');
  // It's hidden only when display is explicitly 'none' (when shown it's '').
  // The old `!sec.style.display` test treated the shown '' as "hide me too",
  // so a second click never closed it.
  const show = sec.style.display === 'none';
  sec.style.display = show ? '' : 'none';
  $('edBenchBtn').setAttribute('aria-expanded', show ? 'true' : 'false');
  updateBenchBtn(); // flip the arrow to match the new state
}
// Dock the bench beside the deck (right side) vs. below it. Opens the bench
// when docking to the side so it's actually visible.
export function toggleBenchSide() {
  const main = $('edDeckMain');
  if (!main) return;
  const on = !main.classList.contains('bench-side');
  main.classList.toggle('bench-side', on);
  const btn = $('edBenchSideBtn');
  if (btn) {
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.title = on ? 'Dock bench below' : 'Dock bench to the side';
    // Icon (dock-right vs dock-bottom) + pressed styling are CSS-driven off aria-pressed.
  }
  if (on && $('edBenchSection').style.display === 'none') toggleBench();
}

// Insert / raise / remove a deck card to an exact quantity, creating or
// deleting the deck_cards row as needed (new rows start owned=0). Optimistic +
// queued, like the other deck-card writers.
function setDeckQtyAbsolute(code, target) {
  const cap = capFor(code);
  if (cap !== null) target = Math.min(target, cap);
  target = Math.max(0, target);
  const existing = state.deckCards.find(r => r.card_code === code);
  if (target <= 0) localRemoveRow(code);
  else if (existing) localSetRow(code, { quantity: target, owned: Math.min(existing.owned, target) });
  else { state.deckCards.push({ card_code: code, quantity: target, owned: 0 }); renderDeckLocal(); }
  queueDeckWrite(async () => {
    const cur = await readDeckCard(code);
    if (target <= 0) {
      if (cur) { const { error } = await window.sb.from('deck_cards').delete().eq('deck_id', state.deck.id).eq('card_code', code); if (error) throw error; }
    } else if (cur) {
      const { error } = await window.sb.from('deck_cards').update({ quantity: target, owned: Math.min(cur.owned, target) }).eq('deck_id', state.deck.id).eq('card_code', code);
      if (error) throw error;
    } else {
      const { error } = await window.sb.from('deck_cards').insert({ deck_id: state.deck.id, card_code: code, quantity: target, owned: 0 });
      if (error) throw error;
    }
  });
}

function moveDeckToBench(code) {
  const row = state.deckCards.find(r => r.card_code === code);
  if (!row) return;
  $('edError').textContent = '';
  benchAdd(code, row.quantity, row.owned);
  setDeckQtyAbsolute(code, 0);
}
function addBenchToDeck(code) {
  const b = state.bench.find(x => x.code === code);
  if (!b) return;
  const cap = capFor(code);
  const existing = state.deckCards.find(r => r.card_code === code) || {};
  const cur = existing.quantity || 0;
  const curOwned = existing.owned || 0;
  const benchedOwned = b.owned || 0;
  let target = cur + b.qty;
  if (cap !== null) target = Math.min(target, cap);
  if (target <= cur) { $('edError').textContent = `Already at the max ${cap} cop${cap === 1 ? 'y' : 'ies'} of ${code}.`; return; }
  benchRemove(code);
  setDeckQtyAbsolute(code, target);
  // Restore the benched owned count so a returning owned card isn't reset to 0.
  const newOwned = Math.min(target, curOwned + benchedOwned);
  if (newOwned > 0) setCardAbsolute(code, 'owned', newOwned);
}
function swapBenchIntoDeck(deckCode, benchCode) {
  if (deckCode === benchCode) return;
  const a = state.deckCards.find(r => r.card_code === deckCode);
  const b = state.bench.find(x => x.code === benchCode);
  if (!a || !b) return;
  $('edError').textContent = '';
  const qa = a.quantity;
  const ownedA = a.owned;
  const benchedBOwned = b.owned || 0;
  const capB = capFor(benchCode);
  const curB = (state.deckCards.find(r => r.card_code === benchCode) || {}).quantity || 0;
  const curBOwned = (state.deckCards.find(r => r.card_code === benchCode) || {}).owned || 0;
  let targetB = curB + qa;
  if (capB !== null) targetB = Math.min(targetB, capB);
  benchRemove(benchCode);
  benchAdd(deckCode, qa, ownedA);
  setDeckQtyAbsolute(deckCode, 0);
  setDeckQtyAbsolute(benchCode, targetB);
  const newBOwned = Math.min(targetB, curBOwned + benchedBOwned);
  if (newBOwned > 0) setCardAbsolute(benchCode, 'owned', newBOwned);
}

// Drag plumbing shared by deck + bench tiles. The card image is the drag
// handle (keeps the grab off the qty steppers); tiles/containers are targets.
function startDrag(e, zone, code, tile) {
  dragSrc = { zone, code };
  if (tile) tile.classList.add('dragging');
  try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', code); } catch (err) {}
}
function endDrag() {
  dragSrc = null;
  document.querySelectorAll('.deck-card-tile.dragging').forEach(t => t.classList.remove('dragging'));
  document.querySelectorAll('.deck-card-tile.drop-target').forEach(t => t.classList.remove('drop-target'));
}
export function makeDragHandle(tile, zone, code) {
  const img = tile.querySelector('img');
  if (!img) return;
  img.draggable = true;
  img.addEventListener('dragstart', e => startDrag(e, zone, code, tile));
  img.addEventListener('dragend', endDrag);
}
export function wireDeckDropTarget(tile, deckCode) {
  tile.addEventListener('dragover', e => { if (dragSrc && dragSrc.zone === 'bench') { e.preventDefault(); tile.classList.add('drop-target'); } });
  tile.addEventListener('dragleave', () => tile.classList.remove('drop-target'));
  tile.addEventListener('drop', e => {
    if (!dragSrc || dragSrc.zone !== 'bench') return;
    e.preventDefault(); e.stopPropagation();
    const bc = dragSrc.code;
    tile.classList.remove('drop-target');
    swapBenchIntoDeck(deckCode, bc);
  });
}
// Container drops, wired once: bench card onto deck empty space → add to deck;
// deck card onto the bench → bench it.
export function wireDropZones() {
  const dg = $('edDeckGrid'), bg = $('edBenchGrid');
  if (dg) {
    dg.addEventListener('dragover', e => { if (dragSrc && dragSrc.zone === 'bench') e.preventDefault(); });
    dg.addEventListener('drop', e => { if (dragSrc && dragSrc.zone === 'bench') { e.preventDefault(); addBenchToDeck(dragSrc.code); } });
  }
  if (bg) {
    bg.addEventListener('dragover', e => { if (dragSrc && dragSrc.zone === 'deck') e.preventDefault(); });
    bg.addEventListener('drop', e => { if (dragSrc && dragSrc.zone === 'deck') { e.preventDefault(); moveDeckToBench(dragSrc.code); } });
  }
}

// The single trade binder for this game (one per game), created on demand —
// mirrors how the wishlist binder auto-creates. Returns its id or null.
async function getOrCreateTradeBinder() {
  if (!state.user) return null;
  const { data: existing } = await window.sb.from('binders')
    .select('id').eq('user_id', state.user.id).eq('category', GAME).eq('flair', 'trade').limit(1);
  if (existing && existing.length) return existing[0].id;
  const { data: created, error } = await window.sb.from('binders')
    .insert({ user_id: state.user.id, name: 'Trade', category: GAME, flair: 'trade' })
    .select('id').single();
  if (error) { console.warn('create trade binder failed:', error.message); return null; }
  return created.id;
}
// Send a benched card's OWNED copies to the trade binder as a 'trade' listing
// (increment if already listed), then drop it from the bench. Not-owned copies
// have no trade value, so only `owned` is added.
async function addBenchedToTradeBinder(code) {
  if (state.DEMO) return;
  const b = state.bench.find(x => x.code === code);
  if (!b || !(b.owned > 0)) return;
  const qty = b.owned;
  const binderId = await getOrCreateTradeBinder();
  if (!binderId) { $('edError').textContent = 'Could not find your trade binder.'; return; }
  const { data: existing } = await window.sb.from('listings')
    .select('id, quantity').eq('binder_id', binderId).eq('card_code', code).limit(1);
  if (existing && existing.length) {
    const { error } = await window.sb.from('listings')
      .update({ quantity: (existing[0].quantity || 0) + qty }).eq('id', existing[0].id);
    if (error) { $('edError').textContent = error.message; return; }
  } else {
    const { error } = await window.sb.from('listings')
      .insert({ binder_id: binderId, card_code: code, quantity: qty, listing_type: 'trade' });
    if (error) { $('edError').textContent = error.message; return; }
  }
  // Remove only the OWNED copies from the bench; any not-owned copies stay
  // (they have no trade value — they can only be deleted).
  const cur = state.bench.find(x => x.code === code);
  if (cur) {
    const rem = cur.qty - qty;
    if (rem <= 0) benchRemove(code);
    else { cur.qty = rem; cur.owned = Math.max(0, cur.owned - qty); saveBench(); renderBench(); }
  }
}

export function renderBench() {
  updateBenchBtn();
  const grid = $('edBenchGrid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!state.bench.length) {
    grid.innerHTML = '<p class="deck-bench-empty">Cards you remove (− or drag here) land here. Owned copies can go to your trade binder; others can be deleted. Cards added past 50 land here too.</p>';
    return;
  }
  state.bench.slice().sort((x, y) => byCostThenCode({ card_code: x.code }, { card_code: y.code })).forEach(b => {
    const c = state.cardInfo[b.code] || {};
    const owned = b.owned || 0;
    const notOwned = b.qty - owned;
    // Distinctly flag each benched card as owned / not-owned / mixed.
    const status = owned <= 0 ? 'unowned' : (owned >= b.qty ? 'owned' : 'mixed');
    const statusText = status === 'owned' ? 'OWNED'
                     : status === 'unowned' ? 'NOT OWNED'
                     : `✓${owned} · ○${notOwned}`;
    const tile = document.createElement('div');
    tile.className = `deck-card-tile bench-tile bench-${status}`;
    tile.title = `${c.name || b.code} — benched ×${b.qty} · ${owned} owned, ${notOwned} not owned`;
    // Owned copies can be sent to the trade binder; not-owned can only be deleted.
    const tradeBtn = owned > 0
      ? `<button class="card-act bench-trade" aria-label="Add owned to trade binder" title="Add ${owned} owned to your trade binder">⇄</button>`
      : '';
    tile.innerHTML = `
      <img src="${esc(c.image_url || '')}" alt="${esc(c.name || b.code)}">
      <span class="bench-status bench-status-${status}">${statusText}</span>
      <div class="card-acts">
        ${tradeBtn}
        <button class="card-act bench-up" aria-label="Move to deck" title="Move to deck">▲</button>
        <button class="card-act bench-del" aria-label="Delete from bench" title="Delete from bench">✕</button>
      </div>
      <span class="qty-badge"><span class="qty-total">${b.qty > 4 ? 'X' : 'x' + b.qty}</span></span>`;
    makeDragHandle(tile, 'bench', b.code);
    const tradeEl = tile.querySelector('.bench-trade');
    if (tradeEl) tradeEl.addEventListener('click', e => { e.stopPropagation(); addBenchedToTradeBinder(b.code); });
    tile.querySelector('.bench-up').addEventListener('click', e => { e.stopPropagation(); addBenchToDeck(b.code); });
    tile.querySelector('.bench-del').addEventListener('click', e => { e.stopPropagation(); benchRemove(b.code); });
    // Tap the card (not a button) to magnify — there you can mark copies owned.
    tile.addEventListener('click', () => cardZoom.show(c, { zone: 'bench' }));
    grid.appendChild(tile);
  });
}
