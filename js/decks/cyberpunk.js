import { state } from './state.js';
import { $, esc, debounce, pillValue } from './helpers.js';
import { showList, closeNewDeck, openDeck } from './index.js';

// ============================================================
// Cyberpunk TCG deck module (registered TCG plugin — see DECK_MODULES)
// ============================================================
// Fully self-contained: its own DOM (#cpEditorWrap / #cpBrowser), its own
// state and DB writes. Reuses only stateless shared helpers ($, esc,
// debounce, pillValue, setPill, user, window.sb) and the game-agnostic RPCs
// (deck_validity, publish_deck, unpublish_deck). Adding another TCG follows
// this same shape and touches NOTHING here or in the One Piece path.
const CP_COLORS = ['Red', 'Blue', 'Green', 'Yellow'];
const CP_TYPES = ['Legend', 'Unit', 'Gear', 'Program'];
const CP_RARITIES = ['Common', 'Uncommon', 'Rare', 'Epic'];
const CP_RAM = [1, 2, 3, 4, 5, 6];
const CP_COSTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const CP_TAGS = ['6th Street', 'Aldecado', 'Arasaka', 'Braindance', 'Corpo', 'Cyberware', 'Doll', 'Drone', 'Extreme', 'Ganger', 'Maelstrom', 'Merc', 'Militech', 'Mox', 'Mystic', 'NCPD', 'Netrunner', 'Nomad', 'Quickhack', 'Raffen Shiv', 'Ripperdoc', 'Rocker', 'Samurai', 'Scavenger', 'Trauma Team', 'Tyger Claws', 'Valentino', 'Vehicle', 'Voodoo Boys', 'Weapon', 'Zetatech'];

let cpDeck = null, cpOwner = false, cpSeq = 0;
let cpLegends = [], cpCards = [], cpInfo = {};
let cpChosen = [];         // new-deck legend picks
let cpBrowMode = 'card';   // 'card' | 'legend'
let cpQueue = Promise.resolve();

// Per-color RAM cap = sum of the RAM of the Legends sharing that color.
function cpCaps() {
  const caps = {};
  cpLegends.forEach(l => {
    const c = cpInfo[l.card_code] || {};
    if (c.color) caps[c.color] = (caps[c.color] || 0) + (c.ram || 0);
  });
  return caps;
}

export async function cpOpen(d) {
  cpDeck = d; cpOwner = (d.user_id === state.user.id); cpSeq++;
  $('cpEditorWrap').style.display = '';
  $('cpDeckName').value = d.name || '';
  $('cpDeckName').disabled = !cpOwner;
  $('cpError').textContent = '';
  $('cpEyeBtn').closest('.eye-wrap').style.display = cpOwner ? '' : 'none';
  $('cpDeleteBtn').style.display = cpOwner ? '' : 'none';
  $('cpAddBtn').style.display = cpOwner ? '' : 'none';
  await cpLoad();
}

async function cpLoad() {
  if (!cpDeck) return;
  const seq = cpSeq;
  const [{ data: legs }, { data: cards }] = await Promise.all([
    window.sb.from('deck_legends').select('card_code,owned').eq('deck_id', cpDeck.id),
    window.sb.from('deck_cards').select('card_code,quantity,owned').eq('deck_id', cpDeck.id),
  ]);
  if (seq !== cpSeq) return;
  cpLegends = legs || []; cpCards = cards || [];
  const codes = [...new Set([...cpLegends.map(l => l.card_code), ...cpCards.map(c => c.card_code)])];
  cpInfo = {};
  if (codes.length) {
    const { data: info } = await window.sb.from('cards')
      .select('card_code,name,color,cost,ram,type,rarity,image_url')
      .eq('game', 'cyberpunk').in('card_code', codes);
    (info || []).forEach(c => { cpInfo[c.card_code] = c; });
  }
  if (seq !== cpSeq) return;
  cpRender();
  cpRefreshValidity();
}

