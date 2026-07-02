// ============================================
// Decks — One Piece deck builder (v1, optcg only)
// ============================================
// Rules live server-side (scripts/decks_migration.sql): 1 leader + exactly
// 50 cards, leader-color matching, 4-copy limit by base card number with
// data-driven exceptions/bans (bans cover leaders too), banned pairs (the
// leader counts as a pair member), Standard rotation (decks.format
// standard/eternal; rotated_sets + rotation_exempt_cards), one deck per
// leader, 5-deck cap (profiles.deck_limit). This UI mirrors them for
// instant feedback and relies on the deck_validity RPC as source of truth.

import { state } from './state.js';
import { GAME, $, isBase, baseCode, artMixOf, altCountOf, colorAbbrev, standardLegal, pillValue, setPill, debounce, esc, capFor, byCostThenCode } from './helpers.js';
import { cpOpen, cpInit } from './cyberpunk.js';
import { closePrices, openPrices } from './prices.js';
import { closeStats, openStats } from './stats.js';
import { parseDecklist, lookupCards, closeDl, closeMenus, toggleMenu, openExport, openExportMissing, openImportEditor, onDlAction } from './import-export.js';
import { saveBench, loadBench, benchAdd, benchRemove, renderBench, toggleBench, toggleBenchSide, makeDragHandle, wireDeckDropTarget, wireDropZones } from './bench.js';
import { openBrowser, closeBrowser, ensureTraitPool, renderTraitList, loadBrowser, loadMoreBrowser, renderBrowser } from './browser.js';

const setupNotice = document.getElementById('setupNotice');
setupNotice.innerHTML = window.PK.notReadyMessage();

const artKey = (deckId) => `pawpaw:deckArt:${deckId}`;
const cardArtKey = (deckId) => `pawpaw:deckCardArt:${deckId}`;

// ---- Signed-out interactive demo ----
// Ko's GU Monkey.D.Luffy deck as [code, quantity, owned] — 50 cards, 37 owned,
// 13 missing across five cards (OP16-032 all 4 missing, the rest partial).
const DEMO_DECK = [
  ['OP05-057', 2, 2], ['OP11-061', 2, 2], ['OP13-040', 2, 2], ['OP15-032', 2, 2],
  ['OP16-026', 3, 1], ['OP16-027', 2, 2], ['OP16-032', 4, 0], ['OP16-034', 4, 4],
  ['OP16-038', 3, 3], ['OP16-042', 4, 4], ['OP16-045', 4, 2], ['OP16-048', 4, 1],
  ['OP16-054', 4, 4], ['OP16-055', 4, 4], ['OP16-056', 4, 2], ['ST30-014', 2, 2],
];
// Bench: two not owned (Bunkov, Antlerkov) + one partially owned (Luffy 1/3).
const DEMO_BENCH = [
  { code: 'OP16-025', qty: 1, owned: 0 },
  { code: 'OP16-029', qty: 1, owned: 0 },
  { code: 'OP16-052', qty: 3, owned: 1 },
];

