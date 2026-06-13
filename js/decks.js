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

(function () {
  const setupNotice = document.getElementById('setupNotice');
  setupNotice.innerHTML = window.PK.notReadyMessage();
  if (!window.SB_READY) return;

  const GAME = 'optcg';
  const $ = (id) => document.getElementById(id);

  let user = null;
  let deck = null;            // current decks row
  let leaderCard = null;      // cards row for the leader (base print)
  let leaderArts = [];        // base + _p alt-art prints of the leader
  let artIdx = 0;             // current art (persisted per deck in localStorage)
  const artKey = (deckId) => `pawpaw:deckArt:${deckId}`;
  let deckCards = [];         // deck_cards rows
  let cardInfo = {};          // card_code -> cards row
  let exceptions = {};        // card_code -> max_copies (null = unlimited, 0 = banned)
  let rotatedPrefixes = new Set();  // set prefixes out of Standard (e.g. OP01)
  let rotationExempt = new Set();   // base codes legal despite a rotated prefix

  const isBase = (code) => !/_p\d+$/i.test(code);
  const baseCode = (code) => String(code).split('_')[0];
  const standardLegal = (code) =>
    !rotatedPrefixes.has(baseCode(code).split('-')[0]) || rotationExempt.has(baseCode(code));
  const pillValue = (groupId) =>
    document.querySelector(`#${groupId} .pill-choice-btn.active`)?.dataset.value;
  const setPill = (groupId, value) => {
    document.querySelectorAll(`#${groupId} .pill-choice-btn`).forEach(b =>
      b.classList.toggle('active', b.dataset.value === value));
  };
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function init() {
    user = await window.PK.currentUser();
    if (!user) { $('needsAuth').style.display = ''; return; }

    const [{ data: exRows }, { data: rotSets }, { data: rotEx }] = await Promise.all([
      window.sb.from('deck_rule_exceptions').select('card_code,max_copies').eq('game', GAME),
      window.sb.from('rotated_sets').select('set_prefix').eq('game', GAME),
      window.sb.from('rotation_exempt_cards').select('card_code').eq('game', GAME),
    ]);
    (exRows || []).forEach(r => { exceptions[r.card_code] = r.max_copies; });
    rotatedPrefixes = new Set((rotSets || []).map(r => r.set_prefix));
    rotationExempt = new Set((rotEx || []).map(r => r.card_code));

    $('ndClose').addEventListener('click', closeNewDeck);
    $('ndOverlay').addEventListener('click', (e) => { if (e.target === $('ndOverlay')) closeNewDeck(); });
    $('edExportBtn').addEventListener('click', openExport);
    $('edImportBtn').addEventListener('click', openImportEditor);
    $('dlClose').addEventListener('click', closeDl);
    $('dlAction').addEventListener('click', onDlAction);
    $('dlOverlay').addEventListener('click', (e) => { if (e.target === $('dlOverlay')) closeDl(); });
    $('leaderSearch').addEventListener('input', debounce(searchLeaders, 250));
    $('backToDecks').addEventListener('click', () => showList()); // no event arg -> fromPop stays false
    $('edAddBtn').addEventListener('click', openBrowser);
    $('cbClose').addEventListener('click', closeBrowser);
    $('cbOverlay').addEventListener('click', (e) => { if (e.target === $('cbOverlay')) closeBrowser(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeBrowser(); closeDl(); closeNewDeck(); } });
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

    // Browser Back/Forward moves between the deck list and the editor.
    window.addEventListener('popstate', () => {
      const id = new URLSearchParams(location.search).get('deck');
      if (id) openDeck(id);
      else showList(true);
    });

    // Deep-link / refresh restore: ?deck=<id> reopens that deck's editor.
    const deepLink = new URLSearchParams(location.search).get('deck');
    if (deepLink) { openDeck(deepLink); return; }

    $('decksWrap').style.display = '';
    loadDecks();
  }

  // ---------------- deck list ----------------

  function openNewDeck() {
    $('ndOverlay').style.display = '';
    $('leaderSearch').focus();
  }

  function closeNewDeck() {
    $('ndOverlay').style.display = 'none';
    $('leaderResults').innerHTML = '';
    $('leaderSearch').value = '';
    $('ndImport').value = '';
    $('newDeckError').textContent = '';
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

    const { data: decks, error } = await window.sb
      .from('decks')
      .select('id, name, leader_card_code, is_public, listing_type, format, created_at')
      .eq('user_id', user.id)
      .order('created_at');
    if (error) { $('decksCount').textContent = error.message; return; }

    if (!decks || decks.length === 0) {
      $('decksCount').textContent = 'No decks yet — tap + to start building.';
      return;
    }
    $('decksCount').textContent = `${decks.length} deck${decks.length === 1 ? '' : 's'}`;

    const artOf = (d) => localStorage.getItem(artKey(d.id));
    const codes = [...new Set(decks.flatMap(d => [d.leader_card_code, artOf(d)].filter(Boolean)))];
    const { data: leaders } = await window.sb
      .from('cards').select('card_code,name,color,image_url').eq('game', GAME).in('card_code', codes);
    const leaderMap = {};
    (leaders || []).forEach(c => { leaderMap[c.card_code] = c; });

    // Validity per deck via the server RPC (cheap at <=5 decks)
    const validity = await Promise.all(decks.map(d =>
      window.sb.rpc('deck_validity', { p_deck_id: d.id }).then(r => r.data).catch(() => null)));

    decks.forEach((d, i) => {
      const L = leaderMap[artOf(d)] || leaderMap[d.leader_card_code] || {};
      const v = validity[i] || {};
      const li = document.createElement('li');
      li.className = 'deck-tile';
      li.innerHTML = `
        <a href="#" data-deck="${d.id}">
          <img src="${esc(L.image_url || '')}" alt="">
          <div class="deck-tile-body">
            <div class="deck-tile-name">${esc(d.name)}</div>
            <div class="deck-tile-meta">
              ${v.valid ? '<span class="deck-badge ok">valid</span>' : '<span class="deck-badge bad">cooking</span>'}
              ${d.format === 'eternal' ? '<span class="deck-badge etern">eternal</span>' : ''}
              ${d.is_public ? `<span class="deck-badge pub">${esc(d.listing_type || 'public')}</span>` : ''}
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
      .insert({ user_id: user.id, game: GAME, leader_card_code: leader.card_code,
                name: `${leader.color ? leader.color + ' ' : ''}${leader.name} Deck`,
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
        cardInfo[code] = listInfo[code];
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
    $('editorWrap').style.display = 'none';
    $('decksWrap').style.display = '';
    deck = null;
    loadDecks();
  }

  // push=true when the user navigates list -> editor (so browser Back
  // returns to the list); deep links and popstate restores replace instead.
  async function openDeck(deckId, push = false) {
    const { data: d, error } = await window.sb.from('decks').select('*').eq('id', deckId).single();
    if (error || !d) { showList(); return; } // stale/foreign id (e.g. old link) -> list
    deck = d;
    const url = `decks.html?deck=${d.id}`; // survives hard refresh
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    const { data: L } = await window.sb
      .from('cards').select('card_code,name,color,image_url,image_url_lg')
      .eq('game', GAME).eq('card_code', d.leader_card_code).single();
    leaderCard = L;

    // Alt arts: the base print plus its _p variants (same card number).
    const { data: arts } = await window.sb
      .from('cards').select('card_code,image_url,image_url_lg')
      .eq('game', GAME).like('card_code', d.leader_card_code + '%');
    const artRe = new RegExp(`^${d.leader_card_code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(_p\\d+)?$`, 'i');
    leaderArts = (arts || []).filter(c => artRe.test(c.card_code))
      .sort((a, b) => a.card_code.localeCompare(b.card_code));
    const savedArt = localStorage.getItem(artKey(d.id));
    artIdx = Math.max(0, leaderArts.findIndex(c => c.card_code === savedArt));
    $('edArtBtn').style.display = leaderArts.length > 1 ? '' : 'none';
    applyLeaderArt();

    $('decksWrap').style.display = 'none';
    $('editorWrap').style.display = '';
    $('edDeckName').value = d.name;
    setPill('edFormat', d.format || 'standard');
    $('edPublishOpts').style.display = 'none';
    $('edError').textContent = '';
    await reloadDeckCards();
  }

  function applyLeaderArt() {
    const art = leaderArts[artIdx] || leaderCard || {};
    $('edLeaderImg').src = art.image_url_lg || art.image_url || '';
  }

  function cycleLeaderArt() {
    if (leaderArts.length < 2 || !deck) return;
    artIdx = (artIdx + 1) % leaderArts.length;
    localStorage.setItem(artKey(deck.id), leaderArts[artIdx].card_code);
    applyLeaderArt();
  }

  async function reloadDeckCards() {
    const { data: rows } = await window.sb
      .from('deck_cards').select('card_code,quantity,owned').eq('deck_id', deck.id);
    deckCards = rows || [];
    const missing = deckCards.map(r => r.card_code).filter(c => !cardInfo[c]);
    if (missing.length) {
      const { data: cards } = await window.sb
        .from('cards').select('card_code,name,color,cost,type,image_url')
        .eq('game', GAME).in('card_code', missing);
      (cards || []).forEach(c => { cardInfo[c.card_code] = c; });
    }
    renderDeck();
    refreshValidity();
  }

  // Deck contents: one tile per unique card with a x1..x4 / X quantity
  // badge; clicking a tile opens the qty/owned editor row beneath the grid.
  let selectedCode = null;
  let holdJustFired = 0; // timestamp guard so a hold's release click is ignored

  function renderDeck() {
    const grid = $('edDeckGrid');
    grid.innerHTML = '';

    const sorted = deckCards.slice().sort(byCostThenCode);
    if (!sorted.some(r => r.card_code === selectedCode)) selectedCode = null;

    sorted.forEach(r => {
      const c = cardInfo[r.card_code] || {};
      const tile = document.createElement('div');
      tile.className = 'deck-card-tile'
        + (r.card_code === selectedCode ? ' selected' : '')
        + (r.owned < r.quantity ? ' missing' : ''); // owned-short → highlightable
      tile.title = `${c.name || r.card_code} — ${r.quantity} in deck, ${r.owned} owned`;
      // Badge shows total qty normally; while hovering "N missing" the
      // owned-short tiles swap to their missing count (highlighted).
      tile.innerHTML = `
        <img src="${esc(c.image_url || '')}" alt="${esc(c.name || r.card_code)}">
        <span class="qty-badge">
          <span class="qty-total">${r.quantity > 4 ? 'X' : 'x' + r.quantity}</span>
          <span class="qty-missing">x${r.quantity - r.owned}</span>
        </span>`;
      tile.addEventListener('click', () => {
        selectedCode = selectedCode === r.card_code ? null : r.card_code;
        renderDeck();
      });
      grid.appendChild(tile);
    });

    // Static 5-wide grid, minimum 3 rows: pad with empty slots to a full row.
    const padTo = Math.max(15, Math.ceil(sorted.length / 5) * 5);
    for (let i = sorted.length; i < padTo; i++) {
      const ph = document.createElement('div');
      ph.className = 'deck-card-tile empty-slot';
      grid.appendChild(ph);
    }
    renderCardEdit();
  }

  function renderCardEdit() {
    const box = $('edCardEdit');
    const r = deckCards.find(x => x.card_code === selectedCode);
    if (!r) { box.style.display = 'none'; box.innerHTML = ''; return; }
    const c = cardInfo[r.card_code] || {};
    const cap = capFor(r.card_code);
    box.style.display = '';
    box.innerHTML = `
      <img src="${esc(c.image_url || '')}" alt="">
      <div class="row-main">
        <div class="row-name">${esc(c.name || r.card_code)}</div>
        <div class="row-sub">${esc(r.card_code)} · ${esc(c.color || '')} · cost ${c.cost ?? '—'}</div>
      </div>
      <div>
        <span class="stepper-label">Qty</span>
        <div class="stepper" data-kind="qty">
          <button data-d="-1">−</button><span class="val">${r.quantity}</span><button data-d="1" ${cap !== null && r.quantity >= cap ? 'disabled' : ''}>+</button>
        </div>
      </div>
      <div>
        <span class="stepper-label">Owned</span>
        <div class="stepper ${r.owned >= r.quantity ? 'owned-full' : ''}" data-kind="owned">
          <button data-d="-1" ${r.owned <= 0 ? 'disabled' : ''}>−</button><span class="val">${r.owned}/${r.quantity}</span><button data-d="1" ${r.owned >= r.quantity ? 'disabled' : ''}>+</button>
        </div>
      </div>`;
    box.querySelectorAll('.stepper button').forEach(btn => wireStepper(btn, r.card_code));
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
    if (!(code in exceptions)) return 4;
    return exceptions[code]; // null = unlimited
  }

  async function stepCard(code, kind, delta) {
    const row = deckCards.find(r => r.card_code === code);
    if (!row) return;
    $('edError').textContent = '';
    if (kind === 'qty') {
      const q = row.quantity + delta;
      if (q <= 0) {
        const { error } = await window.sb.from('deck_cards').delete().eq('deck_id', deck.id).eq('card_code', code);
        if (error) { $('edError').textContent = error.message; return; }
      } else {
        const { error } = await window.sb.from('deck_cards')
          .update({ quantity: q, owned: Math.min(row.owned, q) })
          .eq('deck_id', deck.id).eq('card_code', code);
        if (error) { $('edError').textContent = error.message; return; }
      }
    } else {
      const o = Math.max(0, Math.min(row.quantity, row.owned + delta));
      const { error } = await window.sb.from('deck_cards')
        .update({ owned: o }).eq('deck_id', deck.id).eq('card_code', code);
      if (error) { $('edError').textContent = error.message; return; }
    }
    await reloadDeckCards();
  }

  // Hold-to-jump: qty min=1 / max=copy cap (50 if unlimited); owned min=0 /
  // max=quantity. (Holding qty "-" stops at 1, never deletes the card.)
  async function setCardValue(code, kind, target) {
    const row = deckCards.find(r => r.card_code === code);
    if (!row) return;
    $('edError').textContent = '';
    if (kind === 'qty') {
      const cap = capFor(code);
      const q = target === 'min' ? 1 : (cap ?? 50);
      if (q === row.quantity) return;
      const { error } = await window.sb.from('deck_cards')
        .update({ quantity: q, owned: Math.min(row.owned, q) })
        .eq('deck_id', deck.id).eq('card_code', code);
      if (error) { $('edError').textContent = error.message; return; }
    } else {
      const o = target === 'min' ? 0 : row.quantity;
      if (o === row.owned) return;
      const { error } = await window.sb.from('deck_cards')
        .update({ owned: o }).eq('deck_id', deck.id).eq('card_code', code);
      if (error) { $('edError').textContent = error.message; return; }
    }
    await reloadDeckCards();
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
    const key = `${deck.id}:${deck.format}`;
    if (traitPoolKey === key) return;
    traitPoolKey = key;
    traitPool = [];
    const colorOr = String(leaderCard.color || '').split('/').filter(Boolean)
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
            (deck.format !== 'standard' || standardLegal(c.card_code))) {
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
    const colorOr = String(leaderCard.color || '').split('/').filter(Boolean)
      .map(c => `color.ilike.%${c}%`).join(',');
    let q = window.sb
      .from('cards')
      .select('card_code,name,color,cost,type,image_url')
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
      (deck.format !== 'standard' || standardLegal(c.card_code))));
    return null;
  }

  async function loadBrowser() {
    if (!deck || !leaderCard) return;
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

  function renderBrowser() {
    const grid = $('cbGrid');
    grid.innerHTML = '';
    const hasMore = cbRows.length > cbShown || !cbDone;
    $('cbCount').textContent = cbShown
      ? `${cbShown}${hasMore ? "+" : ""} cards`
      : 'No legal cards match.';
    cbRows.slice(0, cbShown).forEach(c => {
      const inDeck = deckCards.find(r => r.card_code === c.card_code);
      const tile = document.createElement('button');
      tile.className = 'cb-tile';
      tile.innerHTML = `
        <div class="cb-tile-img">${c.image_url
          ? `<img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.image_url)}" alt="${esc(c.name || c.card_code)}">`
          : `<div class="card-placeholder small">${esc(c.card_code)}</div>`}</div>
        <div class="cb-tile-name">${esc(c.name || '')}${inDeck ? ` <span class="cb-in-deck">x${inDeck.quantity}</span>` : ''}</div>
        <div class="cb-tile-code">${esc(c.card_code)}</div>`;
      tile.addEventListener('click', () => addCard(c));
      grid.appendChild(tile);
    });
    $('cbMore').style.display = hasMore ? '' : 'none';
  }

  async function addCard(card) {
    $('edError').textContent = '';
    $('cbError').textContent = '';
    cardInfo[card.card_code] = card;
    const existing = deckCards.find(r => r.card_code === card.card_code);
    const error = existing
      ? (await window.sb.from('deck_cards')
          .update({ quantity: existing.quantity + 1 })
          .eq('deck_id', deck.id).eq('card_code', card.card_code)).error
      : (await window.sb.from('deck_cards')
          .insert({ deck_id: deck.id, card_code: card.card_code, quantity: 1 })).error;
    if (error) { $('cbError').textContent = error.message; return; } // trigger messages: copies/bans/pairs
    await reloadDeckCards();
    renderBrowser(); // refresh the xN markers without resetting Load More
  }

  async function refreshValidity() {
    const { data: v } = await window.sb.rpc('deck_validity', { p_deck_id: deck.id });
    if (!v) return;
    const total = v.total_cards ?? 0;
    const miss = v.missing_cards ?? 0;
    $('edCounts').innerHTML = `${total}/50 cards · ${v.owned_cards ?? 0} owned · `
      + `<span id="edMissingHover"${miss ? ' class="missing-hover"' : ''}>${miss} missing</span>`;
    if (miss) {
      const hov = $('edMissingHover');
      hov.addEventListener('mouseenter', () => $('edDeckGrid').classList.add('show-missing'));
      hov.addEventListener('mouseleave', () => $('edDeckGrid').classList.remove('show-missing'));
    }
    const fill = $('edCountFill');
    fill.style.width = `${Math.min(100, (total / 50) * 100)}%`;
    fill.classList.toggle('over', total > 50);

    const badges = [];
    if (v.valid) badges.push('<span class="deck-badge ok">deck valid</span>');
    if (v.owned_complete) badges.push('<span class="deck-badge ok">fully owned</span>');
    $('edBadges').innerHTML = badges.join(' ');

    syncPublishUi(v);
  }

  // Eye button + flair pill next to the deck name own the publish state.
  // Why-not-publishable lives in the eye's hover tooltip.
  function syncPublishUi(v) {
    const eye = $('edEyeBtn'), flair = $('edFlair');
    const publishable = !!(v.valid && v.owned_complete);
    if (deck.is_public) {
      eye.classList.add('public');
      eye.disabled = false;
      $('edEyeTip').textContent = 'Public — click to unpublish';
      flair.textContent = deck.listing_type || 'public';
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
      b.classList.toggle('active', deck.is_public && b.dataset.value === deck.listing_type);
    });
  }

  // Eye: private -> reveal the trade/sell/borrow options; public -> unpublish.
  async function onEyeClick() {
    $('edError').textContent = '';
    if (!deck.is_public) {
      const opts = $('edPublishOpts');
      opts.style.display = opts.style.display === 'none' ? '' : 'none';
      return;
    }
    const { error } = await window.sb.rpc('unpublish_deck', { p_deck_id: deck.id });
    if (error) { $('edError').textContent = error.message; return; }
    deck.is_public = false; deck.listing_type = null;
    $('edPublishOpts').style.display = 'none';
    refreshValidity();
  }

  // Picking a type publishes (or re-publishes) with it; server re-validates.
  async function onListingTypeClick(e) {
    const btn = e.target.closest('.pill-choice-btn');
    if (!btn || (deck.is_public && btn.dataset.value === deck.listing_type)) return;
    $('edError').textContent = '';
    const { error } = await window.sb.rpc('publish_deck', { p_deck_id: deck.id, p_listing_type: btn.dataset.value });
    if (error) { $('edError').textContent = error.message; refreshValidity(); return; }
    deck.is_public = true; deck.listing_type = btn.dataset.value;
    $('edPublishOpts').style.display = 'none';
    refreshValidity();
  }

  async function onFormatClick(e) {
    const btn = e.target.closest('.pill-choice-btn');
    if (!btn || !deck || btn.dataset.value === deck.format) return;
    $('edError').textContent = '';
    const { error } = await window.sb.from('decks')
      .update({ format: btn.dataset.value }).eq('id', deck.id);
    if (error) { // e.g. eternal -> standard with rotated cards still in the deck
      setPill('edFormat', deck.format);
      $('edError').textContent = error.message;
      return;
    }
    deck.format = btn.dataset.value;
    refreshValidity();
    if ($('cbOverlay').style.display !== 'none') { ensureTraitPool(); loadBrowser(); } // legality changed
  }

  async function renameDeck() {
    const name = $('edDeckName').value.trim();
    if (!name || !deck) return;
    const { error } = await window.sb.from('decks').update({ name }).eq('id', deck.id);
    if (error) $('edError').textContent = error.message;
    else deck.name = name;
  }

  // ---------------- decklist import / export ----------------
  // Format: one card per line as "NxCODE" (e.g. 4xOP16-091); the leader is
  // its own 1x line. Alt-art suffixes normalize to base codes; duplicate
  // lines sum.

  let dlMode = 'export';

  const byCostThenCode = (a, b) => {
    const ca = cardInfo[a.card_code] || {}, cb = cardInfo[b.card_code] || {};
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
        .from('cards').select('card_code,name,color,cost,type,image_url')
        .eq('game', GAME).in('card_code', codes.slice(i, i + 100));
      (data || []).forEach(c => { out[c.card_code] = c; });
    }
    return out;
  }

  function closeDl() { $('dlOverlay').style.display = 'none'; }

  function openExport() {
    dlMode = 'export';
    $('dlTitle').textContent = 'Export Decklist';
    $('dlHint').textContent = 'Leader first, then one line per card. Copy and share.';
    $('dlError').textContent = '';
    const sorted = deckCards.slice().sort(byCostThenCode);
    $('dlText').value = [`1x${deck.leader_card_code}`, ...sorted.map(r => `${r.quantity}x${r.card_code}`)].join('\n');
    $('dlText').readOnly = true;
    $('dlAction').textContent = 'Copy';
    $('dlOwnedWrap').style.display = 'none'; // export has no owned toggle
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
      if (code !== deck.leader_card_code) {
        errEl.textContent = `This list is led by ${info[code].name} (${code}) — create a deck with that leader, then import there.`;
        return;
      }
      rows.delete(code); // matching leader line: implied, drop it
    }
    const markOwned = $('dlOwned').checked; // owned = quantity for every line
    $('dlAction').disabled = true;
    await window.sb.from('deck_cards').delete().eq('deck_id', deck.id);
    const fails = [];
    for (const [code, qty] of rows) {
      cardInfo[code] = info[code];
      const { error } = await window.sb.from('deck_cards')
        .insert({ deck_id: deck.id, card_code: code, quantity: qty, owned: markOwned ? qty : 0 });
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


  async function deleteDeck() {
    if (!confirm(`Delete "${deck.name}"? This cannot be undone.`)) return;
    const { error } = await window.sb.from('decks').delete().eq('id', deck.id);
    if (error) { $('edError').textContent = error.message; return; }
    showList();
  }

  init();
})();
