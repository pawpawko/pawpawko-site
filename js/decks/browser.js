import { state } from './state.js';
import { GAME, $, esc, isBase, capFor, standardLegal } from './helpers.js';
import { benchAdd } from './bench.js';
import { zoomBtnHTML, wireZoom, localSetRow, renderDeckLocal, queueDeckWrite, readDeckCard } from './index.js';

// ---------------- Add Cards overlay browser ----------------
// Full-screen scrollable overlay over the editor; binder-style filters
// minus Color (the leader locks it). Pool is leader-color matched, bans
// excluded; rotated cards only appear when the deck format is Eternal.

let cbReady = false; // filter dropdowns populated once

export function openBrowser() {
  $('cbOverlay').style.display = '';
  document.body.style.overflow = 'hidden'; // the overlay scrolls, not the page
  $('cbError').textContent = '';
  if (!cbReady) { cbReady = true; populateBrowserFilters(); }
  ensureTraitPool();
  loadBrowser();
  $('cbName').focus();
}

export function closeBrowser() {
  $('cbOverlay').style.display = 'none';
  document.body.style.overflow = '';
}

async function populateBrowserFilters() {
  const fill = (id, vals) => vals.forEach(v => {
    const o = document.createElement('option');
    o.value = String(v); o.textContent = String(v);
    $(id).appendChild(o);
  });
  fill('cbType', ['CHARACTER', 'EVENT', 'STAGE']);
  fill('cbCost', Array.from({ length: 11 }, (_, i) => i));
  fill('cbAbility', ['Blocker', 'Rush', 'Searcher']);
  fill('cbCounter', ['1000', '2000', 'None']);
}

// Trait typeahead: suggestions come from the CURRENT deck's legal pool
// (leader colors, format, bans), so a trait with zero addable cards never
// shows up. Cached per deck+format.
let traitPool = [], traitPoolKey = '';

export async function ensureTraitPool() {
  const key = `${state.deck.id}:${state.deck.format}`;
  if (traitPoolKey === key) return;
  traitPoolKey = key;
  traitPool = [];
  const colorOr = String(state.leaderCard.color || '').split('/').filter(Boolean)
    .map(c => `color.ilike.%${c}%`).join(',');
  const set = new Set();
  let from = 0;
  while (from < 20000) {
    let q = window.sb
      .from('cards').select('card_code,types')
      .eq('game', GAME).neq('type', 'LEADER').not('types', 'is', null)
      .range(from, from + 999);
    if (colorOr) q = q.or(colorOr);
    const { data, error } = await q;
    if (error || !data || data.length === 0) break;
    data.forEach(c => {
      if (isBase(c.card_code) && capFor(c.card_code) !== 0 &&
          (state.deck.format !== 'standard' || standardLegal(c.card_code))) {
        (c.types || []).forEach(t => set.add(t));
      }
    });
    if (data.length < 1000) break;
    from += 1000;
  }
  traitPool = [...set].sort((a, b) => a.localeCompare(b));
  renderTraitList();
}

export function renderTraitList() {
  const list = $('cbTraitList');
  const qv = $('cbTrait').value.trim().toLowerCase();
  const items = traitPool.filter(t => t.toLowerCase().includes(qv)).slice(0, 50);
  list.innerHTML = items.map(t => `<li data-t="${esc(t)}">${esc(t)}</li>`).join('');
  list.style.display = items.length && document.activeElement === $('cbTrait') ? '' : 'none';
}

// The query filter only applies on an exact trait (picked or fully typed).
function activeTrait() {
  const typed = $('cbTrait').value.trim();
  if (!typed) return null;
  return traitPool.find(t => t.toLowerCase() === typed.toLowerCase()) || null;
}

// Incremental browser: server pages of 300 feed a filtered list rendered
// 60 at a time; Load More keeps appending until everything is shown.
let cbRows = [], cbShown = 0, cbFrom = 0, cbDone = false, cbSeq = 0;
const CB_PAGE = 60, CB_FETCH = 300;