async function init() {
  state.user = await window.PK.currentUser();
  if (!state.user) { state.DEMO = true; state.user = { id: '__demo__' }; }

  const [{ data: exRows }, { data: rotSets }, { data: rotEx }] = await Promise.all([
    window.sb.from('deck_rule_exceptions').select('card_code,max_copies').eq('game', GAME),
    window.sb.from('rotated_sets').select('set_prefix').eq('game', GAME),
    window.sb.from('rotation_exempt_cards').select('card_code').eq('game', GAME),
  ]);
  (exRows || []).forEach(r => { state.exceptions[r.card_code] = r.max_copies; });
  state.rotatedPrefixes = new Set((rotSets || []).map(r => r.set_prefix));
  state.rotationExempt = new Set((rotEx || []).map(r => r.card_code));

  $('ndClose').addEventListener('click', closeNewDeck);
  $('ndOverlay').addEventListener('click', (e) => { if (e.target === $('ndOverlay')) closeNewDeck(); });
  $('edIoBtn').addEventListener('click', (e) => toggleMenu('edIoBtn', 'edIoMenu', e));
  $('edExportBtn').addEventListener('click', () => { closeMenus(); openExport(); });
  $('edExportMissingBtn').addEventListener('click', () => { closeMenus(); openExportMissing(); });
  $('edImportBtn').addEventListener('click', () => { closeMenus(); openImportEditor(); });
  $('edPriceBtn').addEventListener('click', (e) => toggleMenu('edPriceBtn', 'edPriceMenu', e));
  $('edCostDeckBtn').addEventListener('click', () => { closeMenus(); openPrices('deck'); });
  $('edCostFinishBtn').addEventListener('click', () => { closeMenus(); openPrices('finish'); });
  document.addEventListener('click', (e) => { if (!e.target.closest('.deck-io-wrap')) closeMenus(); });
  $('edBenchBtn').addEventListener('click', toggleBench);
  $('edBenchSideBtn').addEventListener('click', toggleBenchSide);
  $('edStatsBtn').addEventListener('click', openStats);
  $('stClose').addEventListener('click', closeStats);
  $('stOverlay').addEventListener('click', (e) => { if (e.target === $('stOverlay')) closeStats(); });
  wireDropZones();
  $('pcClose').addEventListener('click', closePrices);
  $('pcOverlay').addEventListener('click', (e) => { if (e.target === $('pcOverlay')) closePrices(); });
  $('dlClose').addEventListener('click', closeDl);
  $('dlAction').addEventListener('click', onDlAction);
  $('dlOverlay').addEventListener('click', (e) => { if (e.target === $('dlOverlay')) closeDl(); });
  $('leaderSearch').addEventListener('input', debounce(searchLeaders, 250));
  $('backToDecks').addEventListener('click', () => showList()); // no event arg -> fromPop stays false
  $('edAddBtn').addEventListener('click', openBrowser);
  $('cbClose').addEventListener('click', closeBrowser);
  $('cbOverlay').addEventListener('click', (e) => { if (e.target === $('cbOverlay')) closeBrowser(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenus(); closeBrowser(); closeDl(); closeNewDeck(); closePrices(); closeStats(); } });
  ['cbType', 'cbCost', 'cbAbility', 'cbCounter'].forEach(id =>
    $(id).addEventListener('change', loadBrowser));
  $('cbName').addEventListener('input', debounce(loadBrowser, 250));
  const debouncedBrowse = debounce(loadBrowser, 250);
  $('cbTrait').addEventListener('input', () => { renderTraitList(); debouncedBrowse(); });
  $('cbTrait').addEventListener('focus', renderTraitList);
  $('cbTrait').addEventListener('blur', () => setTimeout(() => { $('cbTraitList').style.display = 'none'; }, 150));
  $('cbTraitList').addEventListener('mousedown', (e) => { // mousedown beats blur
    const li = e.target.closest('li');
    if (!li) return;
    $('cbTrait').value = li.dataset.t;
    $('cbTraitList').style.display = 'none';
    loadBrowser();
  });
  $('cbMore').addEventListener('click', loadMoreBrowser);
  $('cbClear').addEventListener('click', () => {
    ['cbName', 'cbType', 'cbTrait', 'cbCost', 'cbAbility', 'cbCounter'].forEach(id => { $(id).value = ''; });
    loadBrowser();
  });
  $('edDeckName').addEventListener('change', renameDeck);
  $('edArtBtn').addEventListener('click', cycleLeaderArt);
  $('edEyeBtn').addEventListener('click', onEyeClick);
  $('edFlair').addEventListener('click', () => { // switch type on a public deck
    const opts = $('edPublishOpts');
    opts.style.display = opts.style.display === 'none' ? '' : 'none';
  });
  $('edDeleteBtn').addEventListener('click', deleteDeck);
  document.querySelectorAll('.pill-choice').forEach(group => {
    group.addEventListener('click', e => {
      const btn = e.target.closest('.pill-choice-btn');
      if (!btn || btn.disabled) return;
      group.querySelectorAll('.pill-choice-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });
  });
  // Registered after the generic toggler so these read the new selection.
  $('ndFormat').addEventListener('click', () => searchLeaders());
  $('edFormat').addEventListener('click', onFormatClick);
  $('edListingType').addEventListener('click', onListingTypeClick);
  cpInit();  // wire the Cyberpunk TCG module (new-deck game toggle + its editor)

  // Browser Back/Forward moves between the deck list and the editor.
  window.addEventListener('popstate', () => {
    const id = new URLSearchParams(location.search).get('deck');
    if (id) openDeck(id);
    else showList(true);
  });

  if (state.DEMO) { await startDemo(); return; }

  // Deep-link / refresh restore: ?deck=<id> reopens that deck's editor.
  const deepLink = new URLSearchParams(location.search).get('deck');
  if (deepLink) { openDeck(deepLink); return; }

  $('decksWrap').style.display = '';
  loadDecks();
}

// ---- Signed-out interactive demo: run the REAL editor on an in-memory copy
// of Ko's deck. Writes are stubbed (guarded by DEMO) so nothing saves; reads
// (card art, prices, stats) use the world-readable cards table. ----
async function startDemo() {
  state.deck = { id: '__demo__', name: 'GU Monkey.D.Luffy Deck', leader_card_code: 'OP16-022', format: 'standard', user_id: state.user.id, is_public: false };
  state.isDeckOwner = true;
  state.ownedElsewhere = {}; state.cardArt = {}; state.artOverride = {}; state.leaderArts = [];
  state.deckCards = DEMO_DECK.map(([card_code, quantity, owned]) => ({ card_code, quantity, owned, art_mix: {} }));
  state.bench = DEMO_BENCH.map(b => ({ code: b.code, qty: b.qty, owned: b.owned }));
  const codes = state.deckCards.map(r => r.card_code).concat(state.bench.map(b => b.code));
  const [{ data: L }, { data: cs }] = await Promise.all([
    window.sb.from('cards').select('card_code,name,color,cost,life,image_url,image_url_lg,types,attribute').eq('game', GAME).eq('card_code', state.deck.leader_card_code).maybeSingle(),
    window.sb.from('cards').select('card_code,name,color,cost,type,image_url,image_url_lg,counter,effect_text,types').eq('game', GAME).in('card_code', codes),
  ]);
  state.leaderCard = L || null;
  (cs || []).forEach(c => { state.cardInfo[c.card_code] = c; });

  // Seed one stack as base+alt mixed so the composition pips/fan show in the
  // demo (picks the first deck card that actually has an alt print in prod).
  try {
    const { data: prints } = await window.sb.from('cards')
      .select('card_code,image_url,image_url_lg').eq('game', GAME)
      .or(state.deckCards.map(r => `card_code.like.${r.card_code}_p*`).join(','));
    const byBase = {};
    (prints || []).forEach(p => {
      state.printInfo[p.card_code] = p;
      const b = baseCode(p.card_code);
      (byBase[b] = byBase[b] || []).push(p.card_code);
    });
    const target = state.deckCards.find(r => r.quantity >= 3 && byBase[r.card_code])
      || state.deckCards.find(r => r.quantity >= 2 && byBase[r.card_code]);
    if (target) target.art_mix = { [byBase[target.card_code].sort()[0]]: 2 };
  } catch (e) {}
  rebuildCardArt();

  // Drop the real editor into the signed-out preview (headline · editor · CTA).
  const sop = $('signedOutPreview');
  sop.style.display = '';
  const stub = sop.querySelector('[data-pk-demo="deck"]'); if (stub) stub.remove();
  const cta = sop.querySelector('.signed-out-cta');
  const ew = $('editorWrap');
  if (cta) sop.insertBefore(ew, cta); else sop.appendChild(ew);
  ew.style.display = '';
  $('backToDecks').style.display = 'none';

  $('edDeckName').value = state.deck.name; $('edDeckName').readOnly = true;
  setPill('edFormat', state.deck.format);

  // Leader alt arts: same swap as signed-in (in-memory only in the demo).
  const { data: lArts } = await window.sb
    .from('cards').select('card_code,image_url,image_url_lg')
    .eq('game', GAME).like('card_code', state.deck.leader_card_code + '%');
  const lRe = new RegExp(`^${state.deck.leader_card_code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_p\\d+)?$`, 'i');
  state.leaderArts = (lArts || []).filter(c => lRe.test(c.card_code))
    .sort((a, b) => a.card_code.localeCompare(b.card_code));
  state.artIdx = 0;
  $('edArtBtn').style.display = state.leaderArts.length > 1 ? '' : 'none';
  applyLeaderArt();
  $('edPublishOpts').style.display = 'none';

  renderDeck();
  await refreshValidity();
  renderBench();
  $('edBenchSection').style.display = '';                 // reveal the seeded bench
  $('edBenchBtn').setAttribute('aria-expanded', 'true');

  // Console helper to lock in a new default: arrange the deck + bench, then run
  // PKDemoExport() in DevTools — it copies the current setup as JSON (deck +
  // bench) to paste back so it can be baked into DEMO_DECK / DEMO_BENCH.
  window.PKDemoExport = () => {
    const out = {
      deck: state.deckCards.map(r => [r.card_code, r.quantity, r.owned]),
      bench: state.bench.map(b => ({ code: b.code, qty: b.qty, owned: b.owned })),
      format: state.deck.format,
    };
    const json = JSON.stringify(out);
    try { navigator.clipboard.writeText(JSON.stringify(out, null, 2)); } catch (e) {}
    console.log('%cPKDemo setup (copied to clipboard):', 'font-weight:bold', json);
    return out;
  };
}

function demoValidity() {
  const total = state.deckCards.reduce((s, r) => s + r.quantity, 0);
  const owned = state.deckCards.reduce((s, r) => s + Math.min(r.owned, r.quantity), 0);
  const missing = state.deckCards.reduce((s, r) => s + Math.max(0, r.quantity - r.owned), 0);
  const valid = total === 50;
  return { valid, total_cards: total, owned_cards: owned, missing_cards: missing, owned_complete: missing === 0, problems: valid ? [] : [`${total} of 50 cards`] };
}

// ---------------- deck list ----------------

function openNewDeck() {
  // Reset to the default (One Piece) create view; a registered TCG module
  // (e.g. cyberpunk) swaps the panel via the #ndGame toggle.
  setPill('ndGame', 'optcg');
  $('ndOptcgCreate').style.display = '';
  $('ndCyberpunkCreate').style.display = 'none';
  if (window.cpResetCreate) window.cpResetCreate();
  $('ndOverlay').style.display = '';
  $('leaderSearch').focus();
}

export function closeNewDeck() {
  $('ndOverlay').style.display = 'none';
  $('leaderResults').innerHTML = '';
  $('leaderSearch').value = '';
  $('ndImport').value = '';
  $('newDeckError').textContent = '';
  if (window.cpResetCreate) window.cpResetCreate();
}

async function loadDecks() {
  const grid = $('decksGrid');
  grid.innerHTML = '';

  // The add tile always leads the grid, leader-card sized.
  const add = document.createElement('li');
  add.className = 'deck-tile add-deck-tile';
  add.title = 'New deck';
  add.innerHTML = '<span aria-hidden="true">+</span>';
  add.setAttribute('role', 'button');
  add.setAttribute('aria-label', 'New deck');
  add.addEventListener('click', openNewDeck);
  grid.appendChild(add);

  const { data: owned, error } = await window.sb
    .from('decks')
    .select('id, name, leader_card_code, is_public, listing_type, format, created_at, updated_at')
    .eq('user_id', state.user.id)
    .order('updated_at', { ascending: false });
  if (error) { $('decksCount').textContent = error.message; return; }

  // Decks shared WITH me (I co-edit a partner's deck) list after my own.
  const { data: sharedRaw } = await window.sb.rpc('shared_decks');
  const shared = (sharedRaw || []).map(d => ({ ...d, _shared: true }));
  const decks = [...(owned || []), ...shared];

  if (decks.length === 0) {
    $('decksCount').textContent = 'No decks yet — tap + to start building.';
    return;
  }
  $('decksCount').textContent = `${decks.length} deck${decks.length === 1 ? '' : 's'}`;

  const artOf = (d) => localStorage.getItem(artKey(d.id));
  const codes = [...new Set(decks.flatMap(d => [d.leader_card_code, artOf(d)].filter(Boolean)))];
  // No game filter: codes are prefix-disjoint across games (OP…/ST…/cb-…),
  // so this returns the right leader/legend art for decks of any TCG.
  const { data: leaders } = await window.sb
    .from('cards').select('card_code,name,color,image_url').in('card_code', codes);
  const leaderMap = {};
  (leaders || []).forEach(c => { leaderMap[c.card_code] = c; });

  // Validity per deck via the server RPC (cheap at <=5 decks)
  const validity = await Promise.all(decks.map(d =>
    window.sb.rpc('deck_validity', { p_deck_id: d.id }).then(r => r.data).catch(() => null)));

  // Show "Cooking" decks (not yet valid + fully owned) before finished "valid"
  // decks; within each group keep the most-recently-edited order from the query
  // (Array.sort is stable).
  const done = (v) => !!(v && v.valid && v.owned_complete);
  const items = decks.map((d, i) => ({ d, v: validity[i] || {} }))
    .sort((a, b) => Number(done(a.v)) - Number(done(b.v)));

  items.forEach(({ d, v }) => {
    const L = leaderMap[artOf(d)] || leaderMap[d.leader_card_code] || {};
    const li = document.createElement('li');
    li.className = 'deck-tile';
    li.innerHTML = `
      <a href="#" data-deck="${d.id}">
        <img src="${esc(L.image_url || '')}" alt="">
        <div class="deck-tile-body">
          <div class="deck-tile-name">${esc(d.name)}</div>
          <div class="deck-tile-meta">
            ${(v.valid && v.owned_complete)
              ? '<span class="deck-badge ok">valid</span>'
              : '<span class="deck-badge bad">Cooking</span>'}
            ${d.format === 'eternal' ? '<span class="deck-badge etern">eternal</span>' : ''}
            ${d.is_public ? `<span class="deck-badge pub">${esc(d.listing_type || 'public')}</span>` : ''}
            ${d._shared ? '<span class="deck-badge">Shared</span>' : ''}
          </div>
        </div>
      </a>`;
    li.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); openDeck(d.id, true); });
    grid.appendChild(li);
  });
}