function cpRender() {
  const caps = cpCaps();
  // ---- Legends ----
  const lg = $('cpLegendsGrid'); lg.innerHTML = '';
  cpLegends.forEach(l => {
    const c = cpInfo[l.card_code] || {};
    const t = document.createElement('div');
    t.className = 'deck-card-tile' + (l.owned ? '' : ' missing');
    t.title = `${c.name || l.card_code}${c.color ? ' · ' + c.color : ''}${c.ram != null ? ' · RAM ' + c.ram : ''}`;
    t.innerHTML =
      `<img src="${esc(c.image_url || '')}" alt="${esc(c.name || l.card_code)}">
      <span class="cp-legend-owned">${l.owned ? '✓ owned' : 'need'}</span>` +
      (cpOwner ? '<div class="card-acts"><button class="card-act cp-lrm" aria-label="Remove Legend">✕</button></div>' : '');
    if (cpOwner) {
      t.querySelector('.cp-legend-owned').addEventListener('click', () => cpToggleLegendOwned(l.card_code, l.owned ? 0 : 1));
      t.querySelector('.cp-lrm').addEventListener('click', () => cpRemoveLegend(l.card_code));
    }
    lg.appendChild(t);
  });
  $('cpLegendCount').textContent = `(${cpLegends.length}/3)`;
  $('cpAddLegendBtn').style.display = (cpOwner && cpLegends.length < 3) ? '' : 'none';
  // ---- RAM caps ----
  const usable = CP_COLORS.filter(col => caps[col]);
  $('cpRamCaps').innerHTML = usable.length
    ? usable.map(col => `<span class="cp-ram-cap">${col}: RAM ≤ ${caps[col]}</span>`).join('')
    : '<span class="text-muted-line">Add Legends to unlock colors.</span>';
  // ---- Main deck ----
  const grid = $('cpDeckGrid'); grid.innerHTML = '';
  const sorted = cpCards.slice().sort((a, b) =>
    ((cpInfo[a.card_code] || {}).cost ?? 99) - ((cpInfo[b.card_code] || {}).cost ?? 99)
    || String(a.card_code).localeCompare(b.card_code));
  sorted.forEach(r => {
    const c = cpInfo[r.card_code] || {};
    const cap = caps[c.color] || 0;
    const over = (c.ram || 0) > cap;
    const t = document.createElement('div');
    t.className = 'deck-card-tile' + (r.owned < r.quantity ? ' missing' : '') + (over ? ' over-cap' : '');
    t.title = `${c.name || r.card_code} — ${r.quantity} in deck, ${r.owned} owned`
      + (over ? ` · RAM ${c.ram || 0} over ${c.color} cap ${cap}` : '');
    t.innerHTML =
      `<img src="${esc(c.image_url || '')}" alt="${esc(c.name || r.card_code)}">` +
      (cpOwner ? `<div class="card-acts">
        <button class="card-act cp-dec" aria-label="Remove one">−</button>
        <button class="card-act cp-own" aria-label="Mark owned" title="Owned ${r.owned}/${r.quantity}">✓</button>
        <button class="card-act cp-inc${r.quantity >= 3 ? ' at-cap' : ''}" aria-label="Add one"${r.quantity >= 3 ? ' aria-disabled="true"' : ''}>+</button>
      </div>` : '') +
      `<span class="qty-badge"><span class="qty-total">x${r.quantity}</span><span class="qty-missing">x${r.quantity - r.owned}</span></span>`;
    if (cpOwner) {
      t.querySelector('.cp-dec').addEventListener('click', () => cpStep(r.card_code, 'qty', -1));
      t.querySelector('.cp-inc').addEventListener('click', () => { if (r.quantity < 3) cpStep(r.card_code, 'qty', 1); });
      t.querySelector('.cp-own').addEventListener('click', () => cpStep(r.card_code, 'owned', r.owned < r.quantity ? 1 : -r.quantity));
    }
    grid.appendChild(t);
  });
}

async function cpRefreshValidity() {
  if (!cpDeck) return;
  const deck = cpDeck;
  const localTotal = cpCards.reduce((s, r) => s + r.quantity, 0);
  const { data: v } = await window.sb.rpc('deck_validity', { p_deck_id: deck.id });
  if (cpDeck !== deck) return;   // deck deleted/switched while the RPC was in flight (cf. openSeq in index.js)
  // eye reflects publish state (open eye = public, slashed = hidden)
  const on = $('cpEyeBtn').querySelector('.eye-on'), off = $('cpEyeBtn').querySelector('.eye-off');
  if (on && off) { on.style.display = cpDeck.is_public ? '' : 'none'; off.style.display = cpDeck.is_public ? 'none' : ''; }
  if (!v) { $('cpCounts').textContent = `${localTotal} / 40–50 cards`; return; }
  const badge = (v.valid && v.owned_complete)
    ? '<span class="deck-badge ok">valid</span>'
    : '<span class="deck-badge bad">Cooking</span>';
  const pub = cpDeck.is_public ? ` <span class="deck-badge pub">${esc(cpDeck.listing_type || 'public')}</span>` : '';
  $('cpBadges').innerHTML = badge + pub;
  const probs = (v.problems && v.problems.length)
    ? `<br><span class="text-muted-line">• ${v.problems.map(esc).join('<br>• ')}</span>` : '';
  $('cpCounts').innerHTML = `Main deck ${v.total_cards} / 40–50 · owned ${v.owned_cards}, missing ${v.missing_cards}${probs}`;
}