async function fetchBrowserChunk() {
  const colorOr = String(state.leaderCard.color || '').split('/').filter(Boolean)
    .map(c => `color.ilike.%${c}%`).join(',');
  let q = window.sb
    .from('cards')
    .select('card_code,name,color,cost,type,image_url,image_url_lg,counter,effect_text,types')
    .eq('game', GAME).neq('type', 'LEADER')
    .order('release_order', { ascending: false })
    .range(cbFrom, cbFrom + CB_FETCH - 1);
  const name = $('cbName').value.trim();
  if (name) q = q.or(`name.ilike.%${name}%,card_code.ilike.%${name}%`);
  if ($('cbType').value) q = q.eq('type', $('cbType').value);
  // Trait filter is inclusive: card's types array CONTAINS the pick.
  const trait = activeTrait();
  if (trait) q = q.contains('types', [trait]);
  if ($('cbCost').value !== '') q = q.eq('cost', Number($('cbCost').value));
  // Ability filters key off effect-text conventions: [Blocker] / [Rush]
  // keywords; searchers phrase as "look at … top of your deck … add … hand".
  const ability = $('cbAbility').value;
  if (ability === 'Blocker') q = q.ilike('effect_text', '%[Blocker]%');
  else if (ability === 'Rush') q = q.ilike('effect_text', '%[Rush]%');
  else if (ability === 'Searcher') q = q.ilike('effect_text', '%look at%top of your deck%').ilike('effect_text', '%add%hand%');
  const counter = $('cbCounter').value;
  if (counter === 'None') q = q.is('counter', null);
  else if (counter) q = q.eq('counter', Number(counter));
  if (colorOr) q = q.or(colorOr);
  const { data, error } = await q;
  if (error) return error;
  cbFrom += (data || []).length;
  if (!data || data.length < CB_FETCH) cbDone = true;
  cbRows = cbRows.concat((data || []).filter(c =>
    isBase(c.card_code) && capFor(c.card_code) !== 0 &&
    (state.deck.format !== 'standard' || standardLegal(c.card_code))));
  return null;
}

export async function loadBrowser() {
  if (!state.deck || !state.leaderCard) return;
  const seq = ++cbSeq;
  cbRows = []; cbShown = 0; cbFrom = 0; cbDone = false;
  $('cbCount').textContent = 'Loading…';
  $('cbGrid').innerHTML = '';
  $('cbMore').style.display = 'none';
  while (cbRows.length < CB_PAGE && !cbDone) {
    const err = await fetchBrowserChunk();
    if (seq !== cbSeq) return; // filters changed mid-flight
    if (err) { $('cbCount').textContent = 'Error: ' + err.message; return; }
  }
  cbShown = Math.min(CB_PAGE, cbRows.length);
  renderBrowser();
}

export async function loadMoreBrowser() {
  const seq = cbSeq;
  $('cbMore').disabled = true;
  while (cbRows.length < cbShown + CB_PAGE && !cbDone) {
    const err = await fetchBrowserChunk();
    if (seq !== cbSeq) return;
    if (err) break;
  }
  if (seq !== cbSeq) return;
  cbShown = Math.min(cbShown + CB_PAGE, cbRows.length);
  $('cbMore').disabled = false;
  renderBrowser();
}

// A card is "leader-locked" for this deck if its effect carries an "If your
// Leader …" condition the deck's leader can't meet (so it's dead / partly dead
// here). It's still LEGAL to run, so Add Cards only greys it. Conservative:
// locked only when the leader matches NONE of the card's leader conditions, so
// a card with one satisfied condition isn't greyed.
function evalLeaderClause(clause, L) {
  let m;
  if (/leader is \[/i.test(clause)) {
    const names = [...clause.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]); // "[A] or [B]"
    return names.includes(L.name) ? 'met' : 'unmet';
  }
  if ((m = clause.match(/leader has the \{([^}]+)\} type/i)))
    return Array.isArray(L.types) && L.types.includes(m[1]) ? 'met' : 'unmet';
  if ((m = clause.match(/leader has the <([^>]+)> attribute/i)))
    return (L.attribute || '').toLowerCase() === m[1].toLowerCase() ? 'met' : 'unmet';
  if (/leader is multicolored/i.test(clause))
    return /\//.test(L.color || '') ? 'met' : 'unmet';
  if ((m = clause.match(/leader is (red|green|blue|purple|black|yellow)\b/i)))
    return (L.color || '').toLowerCase().includes(m[1].toLowerCase()) ? 'met' : 'unmet';
  return 'unknown'; // some other leader reference we can't judge → don't grey
}
function leaderLocked(effect, L) {
  if (!effect || !L) return false;
  const clauses = effect.replace(/\s+/g, ' ').match(/if your leader\b[^.,;:]*/gi);
  if (!clauses) return false;
  let met = false, unmet = false;
  clauses.forEach(cl => { const r = evalLeaderClause(cl, L); if (r === 'met') met = true; else if (r === 'unmet') unmet = true; });
  return unmet && !met;
}