async function searchLeaders() {
  const q = $('leaderSearch').value.trim();
  const out = $('leaderResults');
  if (q.length < 2) { out.innerHTML = ''; return; }
  const { data } = await window.sb
    .from('cards')
    .select('card_code,name,color,image_url')
    .eq('game', GAME).eq('type', 'LEADER')
    .or(`name.ilike.%${q}%,card_code.ilike.%${q}%`)
    .order('release_order', { ascending: false })
    .limit(60);
  const fmt = pillValue('ndFormat') || 'standard';
  const rows = (data || []).filter(c =>
    isBase(c.card_code) && capFor(c.card_code) !== 0 &&
    (fmt !== 'standard' || standardLegal(c.card_code))).slice(0, 20);
  out.innerHTML = rows.length ? '' : '<li style="cursor:default;opacity:.6;">No leaders found.</li>';
  rows.forEach(c => {
    const li = document.createElement('li');
    li.innerHTML = `<img src="${esc(c.image_url || '')}" alt=""><div class="row-main">
      <div class="row-name">${esc(c.name)}</div>
      <div class="row-sub">${esc(c.card_code)} · ${esc(c.color || '')}</div></div>`;
    li.addEventListener('click', () => createDeck(c));
    out.appendChild(li);
  });
}

async function createDeck(leader) {
  const errEl = $('newDeckError');
  errEl.textContent = '';

  // Optional pasted decklist: validate fully BEFORE creating the deck.
  const text = $('ndImport').value.trim();
  let listRows = null, listInfo = null;
  if (text) {
    const { rows, errors } = parseDecklist(text);
    if (errors.length) { errEl.textContent = 'Bad lines — ' + errors.slice(0, 3).join('; '); return; }
    listInfo = await lookupCards([...rows.keys()]);
    const missing = [...rows.keys()].filter(c => !listInfo[c]);
    if (missing.length) { errEl.textContent = 'Unknown card(s): ' + missing.join(', '); return; }
    for (const code of [...rows.keys()]) {
      if (listInfo[code].type !== 'LEADER') continue;
      if (code !== baseCode(leader.card_code)) {
        errEl.textContent = `This list is led by ${listInfo[code].name} (${code}) — pick that leader instead.`;
        return;
      }
      rows.delete(code); // leader line matches the picked leader
    }
    listRows = rows;
  }

  const { data, error } = await window.sb
    .from('decks')
    .insert({ user_id: state.user.id, game: GAME, leader_card_code: leader.card_code,
              name: `${leader.color ? colorAbbrev(leader.color) + ' ' : ''}${leader.name} Deck`,
              format: pillValue('ndFormat') || 'standard' })
    .select('id').single();
  if (error) {
    if (error.code === '23505' && /one_deck_per_leader/.test(error.message || '')) {
      errEl.textContent = `You already have a deck for ${leader.name} — only one deck per leader.`;
    } else {
      errEl.textContent = error.message; // includes the friendly deck-limit trigger message
    }
    return;
  }

  const fails = [];
  if (listRows) {
    for (const [code, qty] of listRows) {
      state.cardInfo[code] = listInfo[code];
      const { error: e2 } = await window.sb.from('deck_cards')
        .insert({ deck_id: data.id, card_code: code, quantity: qty });
      if (e2) fails.push(`${code}: ${e2.message}`);
    }
  }
  closeNewDeck();
  await openDeck(data.id, true);
  if (fails.length) $('edError').textContent = `${fails.length} line(s) rejected — ${fails.slice(0, 3).join('; ')}`;
}

// ---------------- deck editor ----------------

export function showList(fromPop = false) {
  if (!fromPop) history.replaceState(null, '', 'decks.html');
  unsubscribeDeckCards();        // drop the editor's Realtime channel
  $('editorWrap').style.display = 'none';
  $('cpEditorWrap').style.display = 'none';   // hide any registered TCG-module editor
  $('decksWrap').style.display = '';
  state.deck = null;
  loadDecks();
}

// push=true when the user navigates list -> editor (so browser Back
// returns to the list); deep links and popstate restores replace instead.
export async function openDeck(deckId, push = false) {
  const seq = ++state.openSeq;
  // Clear the previous deck's cards up front so a slow load never flashes the
  // old deck while the new one is still fetching.
  state.deckCards = [];
  state.bench = [];
  $('edDeckGrid').innerHTML = '';
  $('edBenchGrid').innerHTML = '';
  $('edBenchSection').style.display = 'none';
  $('edBenchBtn').setAttribute('aria-expanded', 'false');
  const { data: d, error } = await window.sb.from('decks').select('*').eq('id', deckId).single();
  if (seq !== state.openSeq) return;             // a newer openDeck() superseded this one
  if (error || !d) { showList(); return; } // stale/foreign id (e.g. old link) -> list
  state.deck = d;

  // TCG-module dispatch: a non-default game (e.g. cyberpunk) has its own
  // self-contained editor. One Piece has no module → falls through to the
  // unchanged code below, so it can never regress when a game is added.
  const mod = DECK_MODULES[d.game];
  if (mod) {
    const murl = `decks.html?deck=${d.id}`;
    if (push) history.pushState(null, '', murl); else history.replaceState(null, '', murl);
    unsubscribeDeckCards();
    $('decksWrap').style.display = 'none';
    $('editorWrap').style.display = 'none';
    return mod.open(d, seq);
  }

  state.isDeckOwner = (d.user_id === state.user.id);   // collaborators co-edit but can't publish/delete
  // Owner-only controls: publishing and deleting stay with the deck owner.
  $('edEyeBtn').closest('.eye-wrap').style.display = state.isDeckOwner ? '' : 'none';
  $('edDeleteBtn').style.display = state.isDeckOwner ? '' : 'none';
  setupDeckCollab();
  const url = `decks.html?deck=${d.id}`; // survives hard refresh
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
  const { data: L } = await window.sb
    // types + attribute are needed to evaluate gated-searcher conditions
    // ("If your Leader has the {X} type / <Y> attribute") in the stats panel.
    .from('cards').select('card_code,name,color,cost,life,image_url,image_url_lg,types,attribute')
    .eq('game', GAME).eq('card_code', d.leader_card_code).single();
  if (seq !== state.openSeq) return;             // superseded while fetching the leader
  state.leaderCard = L;

  // Alt arts: the base print plus its _p variants (same card number).
  const { data: arts } = await window.sb
    .from('cards').select('card_code,image_url,image_url_lg')
    .eq('game', GAME).like('card_code', d.leader_card_code + '%');
  const artRe = new RegExp(`^${d.leader_card_code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_p\\d+)?$`, 'i');
  state.leaderArts = (arts || []).filter(c => artRe.test(c.card_code))
    .sort((a, b) => a.card_code.localeCompare(b.card_code));
  const savedArt = localStorage.getItem(artKey(d.id));
  state.artIdx = Math.max(0, state.leaderArts.findIndex(c => c.card_code === savedArt));
  $('edArtBtn').style.display = state.leaderArts.length > 1 ? '' : 'none';
  applyLeaderArt();

  $('decksWrap').style.display = 'none';
  $('editorWrap').style.display = '';
  $('edDeckName').value = d.name;
  setPill('edFormat', d.format || 'standard');
  $('edPublishOpts').style.display = 'none';
  $('edError').textContent = '';

  // Tile display art: explicit arrow choices (per-user, localStorage) beat
  // the art_mix majority print; print images are fetched with printInfo.
  state.cardArt = {};
  state.artOverride = {};
  try { state.artOverride = JSON.parse(localStorage.getItem(cardArtKey(d.id)) || '{}') || {}; } catch (e) {}

  if (seq !== state.openSeq) return;
  await loadOwnedElsewhere();
  if (seq !== state.openSeq) return;
  await reloadDeckCards();
  if (seq !== state.openSeq) return;
  await loadBench();
  subscribeDeckCardsRealtime();  // live co-edit for shared decks
}

// ---- Shared decks: live co-edit via Realtime. A partner's deck-card
// change refreshes this editor instantly. Events are ignored while a LOCAL
// edit burst is in flight (dcPending > 0) — queueDeckWrite's settle already
// re-reads the authoritative state — so live sync never clobbers optimistic
// edits mid-burst. Requires public.deck_cards in the Realtime publication
// (scripts/realtime_migration.sql). ----
let deckCardsChannel = null;
let deckReloadTimer = null;
function subscribeDeckCardsRealtime() {
  if (!window.sb || !window.sb.channel || !state.deck) return;
  unsubscribeDeckCards();
  const myId = state.deck.id;
  deckCardsChannel = window.sb
    .channel('deckcards-' + myId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'deck_cards', filter: 'deck_id=eq.' + myId },
      () => {
        if (state.dcPending > 0) return;             // local burst in flight; settle reconciles
        if (!state.deck || state.deck.id !== myId) return; // switched decks
        clearTimeout(deckReloadTimer);
        deckReloadTimer = setTimeout(() => {
          if (state.dcPending === 0 && state.deck && state.deck.id === myId) reloadDeckCards();
        }, 300);
      })
    .subscribe();
}
function unsubscribeDeckCards() {
  if (deckReloadTimer) { clearTimeout(deckReloadTimer); deckReloadTimer = null; }
  if (deckCardsChannel) { try { window.sb.removeChannel(deckCardsChannel); } catch (e) {} deckCardsChannel = null; }
}