// Optimistic local edit + serialized DB write; a settle reload reconciles
// anything the gatekeeper trigger rejected (mirrors the OPTCG write queue).
function cpEnqueue(fn) {
  cpQueue = cpQueue.then(fn).then(() => cpLoad(), (e) => {
    $('cpError').textContent = (e && e.message) || 'Update failed.';
    return cpLoad();
  });
}

function cpStep(code, kind, delta) {
  if (!cpOwner) return;
  const row = cpCards.find(r => r.card_code === code);
  if (!row) return;
  let q = row.quantity, o = row.owned;
  if (kind === 'qty') { q = Math.max(0, Math.min(3, q + delta)); o = Math.min(o, q); }
  else { o = Math.max(0, Math.min(q, o + delta)); }
  if (q === 0) cpCards = cpCards.filter(r => r.card_code !== code);
  else { row.quantity = q; row.owned = o; }
  cpRender();
  cpEnqueue(async () => {
    const res = q === 0
      ? await window.sb.from('deck_cards').delete().eq('deck_id', cpDeck.id).eq('card_code', code)
      : await window.sb.from('deck_cards').update({ quantity: q, owned: o }).eq('deck_id', cpDeck.id).eq('card_code', code);
    if (res.error) throw res.error;
  });
}

function cpAddCard(code) {
  if (!cpOwner) return;
  const row = cpCards.find(r => r.card_code === code);
  if (row) { if (row.quantity < 3) cpStep(code, 'qty', 1); return; }
  cpCards.push({ card_code: code, quantity: 1, owned: 0 });
  cpRender();
  cpEnqueue(async () => {
    const { error } = await window.sb.from('deck_cards').insert({ deck_id: cpDeck.id, card_code: code, quantity: 1, owned: 0 });
    if (error) throw error;
  });
}

async function cpToggleLegendOwned(code, val) {
  if (!cpOwner) return;
  await window.sb.from('deck_legends').update({ owned: val }).eq('deck_id', cpDeck.id).eq('card_code', code);
  cpLoad();
}

async function cpRemoveLegend(code) {
  if (!cpOwner) return;
  await window.sb.from('deck_legends').delete().eq('deck_id', cpDeck.id).eq('card_code', code);
  await cpSyncLeader();
  cpLoad();
}

// Keep decks.leader_card_code (NOT NULL, must be a Legend) pointed at a
// current Legend after edits. Validity reads deck_legends, so this is only to
// satisfy the column/FK.
async function cpSyncLeader() {
  const { data: legs } = await window.sb.from('deck_legends').select('card_code').eq('deck_id', cpDeck.id).limit(1);
  const first = legs && legs[0] && legs[0].card_code;
  if (first && first !== cpDeck.leader_card_code) {
    await window.sb.from('decks').update({ leader_card_code: first }).eq('id', cpDeck.id);
    cpDeck.leader_card_code = first;
  }
}

async function cpAddLegendCode(code) {
  const { error } = await window.sb.from('deck_legends').insert({ deck_id: cpDeck.id, card_code: code });
  if (error) { $('cpbError').textContent = error.message; return; }
  await cpSyncLeader();
  await cpLoad();
  if (cpLegends.length >= 3) cpBrowserClose();
}

async function cpEye() {
  if (!cpOwner || !cpDeck) return;
  $('cpError').textContent = '';
  if (cpDeck.is_public) {
    await window.sb.rpc('unpublish_deck', { p_deck_id: cpDeck.id });
    cpDeck.is_public = false; cpDeck.listing_type = null;
  } else {
    const { error } = await window.sb.rpc('publish_deck', { p_deck_id: cpDeck.id, p_listing_type: 'trade' });
    if (error) { $('cpError').textContent = error.message; return; }
    cpDeck.is_public = true; cpDeck.listing_type = 'trade';
  }
  cpRefreshValidity();
}

async function cpDelete() {
  if (!cpOwner || !cpDeck) return;
  if (!confirm('Delete this deck? This cannot be undone.')) return;
  const { error } = await window.sb.from('decks').delete().eq('id', cpDeck.id);
  if (error) { $('cpError').textContent = error.message; return; }
  cpDeck = null;
  showList();
}

async function cpRename() {
  if (!cpOwner || !cpDeck) return;
  const n = ($('cpDeckName').value.trim().slice(0, 24)) || 'Cyberpunk Deck';
  await window.sb.from('decks').update({ name: n }).eq('id', cpDeck.id);
  cpDeck.name = n;
}