export function renderBrowser() {
  const grid = $('cbGrid');
  grid.innerHTML = '';
  const hasMore = cbRows.length > cbShown || !cbDone;
  $('cbCount').textContent = cbShown
    ? `${cbShown}${hasMore ? "+" : ""} cards`
    : 'No legal cards match.';
  cbRows.slice(0, cbShown).forEach(c => {
    const inDeck = state.deckCards.find(r => r.card_code === c.card_code);
    const locked = leaderLocked(c.effect_text, state.leaderCard);
    const tile = document.createElement('button');
    tile.className = 'cb-tile' + (locked ? ' cb-locked' : '');
    if (locked) tile.title = "Leader-locked — this card's effect needs a different leader. Still legal to add.";
    tile.innerHTML = `
      <div class="cb-tile-img">${c.image_url
        ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.image_url)}" alt="${esc(c.name || c.card_code)}">`
        : `<div class="card-placeholder small">${esc(c.card_code)}</div>`}${locked ? '<span class="cb-lock-badge">leader-locked</span>' : ''}${c.image_url ? `<div class="card-acts">${zoomBtnHTML()}</div>` : ''}</div>
      <div class="cb-tile-name">${esc(c.name || '')}${inDeck ? ` <span class="cb-in-deck">x${inDeck.quantity}</span>` : ''}</div>
      <div class="cb-tile-code">${esc(c.card_code)}</div>`;
    tile.addEventListener('click', () => addCard(c));
    wireZoom(tile, c);
    grid.appendChild(tile);
  });
  $('cbMore').style.display = hasMore ? '' : 'none';
}

// Click-to-add: optimistic + serialized via the shared deck-write queue, so
// fast clicks can't race into a duplicate INSERT (PK violation) that silently
// drops. The count bumps locally for instant feedback; writes run in order.
// Re-trigger a brief flash on an element (restart its CSS animation) so a
// repeated update still reads as "something happened" even when the text barely
// changes.
function flashCb(el) {
  if (!el) return;
  el.classList.remove('cb-flash');
  void el.offsetWidth; // force reflow to restart the animation
  el.classList.add('cb-flash');
}

function addCard(card) {
  $('edError').textContent = '';
  const cbErr = $('cbError');
  cbErr.textContent = '';
  cbErr.classList.remove('cb-note');
  state.cardInfo[card.card_code] = card;
  const deckTotal = state.deckCards.reduce((s, r) => s + r.quantity, 0);
  if (deckTotal >= 50) { // deck is full — overflow lands on the bench
    benchAdd(card.card_code, 1, $('cbOwned').checked ? 1 : 0);
    const bq = (state.bench.find(x => x.code === card.card_code) || {}).qty || 1;
    // Running count + flash so EVERY over-50 click gives feedback, not just the
    // first (the count changes and the line re-animates on each add).
    cbErr.classList.add('cb-note');
    cbErr.textContent = `Deck's at 50 — ${card.card_code} sent to the bench (×${bq} there).`;
    flashCb(cbErr);
    return;
  }
  const owned = $('cbOwned').checked; // count the added copy as owned
  const existing = state.deckCards.find(r => r.card_code === card.card_code);
  const cap = capFor(card.card_code); // null = unlimited
  if (existing && cap !== null && existing.quantity >= cap) {
    $('cbError').textContent = `Max ${cap} cop${cap === 1 ? 'y' : 'ies'} of ${card.card_code}.`;
    return;
  }
  // Optimistic local update — instant ×N bump, no reload between clicks.
  if (existing) localSetRow(card.card_code, { quantity: existing.quantity + 1, owned: owned ? existing.owned + 1 : existing.owned });
  else { state.deckCards.push({ card_code: card.card_code, quantity: 1, owned: owned ? 1 : 0 }); renderDeckLocal(); }

  queueDeckWrite(async () => {
    const cur = await readDeckCard(card.card_code);
    if (cur) {
      const { error } = await window.sb.from('deck_cards')
        .update({ quantity: cur.quantity + 1, owned: owned ? (cur.owned || 0) + 1 : cur.owned })
        .eq('deck_id', state.deck.id).eq('card_code', card.card_code);
      if (error) throw error;
    } else {
      const { error } = await window.sb.from('deck_cards')
        .insert({ deck_id: state.deck.id, card_code: card.card_code, quantity: 1, owned: owned ? 1 : 0 });
      if (error) throw error;
    }
  });
}