// ---- Shared decks: invite/manage the partner (couples) ----
// A deck can only be shared with the partner you co-own a trade binder with
// for this game; share_deck targets them automatically (no name to type).
function setupDeckCollab() {
  const el = $('edCollab');
  if (!el) return;
  el.style.display = '';

  const refresh = async () => {
    if (!state.isDeckOwner) {
      el.innerHTML = `<div class="collab-row"><span class="collab-label">Shared deck</span> <span class="collab-none">you're a co-editor</span></div>`;
      return;
    }
    // Accepted collaborator(s) take priority; otherwise surface a still-pending
    // invite so the owner sees who they invited in place of the "+ Add" button.
    const [{ data: collabs }, { data: pending }] = await Promise.all([
      window.sb.rpc('deck_collaborators_list', { p_deck_id: state.deck.id }),
      window.sb.rpc('deck_pending_invite', { p_deck_id: state.deck.id }),
    ]);
    const list = collabs || [];
    const invite = (pending && pending[0]) || null;

    let body;
    if (list.length) {
      // One partner per deck — an accepted co-editor; offer removal only.
      body = list.map(c =>
        `<span class="collab-chip">${esc(c.display_name || 'partner')}<button class="collab-remove" data-uid="${c.user_id}" title="Remove" aria-label="Remove">×</button></span>`).join('');
    } else if (invite) {
      // Shared, awaiting acceptance — show the invited partner's name with a ×
      // to rescind the pending invite.
      body = `<span class="collab-chip">${esc(invite.display_name || 'partner')} <span style="opacity:.65;font-size:.82em;font-style:italic;">pending</span><button class="collab-remove" data-rescind="1" title="Cancel invite" aria-label="Cancel invite">×</button></span>`;
    } else {
      body = `<button class="btn small" id="deckShareBtn" type="button">+ Add partner</button>`;
    }
    el.innerHTML = `
      <div class="collab-row">
        <span class="collab-label">Share with</span>
        ${body}
      </div>
      <p class="auth-error" id="deckCollabError"></p>`;
    const addEl = $('deckShareBtn');
    if (addEl) addEl.addEventListener('click', shareDeck);
    el.querySelectorAll('.collab-remove').forEach(b =>
      b.addEventListener('click', () => b.dataset.rescind ? rescindInvite() : unshareDeck(b.dataset.uid)));
  };

  const shareDeck = async () => {
    const errEl = $('deckCollabError');
    if (errEl) { errEl.textContent = ''; errEl.style.color = ''; }
    // Prefill the box with your trade-binder partner for this game — the only
    // account a deck can be shared with. Editable; OK confirms. Empty when no
    // trade binder is shared yet (share_deck then raises a helpful error).
    let suggested = '';
    const { data: tp } = await window.sb.rpc('deck_trade_partner', { p_deck_id: state.deck.id });
    if (tp && tp[0]) suggested = tp[0].display_name || '';
    const name = prompt("Share this deck with your trade-binder partner. They'll get a notification to accept.", suggested);
    if (name === null || !name.trim()) return;
    const { error } = await window.sb.rpc('share_deck', { p_deck_id: state.deck.id, p_display_name: name.trim() });
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    await refresh();
    const e2 = $('deckCollabError');
    if (e2) { e2.style.color = '#7ec96a'; e2.textContent = `Invite sent to ${name.trim()} — they'll get a notification to accept.`; }
  };
  const rescindInvite = async () => {
    if (!confirm('Cancel the pending invite?')) return;
    const { error } = await window.sb.rpc('rescind_deck_invite', { p_deck_id: state.deck.id });
    const errEl = $('deckCollabError');
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    refresh();
  };
  const unshareDeck = async (uid) => {
    if (!confirm('Remove your partner from this deck?')) return;
    const { error } = await window.sb.rpc('unshare_deck', { p_deck_id: state.deck.id, p_user_id: uid });
    const errEl = $('deckCollabError');
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    refresh();
  };

  refresh();
}

// Fetch image rows for every print referenced by art_mix or an arrow override.
async function ensurePrintInfo() {
  const want = new Set();
  state.deckCards.forEach(r => {
    Object.keys(artMixOf(r)).forEach(k => { if (!state.printInfo[k]) want.add(k); });
    const ov = state.artOverride[r.card_code];
    if (ov && ov !== r.card_code && !state.printInfo[ov]) want.add(ov);
  });
  if (!want.size) return;
  const { data } = await window.sb.from('cards')
    .select('card_code,image_url,image_url_lg').eq('game', GAME).in('card_code', [...want]);
  (data || []).forEach(p => { state.printInfo[p.card_code] = p; });
}
function persistArtOverride() {
  if (state.DEMO || !state.deck) return;
  try { localStorage.setItem(cardArtKey(state.deck.id), JSON.stringify(state.artOverride)); } catch (e) {}
}
// Derive each tile's display print: an explicit arrow choice (including
// "base") wins; otherwise the art_mix print with the most copies (ties to base).
function rebuildCardArt() {
  state.cardArt = {};
  state.deckCards.forEach(r => {
    const ov = state.artOverride[r.card_code];
    if (ov) {
      if (ov !== r.card_code && state.printInfo[ov]) state.cardArt[r.card_code] = state.printInfo[ov];
      return;
    }
    const mix = artMixOf(r);
    let bestCode = null, bestN = r.quantity - altCountOf(r); // base copy count
    Object.keys(mix).sort().forEach(k => { if (mix[k] > bestN) { bestN = mix[k]; bestCode = k; } });
    if (bestCode && state.printInfo[bestCode]) state.cardArt[r.card_code] = state.printInfo[bestCode];
  });
}

function applyLeaderArt() {
  const art = state.leaderArts[state.artIdx] || state.leaderCard || {};
  $('edLeaderImg').src = art.image_url_lg || art.image_url || '';
}

function cycleLeaderArt() {
  if (state.leaderArts.length < 2 || !state.deck) return;
  state.artIdx = (state.artIdx + 1) % state.leaderArts.length;
  if (!state.DEMO) localStorage.setItem(artKey(state.deck.id), state.leaderArts[state.artIdx].card_code);
  applyLeaderArt();
}

// Cross-check against your collection: how many copies of each card you
// physically hold in your OTHER (non-wishlist) binders for this game. The
// wishlist binder is excluded — it's cards you WANT, not own. Built once per
// deck open and keyed by base code so alt-art prints (OP12-041_p1) count
// toward the same number the deck tracks.
async function loadOwnedElsewhere() {
  state.ownedElsewhere = {};
  if (!state.deck || !state.user) return;
  const { data: binders } = await window.sb
    .from('binders').select('id,name,flair')
    .eq('user_id', state.user.id).eq('category', GAME);
  const owned = (binders || []).filter(b => b.flair !== 'wishlist');
  if (!owned.length) return;
  const nameById = {};
  owned.forEach(b => { nameById[b.id] = b.name || 'Binder'; });
  const { data: rows } = await window.sb
    .from('listings').select('binder_id,card_code,quantity')
    .in('binder_id', owned.map(b => b.id));
  (rows || []).forEach(r => {
    const base = baseCode(r.card_code);
    const e = state.ownedElsewhere[base] || (state.ownedElsewhere[base] = { qty: 0, binders: [] });
    e.qty += r.quantity || 0;
    const nm = nameById[r.binder_id];
    if (nm && !e.binders.includes(nm)) e.binders.push(nm);
  });
}

export async function reloadDeckCards() {
  const myId = state.deck && state.deck.id;          // the deck we're loading for
  let rows = null;
  if (state.ARTMIX_OK) {
    const res = await window.sb.from('deck_cards')
      .select('card_code,quantity,owned,art_mix').eq('deck_id', myId);
    if (res.error) state.ARTMIX_OK = false;    // pre-migration: column missing → feature stays dark
    else rows = res.data;
  }
  if (!rows) {
    const res = await window.sb.from('deck_cards')
      .select('card_code,quantity,owned').eq('deck_id', myId);
    rows = res.data;
  }
  if (!state.deck || state.deck.id !== myId) return; // deck switched mid-load — drop stale data
  state.deckCards = rows || [];
  const missing = state.deckCards.map(r => r.card_code).filter(c => !state.cardInfo[c]);
  if (missing.length) {
    const { data: cards } = await window.sb
      .from('cards').select('card_code,name,color,cost,type,image_url,image_url_lg,counter,effect_text,types')
      .eq('game', GAME).in('card_code', missing);
    (cards || []).forEach(c => { state.cardInfo[c.card_code] = c; });
  }
  if (!state.deck || state.deck.id !== myId) return; // re-check after the second await
  await ensurePrintInfo();
  if (!state.deck || state.deck.id !== myId) return;
  rebuildCardArt();
  renderDeck();
  refreshValidity();
  cardZoom.refresh();
}