// ---- Cyberpunk card browser (also picks Legends via a mode flag) ----
let cpBrowserInited = false;
function cpFillSelect(id, values, allLabel) {
  $(id).innerHTML = `<option value="">${allLabel}</option>`
    + values.map(v => `<option value="${esc(String(v))}">${esc(String(v))}</option>`).join('');
}
function cpBrowserInit() {
  if (cpBrowserInited) return;
  cpBrowserInited = true;
  cpFillSelect('cpbColor', CP_COLORS, 'Any');
  cpFillSelect('cpbType', CP_TYPES, 'All');
  cpFillSelect('cpbCost', CP_COSTS, 'Any');
  cpFillSelect('cpbTag', CP_TAGS, 'Any');
  cpFillSelect('cpbRam', CP_RAM, 'Any');
  cpFillSelect('cpbRarity', CP_RARITIES, 'Any');
  ['cpbColor', 'cpbType', 'cpbCost', 'cpbTag', 'cpbRam', 'cpbRarity'].forEach(id => $(id).addEventListener('change', cpBrowserSearch));
  $('cpbName').addEventListener('input', debounce(cpBrowserSearch, 250));
  $('cpbClear').addEventListener('click', () => {
    ['cpbName', 'cpbColor', 'cpbType', 'cpbCost', 'cpbTag', 'cpbRam', 'cpbRarity'].forEach(id => { $(id).value = ''; });
    cpBrowserSearch();
  });
  $('cpbClose').addEventListener('click', cpBrowserClose);
  $('cpBrowser').addEventListener('click', (e) => { if (e.target === $('cpBrowser')) cpBrowserClose(); });
}
function cpBrowserOpen(mode) {
  cpBrowserInit();
  cpBrowMode = mode;
  $('cpbTitle').textContent = mode === 'legend' ? 'Add a Legend' : 'Add Cards';
  $('cpbType').disabled = (mode === 'legend'); // always Legend in legend mode
  $('cpBrowser').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  cpBrowserSearch();
}
function cpBrowserClose() {
  $('cpBrowser').style.display = 'none';
  document.body.style.overflow = '';
}
async function cpBrowserSearch() {
  $('cpbError').textContent = '';
  let q = window.sb.from('cards')
    .select('card_code,name,color,cost,ram,type,rarity,image_url').eq('game', 'cyberpunk');
  if (cpBrowMode === 'legend') q = q.eq('type', 'Legend');
  else { const t = $('cpbType').value; if (t) q = q.eq('type', t); }
  const col = $('cpbColor').value; if (col) q = q.eq('color', col);
  const cost = $('cpbCost').value; if (cost !== '') q = q.eq('cost', parseInt(cost, 10));
  const tag = $('cpbTag').value; if (tag) q = q.contains('types', [tag]);
  const ram = $('cpbRam').value; if (ram !== '') q = q.eq('ram', parseInt(ram, 10));
  const rar = $('cpbRarity').value; if (rar) q = q.eq('rarity', rar);
  const name = $('cpbName').value.trim();
  if (name) { const safe = name.replace(/[%,]/g, ''); q = q.or(`name.ilike.%${safe}%,card_code.ilike.%${safe}%`); }
  const { data, error } = await q.order('color').order('cost').limit(120);
  const grid = $('cpbGrid'); grid.innerHTML = '';
  if (error) { $('cpbError').textContent = error.message; return; }
  let rows = data || [];
  if (cpBrowMode === 'legend') {            // one entry per Legend name (hide printings)
    const seen = new Set();
    rows = rows.filter(c => (seen.has(c.name) ? false : (seen.add(c.name), true)));
  }
  $('cpbCount').textContent = rows.length ? `${rows.length} card${rows.length === 1 ? '' : 's'}` : 'No cards match.';
  rows.forEach(c => {
    const inDeck = cpBrowMode === 'card' && cpCards.find(r => r.card_code === c.card_code);
    const tile = document.createElement('button');
    tile.className = 'cb-tile';
    tile.title = `${c.name} · ${c.color || ''} · ${c.type || ''}${c.ram != null ? ' · RAM ' + c.ram : ''}`;
    tile.innerHTML =
      `<div class="cb-tile-img">${c.image_url
        ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.image_url)}" alt="${esc(c.name || c.card_code)}">`
        : `<div class="card-placeholder small">${esc(c.card_code)}</div>`}</div>
      <div class="cb-tile-name">${esc(c.name || '')}${inDeck ? ` <span class="cb-in-deck">x${inDeck.quantity}</span>` : ''}</div>
      <div class="cb-tile-code">${esc(c.card_code)}</div>`;
    tile.addEventListener('click', () => {
      if (cpBrowMode === 'legend') cpAddLegendCode(c.card_code);
      else { cpInfo[c.card_code] = c; cpAddCard(c.card_code); cpBrowserSearch(); }
    });
    grid.appendChild(tile);
  });
}

// ---- New-deck: Cyberpunk 3-Legend picker ----
function cpResetCreate() {
  cpChosen = [];
  if ($('legendResults')) $('legendResults').innerHTML = '';
  if ($('legendSearch')) $('legendSearch').value = '';
  cpRenderChosen();
}
window.cpResetCreate = cpResetCreate;
function cpRenderChosen() {
  const box = $('ndLegendsChosen');
  box.innerHTML = cpChosen.map((c, i) =>
    `<span class="cp-chip">${esc(c.name)}<button type="button" data-i="${i}" aria-label="Remove">✕</button></span>`).join('');
  box.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    cpChosen.splice(parseInt(b.dataset.i, 10), 1); cpRenderChosen();
  }));
  const btn = $('ndCreateCp');
  btn.disabled = cpChosen.length !== 3;
  const left = 3 - cpChosen.length;
  btn.textContent = left === 0 ? 'Create deck' : `Pick ${left} more Legend${left === 1 ? '' : 's'}`;
}
async function cpSearchLegends() {
  const qv = $('legendSearch').value.trim();
  const out = $('legendResults');
  if (qv.length < 2) { out.innerHTML = ''; return; }
  const safe = qv.replace(/[%,]/g, '');
  const { data } = await window.sb.from('cards')
    .select('card_code,name,color,ram,image_url').eq('game', 'cyberpunk').eq('type', 'Legend')
    .or(`name.ilike.%${safe}%,card_code.ilike.%${safe}%`).order('name').limit(60);
  const seen = new Set(); const rows = [];
  (data || []).forEach(c => { if (!seen.has(c.name)) { seen.add(c.name); rows.push(c); } });
  out.innerHTML = rows.length ? '' : '<li style="cursor:default;opacity:.6;">No Legends found.</li>';
  rows.slice(0, 25).forEach(c => {
    const li = document.createElement('li');
    li.innerHTML = `<img src="${esc(c.image_url || '')}" alt=""><div class="row-main">
      <div class="row-name">${esc(c.name)}</div>
      <div class="row-sub">${esc(c.color || '')} · RAM ${c.ram ?? '?'}</div></div>`;
    li.addEventListener('click', () => {
      if (cpChosen.length >= 3 || cpChosen.some(x => x.name === c.name)) return; // 3 max, unique names
      cpChosen.push(c); cpRenderChosen();
    });
    out.appendChild(li);
  });
}
async function cpCreateDeck() {
  if (cpChosen.length !== 3) return;
  const errEl = $('newDeckError'); errEl.textContent = '';
  const { data, error } = await window.sb.from('decks').insert({
    user_id: state.user.id, game: 'cyberpunk',
    leader_card_code: cpChosen[0].card_code, name: 'Cyberpunk Deck',
  }).select('id').single();
  if (error) { errEl.textContent = error.message; return; }
  for (const l of cpChosen) {
    const { error: e2 } = await window.sb.from('deck_legends').insert({ deck_id: data.id, card_code: l.card_code });
    if (e2) { errEl.textContent = e2.message; break; }
  }
  closeNewDeck();
  openDeck(data.id, true);
}

export function cpInit() {
  $('ndGame').addEventListener('click', () => {
    const g = pillValue('ndGame') || 'optcg';
    $('ndOptcgCreate').style.display = g === 'optcg' ? '' : 'none';
    $('ndCyberpunkCreate').style.display = g === 'cyberpunk' ? '' : 'none';
    if (g === 'cyberpunk') { cpResetCreate(); setTimeout(() => $('legendSearch').focus(), 0); }
  });
  $('legendSearch').addEventListener('input', debounce(cpSearchLegends, 250));
  $('ndCreateCp').addEventListener('click', cpCreateDeck);
  $('cpBack').addEventListener('click', () => showList());
  $('cpDeckName').addEventListener('change', cpRename);
  $('cpEyeBtn').addEventListener('click', cpEye);
  $('cpDeleteBtn').addEventListener('click', cpDelete);
  $('cpAddBtn').addEventListener('click', () => cpBrowserOpen('card'));
  $('cpAddLegendBtn').addEventListener('click', () => cpBrowserOpen('legend'));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cpBrowserClose(); });
}
