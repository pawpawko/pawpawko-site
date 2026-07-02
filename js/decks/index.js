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

const setupNotice = document.getElementById('setupNotice');
setupNotice.innerHTML = window.PK.notReadyMessage();

const GAME = 'optcg';
const $ = (id) => document.getElementById(id);

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

const isBase = (code) => !/_p\d+$/i.test(code);
const baseCode = (code) => String(code).split('_')[0];
// art_mix: {alt print code -> copies} on a deck_cards row; base copies are
// implied (quantity - sum). '{}'/absent = all base.
const artMixOf = (r) => (r && r.art_mix && typeof r.art_mix === 'object') ? r.art_mix : {};
const altCountOf = (r) => Object.values(artMixOf(r)).reduce((s, n) => s + (n > 0 ? n : 0), 0);
// One Piece color letters (U = Blue, since B is taken by Black). Used for the
// default deck name: "Green/Blue Uta" -> "GU Uta Deck".
const COLOR_ABBREV = { Red: 'R', Green: 'G', Blue: 'U', Purple: 'P', Black: 'B', Yellow: 'Y' };
const colorAbbrev = (color) => String(color || '').split('/')
  .map(c => COLOR_ABBREV[c.trim()] || (c.trim()[0] || '').toUpperCase()).join('');
const standardLegal = (code) =>
  !state.rotatedPrefixes.has(baseCode(code).split('-')[0]) || state.rotationExempt.has(baseCode(code));
const pillValue = (groupId) =>
  document.querySelector(`#${groupId} .pill-choice-btn.active`)?.dataset.value;
const setPill = (groupId, value) => {
  document.querySelectorAll(`#${groupId} .pill-choice-btn`).forEach(b =>
    b.classList.toggle('active', b.dataset.value === value));
};
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const esc = window.PK.escapeHtml;

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