// Deck contents: one tile per unique card with a x1..x4 / X quantity
// badge; tapping a tile opens the magnified view where qty/owned are edited.
let holdJustFired = 0; // timestamp guard so a hold's release click is ignored
let ownMode = false;   // toggled by clicking "N missing": card +/- edit owned, not qty

// ---- Hover-magnify: a translucent magnifier overlays each card tile on
// hover; clicking it opens a full-size lightbox (Esc / click to close). ----
const ZOOM_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
export function zoomBtnHTML() {
  return `<span class="card-act card-zoom" role="button" aria-label="Enlarge card">${ZOOM_ICON}</span>`;
}
export const cardZoom = (() => {
  // Swap-arrows icon: cycles which print the BIG image shows (preview only —
  // per-copy composition is edited in the fan below).
  const ART_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
  let ov = null;
  let code = null;   // card currently magnified
  let arts = [];     // base print + its _p alt-art variants
  let artIdx = 0;    // print the big image currently shows
  let zone = 'deck'; // 'deck' | 'bench' — which list the magnified card edits
  const artsCache = {};
  function hide() {
    if (ov) { ov.hidden = true; code = null; arts = []; artIdx = 0; ov.querySelector('.cz-img').src = ''; }
  }
  // Qty/Owned steppers for a deck card — same markup + handlers as the inline
  // editor, so hold-to-jump and the cap/owned rules carry over verbatim.
  function editHTML(r) {
    const cap = capFor(r.card_code);
    return `
      <div class="cz-name">${esc(r.card_code)}</div>
      <div class="cz-steppers">
        <div>
          <span class="stepper-label">Qty</span>
          <div class="stepper" data-kind="qty">
            <button data-d="-1">−</button><input class="cz-val" type="number" inputmode="numeric" data-kind="qty" value="${r.quantity}" min="0"${cap !== null ? ` max="${cap}"` : ''}><button data-d="1" ${cap !== null && r.quantity >= cap ? 'disabled' : ''}>+</button>
          </div>
        </div>
        <div>
          <span class="stepper-label">Owned</span>
          <div class="stepper ${r.owned >= r.quantity ? 'owned-full' : ''}" data-kind="owned">
            <button data-d="-1" ${r.owned <= 0 ? 'disabled' : ''}>−</button><input class="cz-val" type="number" inputmode="numeric" data-kind="owned" value="${r.owned}" min="0" max="${r.quantity}"><span class="cz-of">/ ${r.quantity}</span><button data-d="1" ${r.owned >= r.quantity ? 'disabled' : ''}>+</button>
          </div>
        </div>
      </div>`;
  }
  // Editor for a benched card — edit how many copies are benched (Qty) and how
  // many of those you own (Owned, surfaces the "send to trade binder" action).
  function benchEditHTML(b) {
    const owned = b.owned || 0;
    return `
      <div class="cz-name">${esc(b.code)} — benched</div>
      <div class="cz-steppers">
        <div>
          <span class="stepper-label">Qty</span>
          <div class="stepper" data-kind="qty">
            <button data-d="-1">−</button><input class="cz-val" type="number" inputmode="numeric" data-kind="qty" value="${b.qty}" min="0"><button data-d="1">+</button>
          </div>
        </div>
        <div>
          <span class="stepper-label">Owned</span>
          <div class="stepper ${owned >= b.qty ? 'owned-full' : ''}" data-kind="owned">
            <button data-d="-1" ${owned <= 0 ? 'disabled' : ''}>−</button><input class="cz-val" type="number" inputmode="numeric" data-kind="owned" value="${owned}" min="0" max="${b.qty}"><span class="cz-of">/ ${b.qty}</span><button data-d="1" ${owned >= b.qty ? 'disabled' : ''}>+</button>
          </div>
        </div>
      </div>`;
  }
  function setBenchOwned(c, value) {
    const b = state.bench.find(x => x.code === c);
    if (!b) return;
    const v = Math.max(0, Math.min(b.qty, isNaN(value) ? b.owned : value));
    if (v === b.owned) return;
    b.owned = v;
    saveBench(); renderBench();
    renderEdit(); // refresh stepper state (disabled buttons / owned-full)
  }
  function setBenchQty(c, value) {
    const b = state.bench.find(x => x.code === c);
    if (!b) return;
    const v = Math.max(0, isNaN(value) ? b.qty : value);
    if (v === b.qty) return;
    if (v === 0) { benchRemove(c); hide(); return; } // emptied → drop it + close
    b.qty = v;
    if (b.owned > v) b.owned = v; // owned can't exceed quantity
    saveBench(); renderBench();
    renderEdit(); // re-render so Owned's max + the ×qty reflect the new total
  }
  function renderEdit() {
    const box = ov.querySelector('.cz-edit');
    if (zone === 'bench') {
      const b = code ? state.bench.find(x => x.code === code) : null;
      if (!b) { box.innerHTML = ''; box.style.display = 'none'; return; }
      box.style.display = '';
      box.innerHTML = benchEditHTML(b);
      box.querySelectorAll('.stepper button').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const kind = btn.closest('.stepper').dataset.kind;
          const d = parseInt(btn.dataset.d, 10);
          const cur = state.bench.find(x => x.code === b.code) || {};
          if (kind === 'qty') setBenchQty(b.code, (cur.qty || 0) + d);
          else setBenchOwned(b.code, (cur.owned || 0) + d);
        });
      });
      box.querySelectorAll('.cz-val').forEach(inp => {
        const apply = () => {
          const v = parseInt(inp.value, 10);
          if (inp.dataset.kind === 'qty') setBenchQty(b.code, v);
          else setBenchOwned(b.code, v);
        };
        inp.addEventListener('change', apply);
        inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
      });
      return;
    }
    const r = code ? state.deckCards.find(x => x.card_code === code) : null;
    if (!r) { box.innerHTML = ''; box.style.display = 'none'; return; } // not a deck card → image only
    box.style.display = '';
    box.innerHTML = editHTML(r);
    box.querySelectorAll('.stepper button').forEach(btn => wireStepper(btn, r.card_code));
    // Type a number for a quick set (commit on Enter or blur).
    box.querySelectorAll('.cz-val').forEach(inp => {
      inp.addEventListener('change', () => setCardAbsolute(r.card_code, inp.dataset.kind, inp.value));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
    });
  }
  // Per-copy fan: one mini card per physical copy, fanned like a hand of
  // cards. Tapping a copy cycles it through the card's prints (base → alts);
  // gold edge = alt-art copy. Composition persists in deck_cards.art_mix.
  function copiesOf(r) {
    const mix = artMixOf(r);
    const out = [];
    Object.keys(mix).sort().forEach(k => {
      for (let i = 0; i < mix[k] && out.length < r.quantity; i++) out.push(k);
    });
    while (out.length < r.quantity) out.unshift(r.card_code); // base copies lead
    return out;
  }
  function renderFan() {
    if (!ov) return;
    const box = ov.querySelector('.cz-fan');
    const pipBox = ov.querySelector('.cz-pips');
    box.innerHTML = '';
    pipBox.innerHTML = '';
    const r = (zone === 'deck' && code) ? state.deckCards.find(x => x.card_code === code) : null;
    const usable = r && arts.length > 1 && r.quantity >= 1 && r.quantity <= 8 && (state.DEMO || state.ARTMIX_OK);
    box.hidden = !usable;
    pipBox.hidden = !usable;
    if (!usable) return;
    const copies = copiesOf(r);
    // Dots mirror the fan copy-for-copy: gold = alt-art copy, hollow = base.
    copies.forEach(pc => {
      const s = document.createElement('span');
      s.className = 'cz-pip ' + (pc !== r.card_code ? 'alt' : 'base');
      pipBox.appendChild(s);
    });
    const mid = (copies.length - 1) / 2;
    const spread = copies.length > 5 ? 4 : 7;
    copies.forEach((printCode, i) => {
      const a = arts.find(x => x.card_code === printCode) || arts[0];
      const d = document.createElement('div');
      d.className = 'cz-fan-card' + (printCode !== r.card_code ? ' alt' : '');
      d.style.setProperty('--fan-rot', ((i - mid) * spread).toFixed(1) + 'deg');
      d.style.setProperty('--fan-lift', (Math.abs(i - mid) * Math.abs(i - mid) * 3).toFixed(1) + 'px');
      d.style.backgroundImage = `url("${(a && a.image_url) || ''}")`;
      d.title = printCode;
      d.setAttribute('role', 'button');
      d.setAttribute('aria-label', printCode);
      d.addEventListener('click', (e) => {
        e.stopPropagation();
        const cur = arts.findIndex(x => x.card_code === printCode);
        copies[i] = arts[(Math.max(0, cur) + 1) % arts.length].card_code;
        const mix = {};
        copies.forEach(c => { if (c !== r.card_code) mix[c] = (mix[c] || 0) + 1; });
        setArtMix(r.card_code, mix);
      });
      box.appendChild(d);
    });
  }
  // Big-image art swap: cycles the large image through the card's prints and
  // KEEPS the choice on the deck-grid tile (explicit pick beats the art_mix
  // majority; per-user, localStorage). Composition itself lives in the fan.
  function applyArt() {
    if (!ov) return;
    const a = arts[artIdx];
    if (a) ov.querySelector('.cz-img').src = a.image_url_lg || a.image_url || '';
    ov.querySelector('.cz-art').hidden = arts.length < 2; // only when alts exist
  }
  function cycleArt() {
    if (arts.length < 2) return;
    artIdx = (artIdx + 1) % arts.length;
    applyArt();
    const a = arts[artIdx];
    if (zone !== 'deck' || !code || !a) return;
    const r = state.deckCards.find(x => x.card_code === code);
    if (!r) return;
    if (!isBase(a.card_code)) state.printInfo[a.card_code] = a;
    state.artOverride[r.card_code] = a.card_code;
    persistArtOverride();
    rebuildCardArt();
    renderDeck();
  }
  // Base print + _p variants for a card number (cached per session).
  async function loadArts(base) {
    if (artsCache[base]) return artsCache[base];
    const { data } = await window.sb.from('cards')
      .select('card_code,image_url,image_url_lg')
      .eq('game', GAME).like('card_code', base + '%');
    const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_p\\d+)?$`, 'i');
    const list = (data || []).filter(x => re.test(x.card_code)).sort((a, b) => a.card_code.localeCompare(b.card_code));
    artsCache[base] = list;
    return list;
  }
  function ensure() {
    if (ov) return ov;
    ov = document.createElement('div');
    ov.className = 'card-zoom-overlay';
    ov.hidden = true;
    ov.innerHTML = '<div class="cz-box"><div class="cz-imgwrap"><img class="cz-img" alt=""><span class="cz-art" role="button" aria-label="Swap art" hidden>' + ART_ICON + '</span></div><div class="cz-fan" hidden></div><div class="cz-pips" hidden></div><div class="cz-edit"></div></div>';
    ov.addEventListener('click', e => { if (e.target === ov) hide(); }); // backdrop only
    ov.querySelector('.cz-art').addEventListener('click', e => { e.stopPropagation(); cycleArt(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
    document.body.appendChild(ov);
    return ov;
  }
  async function show(c, opts) {
    zone = (opts && opts.zone) || 'deck';
    const base = String(c.card_code).split('_')[0];
    const override = state.cardArt[base]; // open on the tile's display print, if any
    const url = (override && (override.image_url_lg || override.image_url)) || (c && (c.image_url_lg || c.image_url));
    if (!url) return;
    const el = ensure();
    code = c.card_code;
    arts = []; artIdx = 0;
    el.querySelector('.cz-img').src = url;
    el.querySelector('.cz-art').hidden = true;
    el.querySelector('.cz-fan').hidden = true;
    el.querySelector('.cz-pips').hidden = true;
    renderEdit();
    el.hidden = false;
    // Reveal the swap arrows + per-copy fan once alt prints exist.
    const list = await loadArts(base);
    if (code !== c.card_code) return; // another card opened during the await
    arts = list;
    list.forEach(a => { if (!isBase(a.card_code)) state.printInfo[a.card_code] = a; });
    const shown = override ? override.card_code : c.card_code;
    artIdx = Math.max(0, list.findIndex(a => a.card_code === shown));
    applyArt();
    renderFan();
  }
  // Keep the open lightbox in sync after a deck-cards reload; close it if the
  // magnified card was removed (qty stepped to 0).
  function refresh() {
    if (!ov || ov.hidden || !code) return;
    if (zone === 'bench') {
      if (!state.bench.find(x => x.code === code)) { hide(); return; }
      renderEdit();
      return;
    }
    if (!state.deckCards.find(x => x.card_code === code)) { hide(); return; }
    renderEdit();
    renderFan();
  }
  return { show, refresh };
})();

// Wire a tile's magnifier so it zooms without triggering the tile's own
// click (select in the deck grid / add in the browser).
export function wireZoom(tile, card) {
  const z = tile.querySelector('.card-zoom');
  if (z) z.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); cardZoom.show(card); });
}

function renderDeck() {
  const grid = $('edDeckGrid');
  grid.innerHTML = '';

  const sorted = state.deckCards.slice().sort(byCostThenCode);

  sorted.forEach(r => {
    const c = state.cardInfo[r.card_code] || {};
    const tile = document.createElement('div');
    tile.className = 'deck-card-tile'
      + (r.owned < r.quantity ? ' missing' : ''); // owned-short → highlightable
    tile.title = `${c.name || r.card_code} — ${r.quantity} in deck, ${r.owned} owned`;
    // Card +/- adjust quantity normally; in owned-edit mode (toggled by
    // clicking "N missing") they adjust how many copies you own instead.
    const cap = capFor(r.card_code);
    const kind = ownMode ? 'owned' : 'qty';
    const incBlocked = ownMode ? r.owned >= r.quantity : (cap !== null && r.quantity >= cap);
    const decBlocked = ownMode ? r.owned <= 0 : false; // qty − never blocked (deletes at 1)
    const decLabel = ownMode ? 'Own one fewer' : 'Remove one';
    const incLabel = ownMode ? 'Own one more' : 'Add one';
    const incTitle = ownMode ? 'All copies owned' : 'Max copies in deck';
    // Badge shows total qty normally; while highlighting missing the
    // owned-short tiles swap to their missing count (highlighted).
    const art = state.cardArt[r.card_code]; // chosen alt-art print (set in magnified view)
    // Collection cross-check: this card is owned-short in the deck but you
    // physically hold copies in a non-wishlist binder. Badge → click to mark
    // owned (bumps deck `owned` up to cover your binder count, never down).
    // Show the badge only when your collection has MORE copies than you've
    // already marked owned — otherwise clicking would be a no-op (it never
    // marks owned beyond what you physically hold).
    const oe = state.ownedElsewhere[r.card_code];
    const oeAvail = (r.owned < r.quantity && oe && oe.qty > r.owned) ? oe : null;
    const oeBadge = oeAvail
      ? `<span class="own-elsewhere" role="button" tabindex="0" title="You have ×${oeAvail.qty} in ${esc(oeAvail.binders.join(', '))} — click to mark owned">📦 ×${oeAvail.qty}</span>`
      : '';
    tile.innerHTML = `
      <img src="${esc((art && art.image_url) || c.image_url || '')}" alt="${esc(c.name || r.card_code)}">
      <div class="card-acts">
        <button class="card-act qty-dec${decBlocked ? ' at-cap' : ''}" aria-label="${decLabel}"${decBlocked ? ' aria-disabled="true" title="None owned"' : ''}>−</button>
        ${zoomBtnHTML()}
        <button class="card-act qty-inc${incBlocked ? ' at-cap' : ''}" aria-label="${incLabel}"${incBlocked ? ` aria-disabled="true" title="${incTitle}"` : ''}>+</button>
      </div>
      ${oeBadge}
      <span class="qty-badge">
        <span class="qty-total">${r.quantity > 4 ? 'X' : 'x' + r.quantity}</span>
        <span class="qty-missing">x${r.quantity - r.owned}</span>
      </span>`;
    // Tap a card to open the magnified view, where qty/owned are edited.
    tile.addEventListener('click', () => cardZoom.show(c));
    wireZoom(tile, c);
    // Inline ±1 on click; press-and-hold (~450ms) jumps to min/max — so in
    // owned-edit mode (after clicking "N missing") holding + sets owned to the
    // full deck quantity, and in qty mode it jumps to the copy cap.
    // stopPropagation keeps the tile's zoom click from firing.
    const wireTileBtn = (btn, delta, blocked) => {
      if (!btn) return;
      let timer = null;
      const cancelHold = () => { clearTimeout(timer); timer = null; };
      btn.addEventListener('pointerdown', () => {
        if (blocked) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
          holdJustFired = Date.now();
          setCardValue(r.card_code, kind, delta < 0 ? 'min' : 'max');
        }, 450);
      });
      btn.addEventListener('pointerup', cancelHold);
      btn.addEventListener('pointerleave', cancelHold);
      btn.addEventListener('contextmenu', e => e.preventDefault()); // mobile long-press menu
      btn.addEventListener('click', e => {
        e.stopPropagation();
        if (Date.now() - holdJustFired < 600) { e.preventDefault(); return; } // released after a hold
        if (blocked) return;
        stepCard(r.card_code, kind, delta);
      });
    };
    wireTileBtn(tile.querySelector('.qty-dec'), -1, decBlocked);
    wireTileBtn(tile.querySelector('.qty-inc'),  1, incBlocked);
    if (oeAvail) {
      const reconcile = e => {
        e.stopPropagation(); e.preventDefault();
        setCardAbsolute(r.card_code, 'owned', Math.min(r.quantity, Math.max(r.owned, oeAvail.qty)));
      };
      const oeEl = tile.querySelector('.own-elsewhere');
      oeEl.addEventListener('click', reconcile);
      oeEl.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') reconcile(e); });
    }
    makeDragHandle(tile, 'deck', r.card_code);
    wireDeckDropTarget(tile, r.card_code);
    grid.appendChild(tile);
  });

  // Static 5-wide grid, minimum 3 rows: pad with empty slots to a full row.
  const padTo = Math.max(15, Math.ceil(sorted.length / 5) * 5);
  for (let i = sorted.length; i < padTo; i++) {
    const ph = document.createElement('div');
    ph.className = 'deck-card-tile empty-slot';
    grid.appendChild(ph);
  }
}

// Click = ±1; press-and-hold (~450ms) jumps to min/max.
function wireStepper(btn, code) {
  const kind = btn.closest('.stepper').dataset.kind;
  const delta = parseInt(btn.dataset.d, 10);
  let timer = null;
  const startHold = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      holdJustFired = Date.now();
      setCardValue(code, kind, delta < 0 ? 'min' : 'max');
    }, 450);
  };
  const cancelHold = () => { clearTimeout(timer); timer = null; };
  btn.addEventListener('pointerdown', startHold);
  btn.addEventListener('pointerup', cancelHold);
  btn.addEventListener('pointerleave', cancelHold);
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // mobile long-press menu
  btn.addEventListener('click', (e) => {
    if (Date.now() - holdJustFired < 600) { e.preventDefault(); return; } // released after a hold
    stepCard(code, kind, delta);
  });
}

// ---- Serialized deck-card writes ----
// Every deck_cards mutation updates the local cache optimistically (instant
// feedback) and queues its DB write so fast repeated clicks can't race on a
// stale read — which previously lost increments or dropped duplicate inserts.
// Each queued writer re-reads the live row, so deltas accumulate correctly.
// One reconcile fetch runs once the burst settles (also rolling back anything
// the gatekeeper trigger rejected).
let dcQueue = Promise.resolve();
export function queueDeckWrite(writer) {
  if (state.DEMO) { refreshValidity(); return; }  // demo: local-only, never touch the DB
  state.dcPending++;
  const settle = () => { if (--state.dcPending === 0) reloadDeckCards().then(renderBrowser); };
  dcQueue = dcQueue.then(writer).then(settle, (e) => {
    const msg = (e && e.message) || 'Update failed.';
    $('cbError').textContent = msg;
    $('edError').textContent = msg;
    settle();
  });
}
export function renderDeckLocal() { renderDeck(); renderBrowser(); cardZoom.refresh(); }
// Persist a card's per-copy art composition (alt print code -> copies).
function setArtMix(code, mix) {
  const row = state.deckCards.find(r => r.card_code === code);
  if (!row) return;
  row.art_mix = mix;
  rebuildCardArt();
  renderDeckLocal();
  queueDeckWrite(async () => {
    const { error } = await window.sb.from('deck_cards')
      .update({ art_mix: mix }).eq('deck_id', state.deck.id).eq('card_code', code);
    if (error) throw error;
  });
}
export function localSetRow(code, fields) {
  const row = state.deckCards.find(r => r.card_code === code);
  if (row) Object.assign(row, fields);
  renderDeckLocal();
}
export function localRemoveRow(code) {
  const i = state.deckCards.findIndex(r => r.card_code === code);
  if (i >= 0) state.deckCards.splice(i, 1);
  renderDeckLocal();
}
export async function readDeckCard(code) {
  const { data } = await window.sb.from('deck_cards').select('quantity, owned')
    .eq('deck_id', state.deck.id).eq('card_code', code).maybeSingle();
  return data;
}

function stepCard(code, kind, delta) {
  const row = state.deckCards.find(r => r.card_code === code);
  if (!row) return;
  $('edError').textContent = '';
  if (kind === 'qty') {
    // Every minus sets the removed copy aside in the bench so it can be
    // disposed there. Owned copies leave last (owned can't exceed quantity),
    // so owned>=quantity means the removed copy is one you own — benched as
    // owned (→ can go to the trade binder); otherwise it's benched as a
    // not-owned/wishlist copy (→ delete only).
    if (delta < 0 && row.quantity > 0) {
      benchAdd(code, 1, row.owned >= row.quantity ? 1 : 0);
    }
    const nq = row.quantity + delta;
    if (nq <= 0) localRemoveRow(code);
    else localSetRow(code, { quantity: nq, owned: Math.min(row.owned, nq) });
    queueDeckWrite(async () => {
      const cur = await readDeckCard(code);
      if (!cur) return;
      const q = cur.quantity + delta;
      if (q <= 0) {
        const { error } = await window.sb.from('deck_cards').delete().eq('deck_id', state.deck.id).eq('card_code', code);
        if (error) throw error;
      } else {
        const { error } = await window.sb.from('deck_cards')
          .update({ quantity: q, owned: Math.min(cur.owned, q) }).eq('deck_id', state.deck.id).eq('card_code', code);
        if (error) throw error;
      }
    });
  } else {
    const no = Math.max(0, Math.min(row.quantity, row.owned + delta));
    localSetRow(code, { owned: no });
    queueDeckWrite(async () => {
      const cur = await readDeckCard(code);
      if (!cur) return;
      const o = Math.max(0, Math.min(cur.quantity, cur.owned + delta));
      const { error } = await window.sb.from('deck_cards')
        .update({ owned: o }).eq('deck_id', state.deck.id).eq('card_code', code);
      if (error) throw error;
    });
  }
}

// Hold-to-jump: qty min=1 / max=copy cap (50 if unlimited); owned min=0 /
// max=quantity. (Holding qty "-" stops at 1, never deletes the card.)
function setCardValue(code, kind, target) {
  const row = state.deckCards.find(r => r.card_code === code);
  if (!row) return;
  $('edError').textContent = '';
  if (kind === 'qty') {
    const cap = capFor(code);
    const q = target === 'min' ? 1 : (cap ?? 50);
    if (q === row.quantity) return;
    localSetRow(code, { quantity: q, owned: Math.min(row.owned, q) });
    queueDeckWrite(async () => {
      const cur = await readDeckCard(code);
      if (!cur) return;
      const { error } = await window.sb.from('deck_cards')
        .update({ quantity: q, owned: Math.min(cur.owned, q) }).eq('deck_id', state.deck.id).eq('card_code', code);
      if (error) throw error;
    });
  } else {
    const o = target === 'min' ? 0 : row.quantity;
    if (o === row.owned) return;
    localSetRow(code, { owned: o });
    queueDeckWrite(async () => {
      const cur = await readDeckCard(code);
      if (!cur) return;
      const oo = target === 'min' ? 0 : cur.quantity;
      const { error } = await window.sb.from('deck_cards')
        .update({ owned: oo }).eq('deck_id', state.deck.id).eq('card_code', code);
      if (error) throw error;
    });
  }
}

// Set an exact value from typed input (magnified-view qty/owned fields).
// qty: clamped to [0, cap] (0 removes the card); owned: clamped to [0, qty].
export function setCardAbsolute(code, kind, value) {
  const row = state.deckCards.find(r => r.card_code === code);
  if (!row) return;
  let n = parseInt(value, 10);
  if (isNaN(n)) return; // ignore non-numeric input
  $('edError').textContent = '';
  if (kind === 'qty') {
    const cap = capFor(code);
    n = Math.max(0, cap !== null ? Math.min(n, cap) : n);
    if (n === row.quantity) return;
    const target = n;
    if (target <= 0) localRemoveRow(code);
    else localSetRow(code, { quantity: target, owned: Math.min(row.owned, target) });
    queueDeckWrite(async () => {
      const cur = await readDeckCard(code);
      if (!cur) return;
      if (target <= 0) {
        const { error } = await window.sb.from('deck_cards').delete().eq('deck_id', state.deck.id).eq('card_code', code);
        if (error) throw error;
      } else {
        const { error } = await window.sb.from('deck_cards')
          .update({ quantity: target, owned: Math.min(cur.owned, target) }).eq('deck_id', state.deck.id).eq('card_code', code);
        if (error) throw error;
      }
    });
  } else {
    const target = Math.max(0, Math.min(row.quantity, n));
    if (target === row.owned) return;
    localSetRow(code, { owned: target });
    queueDeckWrite(async () => {
      const cur = await readDeckCard(code);
      if (!cur) return;
      const o = Math.max(0, Math.min(cur.quantity, target));
      const { error } = await window.sb.from('deck_cards')
        .update({ owned: o }).eq('deck_id', state.deck.id).eq('card_code', code);
      if (error) throw error;
    });
  }
}

async function refreshValidity() {
  const v = state.DEMO ? demoValidity() : (await window.sb.rpc('deck_validity', { p_deck_id: state.deck.id })).data;
  if (!v) return;
  state.deckValid = !!v.valid;
  const statsBtn = $('edStatsBtn');
  if (statsBtn) { statsBtn.disabled = !state.deckValid; statsBtn.title = state.deckValid ? '' : 'Deck must be valid (50 legal cards) before stats are available'; }
  const total = v.total_cards ?? 0;
  const miss = v.missing_cards ?? 0;
  if (!miss) ownMode = false; // nothing missing → leave owned-edit mode
  $('edCounts').innerHTML = `${total}/50 cards · ${v.owned_cards ?? 0} owned · `
    + `<span id="edMissingHover"${miss ? ' class="missing-hover"' : ''}>${miss} missing</span>`;
  const dg = $('edDeckGrid');
  // Clicking "N missing" keeps the same focus as hovering it (missing cards
  // highlighted, the rest greyed) and switches the card +/- to edit owned;
  // as copies become owned, those cards drop out of "missing" and grey out.
  dg.classList.toggle('show-missing', ownMode);
  if (miss) {
    const hov = $('edMissingHover');
    hov.classList.toggle('active', ownMode);
    hov.addEventListener('mouseenter', () => dg.classList.add('show-missing'));
    hov.addEventListener('mouseleave', () => { if (!ownMode) dg.classList.remove('show-missing'); });
    hov.addEventListener('click', () => {
      ownMode = !ownMode;
      dg.classList.toggle('show-missing', ownMode);
      hov.classList.toggle('active', ownMode);
      renderDeck();
    });
  }
  const badges = [];
  // "deck valid" reads warm orangish-green until fully owned, then full green.
  if (v.valid) badges.push(`<span class="deck-badge ${v.owned_complete ? 'ok' : 'partial'}">deck valid</span>`);
  if (v.owned_complete) badges.push('<span class="deck-badge ok">owned</span>');
  $('edBadges').innerHTML = badges.join(' ');

  syncPublishUi(v);
}

// Eye button + flair pill next to the deck name own the publish state.
// Why-not-publishable lives in the eye's hover tooltip.
function syncPublishUi(v) {
  const eye = $('edEyeBtn'), flair = $('edFlair');
  const publishable = !!(v.valid && v.owned_complete);
  if (state.deck.is_public) {
    eye.classList.add('public');
    eye.disabled = false;
    $('edEyeTip').textContent = 'Public — click to unpublish';
    flair.textContent = state.deck.listing_type || 'public';
    flair.style.display = '';
  } else {
    const reasons = Array.isArray(v.problems) ? v.problems.slice() : [];
    if (v.valid && !v.owned_complete) {
      reasons.push(`${v.missing_cards} card${v.missing_cards === 1 ? '' : 's'} not owned yet`);
    }
    eye.classList.remove('public');
    eye.disabled = !publishable;
    $('edEyeTip').textContent = publishable ? 'Make deck public'
                                            : `Not ready to publish — ${reasons.join(' · ')}`;
    flair.style.display = 'none';
    if (eye.disabled) $('edPublishOpts').style.display = 'none';
  }
  document.querySelectorAll('#edListingType .pill-choice-btn').forEach(b => {
    b.classList.toggle('active', state.deck.is_public && b.dataset.value === state.deck.listing_type);
  });
}

// Eye: private -> reveal the trade/sell/borrow options; public -> unpublish.
async function onEyeClick() {
  if (state.DEMO) return;
  $('edError').textContent = '';
  if (!state.deck.is_public) {
    const opts = $('edPublishOpts');
    opts.style.display = opts.style.display === 'none' ? '' : 'none';
    return;
  }
  const { error } = await window.sb.rpc('unpublish_deck', { p_deck_id: state.deck.id });
  if (error) { $('edError').textContent = error.message; return; }
  state.deck.is_public = false; state.deck.listing_type = null;
  $('edPublishOpts').style.display = 'none';
  refreshValidity();
}

// Picking a type publishes (or re-publishes) with it; server re-validates.
async function onListingTypeClick(e) {
  if (state.DEMO) return;
  const btn = e.target.closest('.pill-choice-btn');
  if (!btn || (state.deck.is_public && btn.dataset.value === state.deck.listing_type)) return;
  $('edError').textContent = '';
  const { error } = await window.sb.rpc('publish_deck', { p_deck_id: state.deck.id, p_listing_type: btn.dataset.value });
  if (error) { $('edError').textContent = error.message; refreshValidity(); return; }
  state.deck.is_public = true; state.deck.listing_type = btn.dataset.value;
  $('edPublishOpts').style.display = 'none';
  refreshValidity();
}

async function onFormatClick(e) {
  const btn = e.target.closest('.pill-choice-btn');
  if (!btn || !state.deck || btn.dataset.value === state.deck.format) return;
  if (state.DEMO) { state.deck.format = btn.dataset.value; return; }
  $('edError').textContent = '';
  const { error } = await window.sb.from('decks')
    .update({ format: btn.dataset.value }).eq('id', state.deck.id);
  if (error) { // e.g. eternal -> standard with rotated cards still in the deck
    setPill('edFormat', state.deck.format);
    $('edError').textContent = error.message;
    return;
  }
  state.deck.format = btn.dataset.value;
  refreshValidity();
  if ($('cbOverlay').style.display !== 'none') { ensureTraitPool(); loadBrowser(); } // legality changed
}

async function renameDeck() {
  if (state.DEMO) return;
  const name = $('edDeckName').value.trim();
  if (!name || !state.deck) return;
  const { error } = await window.sb.from('decks').update({ name }).eq('id', state.deck.id);
  if (error) $('edError').textContent = error.message;
  else state.deck.name = name;
}


async function deleteDeck() {
  if (state.DEMO) return;
  // Deck "owned" copies aren't tracked as binder listings, so they'd be lost
  // on delete. A single custom modal offers to move them to the trade binder
  // first (native confirm() chains get suppressed after the first dialog).
  const ownedRows = state.deckCards.filter(r => r.owned > 0);
  const ownedCopies = ownedRows.reduce((s, r) => s + r.owned, 0);

  const act = await confirmDeleteDeck(state.deck.name, ownedCopies);
  if (act === 'cancel') return;
  if (act === 'move') {
    const ok = await returnOwnedToCollection(ownedRows);
    if (!ok) return; // error surfaced; keep the deck so the cards aren't lost
  }

  const { error } = await window.sb.from('decks').delete().eq('id', state.deck.id);
  if (error) { $('edError').textContent = error.message; return; }
  showList();
}

// Custom delete-confirmation modal. Resolves to 'cancel' | 'delete' | 'move'.
// The "move to trade" choice only appears when the deck has owned copies.
function confirmDeleteDeck(name, ownedCopies) {
  return new Promise(resolve => {
    const owned = ownedCopies > 0;
    const back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:1000;background:rgba(8,6,14,.72);display:flex;align-items:center;justify-content:center;padding:1rem;';
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-card,#181622);border:1px solid var(--border,#3a3344);border-radius:12px;max-width:430px;width:100%;padding:1.4rem 1.5rem;';
    card.innerHTML = `
      <h3 style="margin:0 0 .55rem;font-family:var(--font-serif);font-size:1.15rem;">Delete “${esc(name)}”?</h3>
      <p style="margin:0 0 1.1rem;color:var(--text-secondary,#c4b9ad);font-size:.9rem;line-height:1.4;">This can’t be undone.${owned ? ` You’ve marked <strong>${ownedCopies}</strong> card${ownedCopies === 1 ? '' : 's'} as owned in this deck.` : ''}</p>
      <div style="display:flex;flex-direction:column;gap:.55rem;">
        ${owned ? `<button class="btn btn-filled" data-act="move">Move ${ownedCopies} owned to trade binder &amp; delete</button>` : ''}
        <button class="btn" data-act="delete" style="border-color:#d98a8a;color:#d98a8a;">Delete${owned ? ' without saving cards' : ' deck'}</button>
        <button class="btn" data-act="cancel">Cancel</button>
      </div>`;
    back.appendChild(card);
    document.body.appendChild(back);
    const done = (val) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
    const onKey = (e) => { if (e.key === 'Escape') done('cancel'); };
    document.addEventListener('keydown', onKey);
    back.addEventListener('click', e => { if (e.target === back) done('cancel'); });
    card.querySelectorAll('button[data-act]').forEach(b => b.addEventListener('click', () => done(b.dataset.act)));
  });
}

// Add each deck card's owned copies into the user's trade binder for this game
// (created if none exists), merging quantities into any existing listing for
// the same card. Returns false on error.
async function returnOwnedToCollection(ownedRows) {
  const { data: binders } = await window.sb.from('binders')
    .select('id,name,flair').eq('user_id', state.user.id).eq('category', GAME).eq('flair', 'trade');
  let target = (binders || [])[0];
  if (!target) {
    const { data: nb, error: ce } = await window.sb.from('binders')
      .insert({ user_id: state.user.id, name: 'Collection', category: GAME, flair: 'trade' })
      .select('id,name').single();
    if (ce) { $('edError').textContent = 'Could not create a trade binder: ' + ce.message; return false; }
    target = nb;
  }
  const codes = ownedRows.map(r => r.card_code);
  const { data: existing } = await window.sb.from('listings')
    .select('id,card_code,quantity').eq('binder_id', target.id).in('card_code', codes);
  const byCode = {};
  (existing || []).forEach(l => { byCode[l.card_code] = l; });
  for (const r of ownedRows) {
    const ex = byCode[r.card_code];
    const res = ex
      ? await window.sb.from('listings').update({ quantity: ex.quantity + r.owned }).eq('id', ex.id)
      : await window.sb.from('listings').insert({ binder_id: target.id, card_code: r.card_code, quantity: r.owned, listing_type: 'trade' });
    if (res.error) { $('edError').textContent = res.error.message; return false; }
  }
  return true;
}

// TCG registry: One Piece is the built-in default (no entry). Register each
// other game's module here — the shared shell dispatches by deck.game.
const DECK_MODULES = { cyberpunk: { open: cpOpen } };

if (window.SB_READY) init();