function closeNewDeck() {
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

function showList(fromPop = false) {
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
async function openDeck(deckId, push = false) {
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

async function reloadDeckCards() {
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
function zoomBtnHTML() {
  return `<span class="card-act card-zoom" role="button" aria-label="Enlarge card">${ZOOM_ICON}</span>`;
}
const cardZoom = (() => {
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
function wireZoom(tile, card) {
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

// copy cap for a base code: undefined exception -> 4; null -> unlimited; n -> n
function capFor(code) {
  if (!(code in state.exceptions)) return 4;
  return state.exceptions[code]; // null = unlimited
}

// ---- Serialized deck-card writes ----
// Every deck_cards mutation updates the local cache optimistically (instant
// feedback) and queues its DB write so fast repeated clicks can't race on a
// stale read — which previously lost increments or dropped duplicate inserts.
// Each queued writer re-reads the live row, so deltas accumulate correctly.
// One reconcile fetch runs once the burst settles (also rolling back anything
// the gatekeeper trigger rejected).
let dcQueue = Promise.resolve();
function queueDeckWrite(writer) {
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
function renderDeckLocal() { renderDeck(); renderBrowser(); cardZoom.refresh(); }
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
function localSetRow(code, fields) {
  const row = state.deckCards.find(r => r.card_code === code);
  if (row) Object.assign(row, fields);
  renderDeckLocal();
}
function localRemoveRow(code) {
  const i = state.deckCards.findIndex(r => r.card_code === code);
  if (i >= 0) state.deckCards.splice(i, 1);
  renderDeckLocal();
}
async function readDeckCard(code) {
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
function setCardAbsolute(code, kind, value) {
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

// ---------------- bench (local-only staging) + drag-and-drop ----------------
// The bench holds extra candidate cards that are NOT in the 50. It lives per
// deck in localStorage only, so server-side validity / wishlist sync /
// Cost-to-Finish (all keyed off the 50 in deck_cards) are untouched. Drag a
// bench card onto a deck card to swap, or onto the deck/bench to move across.
let dragSrc = null;        // { zone:'deck'|'bench', code } while dragging

function benchKey(id) { return `pawpaw:deckBench:${id}`; }
function saveBench() { if (state.DEMO) return; try { localStorage.setItem(benchKey(state.deck.id), JSON.stringify(state.bench)); } catch (e) {} }
function readBenchLocal() {
  try {
    const a = JSON.parse(localStorage.getItem(benchKey(state.deck.id)) || '[]');
    return Array.isArray(a) ? a.filter(x => x && x.code && x.qty > 0).map(x => ({ code: x.code, qty: x.qty, owned: Math.max(0, Math.min(x.qty, x.owned || 0)) })) : [];
  } catch (e) { return []; }
}
async function loadBench() {
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
function benchCount() { return state.bench.reduce((s, b) => s + b.qty, 0); }
function updateBenchBtn() {
  const btn = $('edBenchBtn');
  if (!btn) return;
  const sec = $('edBenchSection');
  const open = sec && sec.style.display !== 'none';
  btn.textContent = `Bench ${open ? '▴' : '▾'}`; // arrow reflects open/closed
}
function benchAdd(code, qty, owned) {
  const o = Math.max(0, Math.min(qty, owned || 0));
  const e = state.bench.find(x => x.code === code);
  if (e) { e.qty += qty; e.owned = Math.min(e.qty, (e.owned || 0) + o); }
  else state.bench.push({ code, qty, owned: o });
  saveBench(); renderBench();
}
function benchRemove(code) {
  const i = state.bench.findIndex(x => x.code === code);
  if (i >= 0) state.bench.splice(i, 1);
  saveBench(); renderBench();
}
function toggleBench() {
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
function toggleBenchSide() {
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
function makeDragHandle(tile, zone, code) {
  const img = tile.querySelector('img');
  if (!img) return;
  img.draggable = true;
  img.addEventListener('dragstart', e => startDrag(e, zone, code, tile));
  img.addEventListener('dragend', endDrag);
}
function wireDeckDropTarget(tile, deckCode) {
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
function wireDropZones() {
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

function renderBench() {
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

// ---------------- deck stats (over the 50; excludes leader + bench) ----------------
// Searcher detection — faithful port of scripts/search_meta.py (the canonical
// parser). Lives here because the editor already has each card's effect_text
// client-side; once cards.search_meta is populated server-side, prefer reading
// that and delete this. Real OPTCG wording is "look at N cards FROM THE TOP of
// your deck … reveal up to 1 <filter> … add it to your hand" — the old
// /look at the top N cards of your deck/ matched zero cards.
const SEARCH_COLORS = ['red', 'green', 'blue', 'purple', 'black', 'yellow'];
const SEARCH_CLAUSE_RE = /look at (?:up to )?(\d+) cards? from the top of your deck[;:,. ]*reveal\s+(.*?)\s*[,;]?\s*(?:and\s+)?add\s+(?:it|them|up to \d+[^.]*?)\s+to your hand/i;
// A card HAS a [Trigger] keyword (vs. merely referencing one — searchers and
// recursion say "… a card with a [Trigger]" / "… and a [Trigger] …"). Strip
// those reference phrases first, then look for a remaining [Trigger] keyword.
function hasTrigger(effect) {
  return /\[Trigger\]/i.test(String(effect || '').replace(/(?:with|and)\s+an?\s+\[Trigger\]/gi, ''));
}
function parseSearcherSub(s) {
  s = s.replace(/\s+/g, ' ').trim();
  const f = {};
  const excl = [...s.matchAll(/other than \[([^\]]+)\]/gi)].map(x => x[1]);
  const rest = s.replace(/other than \[[^\]]+\]/gi, ' ');
  // "[Trigger]" is a keyword (e.g. "a card with a [Trigger]"), not a card name —
  // matched against each candidate's effect text in cardMatchesSub.
  const allNames = [...rest.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]);
  const trigger = allNames.some(n => /^trigger$/i.test(n));
  const names = allNames.filter(n => !/^trigger$/i.test(n));
  const traits = [...s.matchAll(/\{([^}]+)\}/g)].map(x => x[1])
    .concat([...s.matchAll(/type including "([^"]+)"/gi)].map(x => x[1]));
  const colors = [...new Set([...s.matchAll(new RegExp('\\b(' + SEARCH_COLORS.join('|') + ')\\b', 'gi'))].map(x => x[1].toLowerCase()))];
  const masked = s.replace(/\{[^}]*\}|\[[^\]]*\]/g, ' '); // don't read trait/name words as the category
  let category = null;
  for (const [w, code] of [['Character', 'CHARACTER'], ['Event', 'EVENT'], ['Stage', 'STAGE'], ['Leader', 'LEADER']]) {
    if (new RegExp('\\b' + w + '\\b', 'i').test(masked)) { category = code; break; }
  }
  let cost = null, mm;
  if ((mm = s.match(/cost of (\d+) to (\d+)/i))) cost = { op: 'range', min: +mm[1], max: +mm[2] };
  else if ((mm = s.match(/cost of (\d+) or more/i))) cost = { op: '>=', val: +mm[1] };
  else if ((mm = s.match(/cost of (\d+) or less/i))) cost = { op: '<=', val: +mm[1] };
  else if ((mm = s.match(/cost of (\d+)\b/i))) cost = { op: '==', val: +mm[1] };
  if (category) f.category = category;
  if (traits.length) f.traits = traits;
  if (colors.length) f.colors = colors;
  if (trigger) f.trigger = true;
  if (names.length) f.names = names;
  if (excl.length) f.exclude = excl;
  if (cost) f.cost = cost;
  return f;
}
// -> { look, take, filters:[ {category,traits,colors,names,exclude,cost} ], gated } | null.
// Within a filter, names/traits/colors are OR-matched; category/cost AND'd;
// multiple filters are OR'd (the "… or up to 1 …" form).
function parseSearcher(effect) {
  if (!effect) return null;
  const eff = effect.replace(/\s+/g, ' ').trim();
  const m = eff.match(SEARCH_CLAUSE_RE);
  if (!m) return null;
  const look = parseInt(m[1], 10);
  const body = m[2];
  const takeM = body.match(/up to (\d+)/i);
  const take = takeM ? parseInt(takeM[1], 10) : 1;
  const core = body.replace(/^\s*up to \d+\s+/i, '');
  const filters = core.split(/\s+or up to \d+\s+/i).map(parseSearcherSub);
  // Capture the gating condition ("If your Leader … , look at …") so the
  // stats panel can test it against the deck's actual leader.
  const gateM = eff.match(/\bif ((?:your|you)\b.*?)(?=,?\s*look at (?:up to )?\d+ cards? from the top)/i);
  const gate = gateM ? gateM[1].trim() : null;
  return { look, take, filters, gated: !!gate, gate };
}
// Evaluate a searcher's gate against the deck's leader. Returns one of:
//   always | fires (leader satisfies it) | dead (leader can't) | situational
//   (board-state we can't know from the list). `why` is a short label.
function evalSearcherGate(gate, L) {
  if (!gate) return { status: 'always' };
  let m;
  if ((m = gate.match(/leader is \[([^\]]+)\]/i)))
    return { status: L && L.name === m[1] ? 'fires' : 'dead', why: `Leader = ${m[1]}` };
  if ((m = gate.match(/leader has the \{([^}]+)\} type/i)))
    return { status: L && Array.isArray(L.types) && L.types.includes(m[1]) ? 'fires' : 'dead', why: `Leader is {${m[1]}}` };
  if ((m = gate.match(/leader has the <([^>]+)> attribute/i)))
    return { status: L && (L.attribute || '').toLowerCase() === m[1].toLowerCase() ? 'fires' : 'dead', why: `Leader is <${m[1]}>` };
  if (/leader is multicolored/i.test(gate))
    return { status: L && /\//.test(L.color || '') ? 'fires' : 'dead', why: 'multicolored Leader' };
  if ((m = gate.match(/leader is (red|green|blue|purple|black|yellow)\b/i)))
    return { status: L && (L.color || '').toLowerCase().includes(m[1].toLowerCase()) ? 'fires' : 'dead', why: `${m[1]} Leader` };
  return { status: 'situational', why: gate };
}
function cardMatchesSub(ci, f) {
  const id = [];
  if (f.names) id.push(f.names.includes(ci.name));
  if (f.traits) id.push(Array.isArray(ci.types) && ci.types.some(t => f.traits.includes(t)));
  if (f.colors) { const cc = (ci.color || '').toLowerCase(); id.push(f.colors.some(col => cc.includes(col))); }
  if (f.trigger) id.push(hasTrigger(ci.effect_text));
  if (id.length && !id.some(Boolean)) return false;       // identity constraints are OR'd
  if (f.category && ci.type !== f.category) return false;
  if (f.cost) {
    const v = ci.cost; if (v == null) return false;
    if (f.cost.op === 'range' && (v < f.cost.min || v > f.cost.max)) return false;
    if (f.cost.op === '>=' && !(v >= f.cost.val)) return false;
    if (f.cost.op === '<=' && !(v <= f.cost.val)) return false;
    if (f.cost.op === '==' && v !== f.cost.val) return false;
  }
  if (f.exclude && f.exclude.includes(ci.name)) return false;
  return true;
}
function searcherTargetLabel(filters) {
  return filters.map(f => {
    const p = [];
    if (f.names) p.push(f.names.map(n => '[' + n + ']').join('/'));
    if (f.traits) p.push(f.traits.map(t => '{' + t + '}').join('/'));
    if (f.colors) p.push(f.colors.join('/'));
    if (f.trigger) p.push('[Trigger]');
    if (f.category) p.push(f.category[0] + f.category.slice(1).toLowerCase());
    if (f.cost) p.push('cost ' + (f.cost.op === 'range' ? `${f.cost.min}-${f.cost.max}` : f.cost.op === '==' ? f.cost.val : f.cost.op + f.cost.val));
    return p.join(' ') || 'any card';
  }).join(' or ');
}
function closeStats() { $('stOverlay').style.display = 'none'; }
// Hypergeometric: chance of ≥1 target in the top N of a D-card deck holding T
// targets. Computed as 1 − P(all N miss) to avoid big factorials.
function hitChance(D, T, N) {
  N = Math.min(N, D);
  if (T <= 0 || N <= 0) return 0;
  if (D - T < N) return 1;
  let pMiss = 1;
  for (let i = 0; i < N; i++) pMiss *= (D - T - i) / (D - i);
  return 1 - pMiss;
}
function openStats() {
  if (!state.deckValid) return; // stats only meaningful on a valid 50-card legal deck (button is also disabled)
  $('stOverlay').style.display = '';
  const body = $('stBody');
  if (!state.deckCards.length) { body.innerHTML = '<p class="text-muted-line">No cards in the deck yet.</p>'; return; }

  let c2000 = 0, c1000 = 0, cNone = 0, total = 0;
  const costB = {};
  state.deckCards.forEach(r => {
    const c = state.cardInfo[r.card_code] || {};
    total += r.quantity;
    if (c.counter === 2000) c2000 += r.quantity;
    else if (c.counter === 1000) c1000 += r.quantity;
    else cNone += r.quantity;
    if (c.cost != null) costB[c.cost] = (costB[c.cost] || 0) + r.quantity;
  });

  const ct = c2000 + c1000 + cNone || 1;
  const counters = `
    <div class="st-section">
      <h4>Counters</h4>
      <div class="st-counter-bar">
        <span class="seg" style="width:${c2000 / ct * 100}%;background:#7ec96a"></span>
        <span class="seg" style="width:${c1000 / ct * 100}%;background:#e8b757"></span>
        <span class="seg" style="width:${cNone / ct * 100}%;background:#b0506a"></span>
      </div>
      <div class="st-legend">
        <span><i style="background:#7ec96a"></i>+2000 × ${c2000}</span>
        <span><i style="background:#e8b757"></i>+1000 × ${c1000}</span>
        <span><i style="background:#b0506a"></i>No counter (bricks) × ${cNone}</span>
      </div>
    </div>`;

  const costs = Object.keys(costB).map(Number);
  const maxCost = costs.length ? Math.max(...costs) : 0;
  const maxN = costs.length ? Math.max(...costs.map(k => costB[k])) : 0;
  let bars = '';
  for (let cc = 0; cc <= maxCost; cc++) {
    const n = costB[cc] || 0;
    const pct = maxN ? Math.round(n / maxN * 100) : 0;
    bars += `<div class="st-bar-row"><span class="st-bar-label">${cc}</span><div class="st-bar-track"><div class="st-bar" style="width:${pct}%"></div></div><span class="st-bar-n">${n}</span></div>`;
  }
  const costCurve = `
    <div class="st-section">
      <h4>Play-cost curve</h4>
      ${bars || '<p class="text-muted-line">No costed cards.</p>'}
    </div>`;

  const searcherRows = state.deckCards
    .map(r => ({ r, meta: parseSearcher((state.cardInfo[r.card_code] || {}).effect_text) }))
    .filter(x => x.meta)
    .map(({ r, meta }) => {
      const c = state.cardInfo[r.card_code] || {};
      // Cards this searcher can reveal (excl. its own copies — that one's gone).
      const hits = state.deckCards
        .filter(x => x.card_code !== r.card_code && meta.filters.some(f => cardMatchesSub(state.cardInfo[x.card_code] || {}, f)))
        .map(x => ({ name: (state.cardInfo[x.card_code] || {}).name || x.card_code, qty: x.quantity }))
        .sort((a, b) => b.qty - a.qty);
      const T = hits.reduce((s, h) => s + h.qty, 0);
      const fresh = hitChance(total, T, meta.look); // top-of-fresh-deck
      // Draw-accurate: a cost-C searcher resolves ~turn C, by when you've seen
      // ~5 (opening hand) + C cards; dig the remaining deck for the targets
      // expected to still be in it.
      const seen = Math.min(total - meta.look, 5 + (c.cost || 0));
      const Dleft = Math.max(meta.look, total - seen);
      const live = hitChance(Dleft, T * Dleft / total, meta.look);
      const gate = evalSearcherGate(meta.gate, state.leaderCard);
      return { r, c, meta, T, hits, fresh, live, gate };
    })
    .sort((a, b) => {
      const ad = a.gate.status === 'dead' ? 1 : 0, bd = b.gate.status === 'dead' ? 1 : 0;
      return ad - bd || b.live - a.live; // dead gates last, else most reliable first
    });

  const searcherCopies = searcherRows.reduce((s, x) => s + x.r.quantity, 0);
  const openRaw = searcherRows.length ? hitChance(total, searcherCopies, 5) : 0; // ≥1 in a single 5-card hand
  // OPTCG gives a free mulligan (redraw all 5 once), so you get two shots at it.
  const openAccess = searcherRows.length ? 1 - (1 - openRaw) * (1 - openRaw) : 0;

  let searchHtml;
  if (!searcherRows.length) {
    searchHtml = '<p class="text-muted-line">No searchers detected.</p>';
  } else {
    const hitColor = p => (p >= 75 ? '#7ec96a' : p >= 50 ? '#e8b757' : '#b0506a');
    const rows = searcherRows.map(({ r, c, meta, T, hits, fresh, live, gate }, i) => {
      const dead = gate.status === 'dead', situ = gate.status === 'situational';
      const pct = Math.round(live * 100);
      const upto = meta.take > 1 ? ` <span class="pc-code">+up to ${meta.take}</span>` : '';
      const label = searcherTargetLabel(meta.filters);
      let flag = '';
      if (dead) flag = ` <span class="pc-code" style="color:#b0506a" title="This deck's leader doesn't satisfy: ${esc(gate.why || '')}">✗ won't fire</span>`;
      else if (situ) flag = ` <span class="pc-code" style="color:#e8b757" title="Situational — only when met: ${esc(gate.why || '')}">if active</span>`;
      else if (gate.status === 'fires') flag = ` <span class="pc-code" style="color:#7ec96a" title="Your leader satisfies: ${esc(gate.why || '')}">✓ fires</span>`;
      const hitCell = dead
        ? `<td class="num" style="color:#7a7280" title="Gate not met — never searches in this deck">—</td>`
        : `<td class="num" style="color:${hitColor(pct)};font-weight:700" title="${situ ? 'when its condition is met · ' : ''}fresh-deck ${Math.round(fresh * 100)}% · modeled around turn ${c.cost || 0}">${pct}%${situ ? '*' : ''}</td>`;
      const detail = hits.length
        ? hits.map(h => `${esc(h.name)} <span class="pc-code">×${h.qty}</span>`).join(' · ')
        : 'No matching cards in this deck.';
      return `<tr class="st-srow" style="cursor:pointer"><td><span class="st-care">▸</span> ${esc(c.name || r.card_code)} <span class="pc-code">×${r.quantity}</span>${flag}</td><td class="num">top ${meta.look}${upto}</td><td class="num">${T} <span class="pc-code">${esc(label)}</span></td>${hitCell}</tr>` +
        `<tr class="st-sdetail" hidden><td colspan="4" style="padding:.2rem .6rem .7rem 1.6rem;color:var(--text-muted,#988e85);font-size:.82rem">Can hit: ${detail}</td></tr>`;
    }).join('');
    searchHtml =
      `<p class="text-muted-line">${Math.round(openAccess * 100)}% to open one in your first 5 (with mulligan)</span>.<table class="st-search"><thead><tr><th>Searcher</th><th class="num">Depth</th><th class="num">Targets</th><th class="num">Hit %</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // Triggers — [Trigger] cards can act when they're dealt to you from your Life.
  // A leader's "cost" column is its Life value; Life cards are drawn from the 50,
  // so chance-in-life is hypergeometric (the same hitChance used for searchers).
  const trigHits = state.deckCards
    .filter(r => hasTrigger((state.cardInfo[r.card_code] || {}).effect_text))
    .map(r => ({ name: (state.cardInfo[r.card_code] || {}).name || r.card_code, qty: r.quantity }))
    .sort((a, b) => b.qty - a.qty);
  const trigCount = trigHits.reduce((s, h) => s + h.qty, 0); // qty-weighted: counts each card's copies
  const life = (state.leaderCard && (state.leaderCard.life ?? state.leaderCard.cost)) || 5;
  const trigInLife = hitChance(total, trigCount, life);
  const expTrig = total ? trigCount * life / total : 0;
  const trigColor = trigInLife >= 0.75 ? '#7ec96a' : trigInLife >= 0.5 ? '#e8b757' : '#b0506a';
  const triggers = `
    <div class="st-section">
      <h4>Triggers <span class="text-muted-line" style="font-weight:400;text-transform:none;letter-spacing:0;">— act when taken from your ${life} Life</span></h4>
      ${trigCount
        ? `<p class="text-muted-line st-trow" style="cursor:pointer"><span class="st-care">▸</span> <strong>${trigCount}</strong> <span class="pc-code">[Trigger]</span> card${trigCount === 1 ? '' : 's'} · <strong style="color:${trigColor}">${Math.round(trigInLife * 100)}%</strong> chance ≥1 starts in Life · ~${expTrig.toFixed(1)} expected in your ${life} Life <span class="pc-code">tap for the list</span></p>`
          + `<div class="st-tdetail" hidden style="padding:.1rem .6rem .7rem 1.6rem;color:var(--text-muted,#988e85);font-size:.82rem">${trigHits.map(h => `${esc(h.name)} <span class="pc-code">×${h.qty}</span>`).join(' · ')}</div>`
        : '<p class="text-muted-line">No <span class="pc-code">[Trigger]</span> cards in the deck.</p>'}
    </div>`;
  body.innerHTML = `<p class="text-muted-line">${total} card${total === 1 ? '' : 's'} in the deck${total !== 50 ? ' (not 50 yet)' : ''}.</p>` + counters + triggers + costCurve + searchHtml;

  // Expand/collapse each searcher's target breakdown.
  body.querySelectorAll('.st-srow').forEach(tr => {
    tr.addEventListener('click', () => {
      const d = tr.nextElementSibling;
      if (d && d.classList.contains('st-sdetail')) {
        d.hidden = !d.hidden;
        const car = tr.querySelector('.st-care');
        if (car) car.textContent = d.hidden ? '▸' : '▾';
      }
    });
  });
  // Expand/collapse the Triggers card list.
  const trow = body.querySelector('.st-trow');
  if (trow) trow.addEventListener('click', () => {
    const d = trow.nextElementSibling;
    if (d && d.classList.contains('st-tdetail')) {
      d.hidden = !d.hidden;
      const car = trow.querySelector('.st-care');
      if (car) car.textContent = d.hidden ? '▸' : '▾';
    }
  });
}

// ---------------- Add Cards overlay browser ----------------
// Full-screen scrollable overlay over the editor; binder-style filters
// minus Color (the leader locks it). Pool is leader-color matched, bans
// excluded; rotated cards only appear when the deck format is Eternal.

let cbReady = false; // filter dropdowns populated once

function openBrowser() {
  $('cbOverlay').style.display = '';
  document.body.style.overflow = 'hidden'; // the overlay scrolls, not the page
  $('cbError').textContent = '';
  if (!cbReady) { cbReady = true; populateBrowserFilters(); }
  ensureTraitPool();
  loadBrowser();
  $('cbName').focus();
}

function closeBrowser() {
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

async function ensureTraitPool() {
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

function renderTraitList() {
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

async function loadBrowser() {
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

async function loadMoreBrowser() {
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

function renderBrowser() {
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

// ---------------- decklist import / export ----------------
// Format: one card per line as "NxCODE" (e.g. 4xOP16-091); the leader is
// its own 1x line. Alt-art suffixes normalize to base codes; duplicate
// lines sum.

let dlMode = 'export';

const byCostThenCode = (a, b) => {
  const ca = state.cardInfo[a.card_code] || {}, cb = state.cardInfo[b.card_code] || {};
  return (ca.cost ?? 99) - (cb.cost ?? 99) || String(a.card_code).localeCompare(b.card_code);
};

function parseDecklist(text) {
  const rows = new Map();
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const m = t.match(/^(\d+)\s*[x×]\s*([A-Za-z0-9_-]+)$/i);
    if (!m) { errors.push(`line ${i + 1}: "${t}"`); return; }
    const code = baseCode(m[2].toUpperCase());
    rows.set(code, (rows.get(code) || 0) + Number(m[1]));
  });
  return { rows, errors };
}

async function lookupCards(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += 100) {
    const { data } = await window.sb
      .from('cards').select('card_code,name,color,cost,type,image_url,counter,effect_text,types')
      .eq('game', GAME).in('card_code', codes.slice(i, i + 100));
    (data || []).forEach(c => { out[c.card_code] = c; });
  }
  return out;
}

function closeDl() { $('dlOverlay').style.display = 'none'; }

function closeMenus() {
  document.querySelectorAll('.deck-io-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.deck-io-wrap > .btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
}
function toggleMenu(btnId, menuId, e) {
  e.stopPropagation(); // don't let the document handler immediately re-close it
  const willOpen = !$(menuId).classList.contains('open');
  closeMenus(); // only one menu open at a time
  if (willOpen) {
    $(menuId).classList.add('open');
    $(btnId).setAttribute('aria-expanded', 'true');
  }
}

function openExport() {
  dlMode = 'export';
  $('dlTitle').textContent = 'Export Decklist';
  $('dlHint').textContent = 'Leader first, then one line per card. Copy and share.';
  $('dlError').textContent = '';
  const sorted = state.deckCards.slice().sort(byCostThenCode);
  $('dlText').value = [`1x${state.deck.leader_card_code}`, ...sorted.map(r => `${r.quantity}x${r.card_code}`)].join('\n');
  $('dlText').readOnly = true;
  $('dlAction').textContent = 'Copy';
  $('dlOwnedWrap').style.display = 'none'; // export has no owned toggle
  $('dlOverlay').style.display = '';
}

function openExportMissing() {
  dlMode = 'export';
  $('dlTitle').textContent = 'Export Missing Cards';
  $('dlError').textContent = '';
  // Just the copies you still need (quantity − owned); leader excluded (you own it).
  const missing = state.deckCards.filter(r => r.quantity - r.owned > 0).sort(byCostThenCode);
  if (!missing.length) {
    $('dlHint').textContent = 'Nothing missing — every card in this deck is owned. 🎉';
    $('dlText').value = '';
  } else {
    $('dlHint').textContent = 'The cards you still need (the quantity you’re short). Copy to share or shop.';
    $('dlText').value = missing.map(r => `${r.quantity - r.owned}x${r.card_code}`).join('\n');
  }
  $('dlText').readOnly = true;
  $('dlAction').textContent = 'Copy';
  $('dlOwnedWrap').style.display = 'none';
  $('dlOverlay').style.display = '';
}

function openImportEditor() {
  dlMode = 'import';
  $('dlTitle').textContent = 'Import Decklist';
  $('dlHint').textContent = 'Replaces every card in this deck. A leader line (1xCODE) must match this deck’s leader.';
  $('dlError').textContent = '';
  $('dlText').value = '';
  $('dlText').readOnly = false;
  $('dlAction').textContent = 'Import';
  $('dlOwned').checked = false;
  $('dlOwnedWrap').style.display = 'flex';
  $('dlOverlay').style.display = '';
  $('dlText').focus();
}

async function onDlAction() {
  if (dlMode === 'export') {
    try {
      await navigator.clipboard.writeText($('dlText').value);
      $('dlAction').textContent = 'Copied ✓';
      setTimeout(() => { $('dlAction').textContent = 'Copy'; }, 1800);
    } catch (e) {
      $('dlText').select(); // clipboard blocked: leave it selected to copy manually
    }
    return;
  }
  await doEditorImport();
}

async function doEditorImport() {
  const errEl = $('dlError');
  errEl.textContent = '';
  const { rows, errors } = parseDecklist($('dlText').value);
  if (errors.length) { errEl.textContent = 'Bad lines — ' + errors.slice(0, 3).join('; '); return; }
  if (!rows.size) { errEl.textContent = 'Nothing to import.'; return; }
  const info = await lookupCards([...rows.keys()]);
  const missing = [...rows.keys()].filter(c => !info[c]);
  if (missing.length) { errEl.textContent = 'Unknown card(s): ' + missing.join(', '); return; }
  for (const code of [...rows.keys()]) {
    if (info[code].type !== 'LEADER') continue;
    if (code !== state.deck.leader_card_code) {
      errEl.textContent = `This list is led by ${info[code].name} (${code}) — create a deck with that leader, then import there.`;
      return;
    }
    rows.delete(code); // matching leader line: implied, drop it
  }
  const markOwned = $('dlOwned').checked; // owned = quantity for every line
  $('dlAction').disabled = true;
  await window.sb.from('deck_cards').delete().eq('deck_id', state.deck.id);
  const fails = [];
  for (const [code, qty] of rows) {
    state.cardInfo[code] = info[code];
    const { error } = await window.sb.from('deck_cards')
      .insert({ deck_id: state.deck.id, card_code: code, quantity: qty, owned: markOwned ? qty : 0 });
    if (error) fails.push(`${code}: ${error.message}`);
  }
  $('dlAction').disabled = false;
  await reloadDeckCards();
  if (fails.length) {
    errEl.textContent = `${fails.length} line(s) rejected — ${fails.slice(0, 3).join('; ')}`;
  } else {
    closeDl();
  }
}


// ---------------- cost to finish (missing-card prices) ----------------
// Sums each still-needed copy (quantity − owned) at its cached cheapest
// single price (cards.price_usd, kept fresh by scripts/update_prices.py).
// Mirrors the manual price breakdown: dearest cards on top, grand total.

function closePrices() { $('pcOverlay').style.display = 'none'; }

async function openPrices(mode) {
  const isDeck = mode === 'deck';
  $('pcTitle').textContent = isDeck ? 'Cost of Deck' : 'Cost to Finish';
  $('pcOverlay').style.display = '';
  $('pcTotal').textContent = '';
  $('pcFoot').textContent = '';
  $('pcBody').innerHTML = '<p class="text-muted-line">Pricing…</p>';

  // Deck = leader + every card at full quantity; Finish = only the copies you're short.
  const items = isDeck
    ? [{ code: state.deck.leader_card_code, need: 1 }, ...state.deckCards.map(r => ({ code: r.card_code, need: r.quantity }))]
    : state.deckCards.map(r => ({ code: r.card_code, need: r.quantity - r.owned })).filter(x => x.need > 0);
  if (!items.length) {
    $('pcBody').innerHTML = '<p class="text-muted-line">Nothing missing — every card in this deck is owned. 🎉</p>';
    return;
  }

  // Pull fresh prices for just these codes (deck-sized, so cheap).
  const codes = items.map(x => x.code);
  const priceMap = {};
  let queryErr = null;
  for (let i = 0; i < codes.length; i += 100) {
    const { data, error } = await window.sb
      .from('cards').select('card_code,name,rarity,image_url,price_usd,price_updated_at')
      .eq('game', GAME).in('card_code', codes.slice(i, i + 100));
    if (error) { queryErr = error; break; }
    (data || []).forEach(c => { priceMap[c.card_code] = c; });
  }
  if (queryErr) {
    $('pcBody').innerHTML =
      `<p class="auth-error">Couldn't load prices: ${esc(queryErr.message)}</p>` +
      `<p class="text-muted-line">First run? Apply <code>scripts/card_prices_migration.sql</code>, then <code>python scripts/update_prices.py</code>.</p>`;
    return;
  }

  let total = 0, unpriced = 0, lastUpdated = null;
  const rows = items.map(x => {
    const c = priceMap[x.code] || {};
    const info = state.cardInfo[x.code] || {};
    const price = (c.price_usd != null) ? Number(c.price_usd) : null;
    if (price == null) unpriced++; else total += price * x.need;
    if (c.price_updated_at && (!lastUpdated || c.price_updated_at > lastUpdated)) lastUpdated = c.price_updated_at;
    return { code: x.code, name: c.name || info.name || x.code, rarity: c.rarity || '',
             img: c.image_url || info.image_url || '', need: x.need, price,
             line: price == null ? null : price * x.need };
  }).sort((a, b) => (b.line ?? -1) - (a.line ?? -1)); // dearest first (cost drivers on top)

  const fmt = (n) => '$' + n.toFixed(2);
  const qtyLabel = isDeck ? 'Qty' : 'Need';
  $('pcBody').innerHTML = `
    <table class="pc-table">
      <thead><tr><th>Card</th><th class="num">${qtyLabel}</th><th class="num">Each</th><th class="num">Line</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr${r.price == null ? ' class="pc-unpriced"' : ''}>
            <td><div class="pc-name">
              ${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy">` : ''}
              <span>${esc(r.name)}${r.rarity ? ` <span class="pc-code">${esc(r.rarity)}</span>` : ''}<br>
              <span class="pc-code">${esc(r.code)}</span></span>
            </div></td>
            <td class="num">×${r.need}</td>
            <td class="num">${r.price == null ? '—' : fmt(r.price)}</td>
            <td class="num">${r.line == null ? '—' : fmt(r.line)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const copies = rows.reduce((s, r) => s + r.need, 0);
  $('pcTotal').innerHTML = `Total ≈ <strong>${fmt(total)}</strong> ` +
    `<span class="text-muted-line" style="font-size:.8rem;">for ${copies} card${copies === 1 ? '' : 's'}</span>`;

  if (total === 0 && unpriced === rows.length) {
    $('pcFoot').textContent = 'No prices loaded yet — run python scripts/update_prices.py to populate them.';
  } else {
    const parts = ['Cheapest single · TCGplayer via Limitless'];
    if (lastUpdated) parts.push('updated ' + new Date(lastUpdated).toLocaleDateString());
    if (unpriced) parts.push(`${unpriced} card${unpriced === 1 ? '' : 's'} not priced yet`);
    $('pcFoot').textContent = parts.join(' · ');
  }
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

async function cpOpen(d) {
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
  const localTotal = cpCards.reduce((s, r) => s + r.quantity, 0);
  const { data: v } = await window.sb.rpc('deck_validity', { p_deck_id: cpDeck.id });
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

function cpInit() {
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

// TCG registry: One Piece is the built-in default (no entry). Register each
// other game's module here — the shared shell dispatches by deck.game.
const DECK_MODULES = { cyberpunk: { open: cpOpen } };

if (window.SB_READY) init();
