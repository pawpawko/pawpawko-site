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
  let isDeckOwner = true;     // viewer owns the open deck (vs. a shared-deck collaborator)
  let openSeq = 0;            // bumped per openDeck() so a stale load can't render over a newer deck
  let leaderCard = null;      // cards row for the leader (base print)
  let leaderArts = [];        // base + _p alt-art prints of the leader
  let artIdx = 0;             // current art (persisted per deck in localStorage)
  const artKey = (deckId) => `pawpaw:deckArt:${deckId}`;
  let cardArt = {};           // base card code -> chosen alt-art row (deck-grid display override)
  const cardArtKey = (deckId) => `pawpaw:deckCardArt:${deckId}`;
  let deckCards = [];         // deck_cards rows
  let cardInfo = {};          // card_code -> cards row
  let ownedElsewhere = {};    // base card_code -> { qty, binders:[name] } across your non-wishlist binders
  let exceptions = {};        // card_code -> max_copies (null = unlimited, 0 = banned)
  let rotatedPrefixes = new Set();  // set prefixes out of Standard (e.g. OP01)
  let rotationExempt = new Set();   // base codes legal despite a rotated prefix

  const isBase = (code) => !/_p\d+$/i.test(code);
  const baseCode = (code) => String(code).split('_')[0];
  // One Piece color letters (U = Blue, since B is taken by Black). Used for the
  // default deck name: "Green/Blue Uta" -> "GU Uta Deck".
  const COLOR_ABBREV = { Red: 'R', Green: 'G', Blue: 'U', Purple: 'P', Black: 'B', Yellow: 'Y' };
  const colorAbbrev = (color) => String(color || '').split('/')
    .map(c => COLOR_ABBREV[c.trim()] || (c.trim()[0] || '').toUpperCase()).join('');
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
    $('edIoBtn').addEventListener('click', (e) => toggleMenu('edIoBtn', 'edIoMenu', e));
    $('edExportBtn').addEventListener('click', () => { closeMenus(); openExport(); });
    $('edExportMissingBtn').addEventListener('click', () => { closeMenus(); openExportMissing(); });
    $('edImportBtn').addEventListener('click', () => { closeMenus(); openImportEditor(); });
    $('edPriceBtn').addEventListener('click', (e) => toggleMenu('edPriceBtn', 'edPriceMenu', e));
    $('edCostDeckBtn').addEventListener('click', () => { closeMenus(); openPrices('deck'); });
    $('edCostFinishBtn').addEventListener('click', () => { closeMenus(); openPrices('finish'); });
    document.addEventListener('click', (e) => { if (!e.target.closest('.deck-io-wrap')) closeMenus(); });
    $('edBenchBtn').addEventListener('click', toggleBench);
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

    const { data: owned, error } = await window.sb
      .from('decks')
      .select('id, name, leader_card_code, is_public, listing_type, format, created_at, updated_at')
      .eq('user_id', user.id)
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
    const { data: leaders } = await window.sb
      .from('cards').select('card_code,name,color,image_url').eq('game', GAME).in('card_code', codes);
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
      .insert({ user_id: user.id, game: GAME, leader_card_code: leader.card_code,
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
    unsubscribeDeckCards();        // drop the editor's Realtime channel
    $('editorWrap').style.display = 'none';
    $('decksWrap').style.display = '';
    deck = null;
    loadDecks();
  }

  // push=true when the user navigates list -> editor (so browser Back
  // returns to the list); deep links and popstate restores replace instead.
  async function openDeck(deckId, push = false) {
    const seq = ++openSeq;
    // Clear the previous deck's cards up front so a slow load never flashes the
    // old deck while the new one is still fetching.
    deckCards = [];
    bench = [];
    $('edDeckGrid').innerHTML = '';
    $('edBenchGrid').innerHTML = '';
    $('edBenchSection').style.display = 'none';
    $('edBenchBtn').setAttribute('aria-expanded', 'false');
    const { data: d, error } = await window.sb.from('decks').select('*').eq('id', deckId).single();
    if (seq !== openSeq) return;             // a newer openDeck() superseded this one
    if (error || !d) { showList(); return; } // stale/foreign id (e.g. old link) -> list
    deck = d;
    isDeckOwner = (d.user_id === user.id);   // collaborators co-edit but can't publish/delete
    // Owner-only controls: publishing and deleting stay with the deck owner.
    $('edEyeBtn').closest('.eye-wrap').style.display = isDeckOwner ? '' : 'none';
    $('edDeleteBtn').style.display = isDeckOwner ? '' : 'none';
    setupDeckCollab();
    const url = `decks.html?deck=${d.id}`; // survives hard refresh
    if (push) history.pushState(null, '', url);
    else history.replaceState(null, '', url);
    const { data: L } = await window.sb
      .from('cards').select('card_code,name,color,image_url,image_url_lg')
      .eq('game', GAME).eq('card_code', d.leader_card_code).single();
    if (seq !== openSeq) return;             // superseded while fetching the leader
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

    // Restore per-card alt-art choices set in the magnified view (deck-grid
    // display overrides); fetch the chosen prints' images so the grid shows them.
    cardArt = {};
    try {
      const saved = JSON.parse(localStorage.getItem(cardArtKey(d.id)) || '{}');
      const codes = Object.values(saved).filter(x => /_p\d+$/i.test(String(x)));
      if (codes.length) {
        const { data: artRows } = await window.sb
          .from('cards').select('card_code,image_url,image_url_lg').eq('game', GAME).in('card_code', codes);
        const byCode = {};
        (artRows || []).forEach(c => { byCode[c.card_code] = c; });
        Object.keys(saved).forEach(base => { const row = byCode[saved[base]]; if (row) cardArt[base] = row; });
      }
    } catch (e) {}

    if (seq !== openSeq) return;
    await loadOwnedElsewhere();
    if (seq !== openSeq) return;
    await reloadDeckCards();
    if (seq !== openSeq) return;
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
    if (!window.sb || !window.sb.channel || !deck) return;
    unsubscribeDeckCards();
    const myId = deck.id;
    deckCardsChannel = window.sb
      .channel('deckcards-' + myId)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'deck_cards', filter: 'deck_id=eq.' + myId },
        () => {
          if (dcPending > 0) return;             // local burst in flight; settle reconciles
          if (!deck || deck.id !== myId) return; // switched decks
          clearTimeout(deckReloadTimer);
          deckReloadTimer = setTimeout(() => {
            if (dcPending === 0 && deck && deck.id === myId) reloadDeckCards();
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
      const { data: collabs } = await window.sb.rpc('deck_collaborators_list', { p_deck_id: deck.id });
      if (isDeckOwner) {
        const list = collabs || [];
        const chips = list.map(c =>
          `<span class="collab-chip">${esc(c.display_name || 'partner')}<button class="collab-remove" data-uid="${c.user_id}" title="Remove" aria-label="Remove">×</button></span>`).join('');
        // One partner per deck — only offer "Add" when there isn't one yet.
        const addBtn = list.length === 0
          ? `<button class="btn small" id="deckShareBtn" type="button">+ Add partner</button>` : '';
        el.innerHTML = `
          <div class="collab-row">
            <span class="collab-label">Share with</span>
            ${chips}
            ${addBtn}
          </div>
          <p class="auth-error" id="deckCollabError"></p>`;
        const addEl = $('deckShareBtn');
        if (addEl) addEl.addEventListener('click', shareDeck);
        el.querySelectorAll('.collab-remove').forEach(b =>
          b.addEventListener('click', () => unshareDeck(b.dataset.uid)));
      } else {
        el.innerHTML = `<div class="collab-row"><span class="collab-label">Shared deck</span> <span class="collab-none">you're a co-editor</span></div>`;
      }
    };

    const shareDeck = async () => {
      const errEl = $('deckCollabError');
      if (errEl) { errEl.textContent = ''; errEl.style.color = ''; }
      const name = prompt("Enter your partner's display name to share this deck with them:");
      if (!name || !name.trim()) return;
      const { error } = await window.sb.rpc('share_deck', { p_deck_id: deck.id, p_display_name: name.trim() });
      if (error) { if (errEl) errEl.textContent = error.message; return; }
      await refresh();
      const e2 = $('deckCollabError');
      if (e2) { e2.style.color = '#7ec96a'; e2.textContent = `Invite sent to ${name.trim()} — they'll get a notification to accept.`; }
    };
    const unshareDeck = async (uid) => {
      if (!confirm('Remove your partner from this deck?')) return;
      const { error } = await window.sb.rpc('unshare_deck', { p_deck_id: deck.id, p_user_id: uid });
      const errEl = $('deckCollabError');
      if (error) { if (errEl) errEl.textContent = error.message; return; }
      refresh();
    };

    refresh();
  }

  // Persist the per-card alt-art overrides for this deck (base -> chosen code).
  function persistCardArt() {
    if (!deck) return;
    const map = {};
    Object.keys(cardArt).forEach(base => { if (cardArt[base]) map[base] = cardArt[base].card_code; });
    try { localStorage.setItem(cardArtKey(deck.id), JSON.stringify(map)); } catch (e) {}
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

  // Cross-check against your collection: how many copies of each card you
  // physically hold in your OTHER (non-wishlist) binders for this game. The
  // wishlist binder is excluded — it's cards you WANT, not own. Built once per
  // deck open and keyed by base code so alt-art prints (OP12-041_p1) count
  // toward the same number the deck tracks.
  async function loadOwnedElsewhere() {
    ownedElsewhere = {};
    if (!deck || !user) return;
    const { data: binders } = await window.sb
      .from('binders').select('id,name,flair')
      .eq('user_id', user.id).eq('category', GAME);
    const owned = (binders || []).filter(b => b.flair !== 'wishlist');
    if (!owned.length) return;
    const nameById = {};
    owned.forEach(b => { nameById[b.id] = b.name || 'Binder'; });
    const { data: rows } = await window.sb
      .from('listings').select('binder_id,card_code,quantity')
      .in('binder_id', owned.map(b => b.id));
    (rows || []).forEach(r => {
      const base = baseCode(r.card_code);
      const e = ownedElsewhere[base] || (ownedElsewhere[base] = { qty: 0, binders: [] });
      e.qty += r.quantity || 0;
      const nm = nameById[r.binder_id];
      if (nm && !e.binders.includes(nm)) e.binders.push(nm);
    });
  }

  async function reloadDeckCards() {
    const myId = deck && deck.id;          // the deck we're loading for
    const { data: rows } = await window.sb
      .from('deck_cards').select('card_code,quantity,owned').eq('deck_id', myId);
    if (!deck || deck.id !== myId) return; // deck switched mid-load — drop stale data
    deckCards = rows || [];
    const missing = deckCards.map(r => r.card_code).filter(c => !cardInfo[c]);
    if (missing.length) {
      const { data: cards } = await window.sb
        .from('cards').select('card_code,name,color,cost,type,image_url,image_url_lg,counter,effect_text,types')
        .eq('game', GAME).in('card_code', missing);
      (cards || []).forEach(c => { cardInfo[c.card_code] = c; });
    }
    if (!deck || deck.id !== myId) return; // re-check after the second await
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
    // Swap-arrows icon for the alt-art toggle.
    const ART_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
    let ov = null;
    let code = null;   // card currently magnified
    let arts = [];     // base print + its _p alt-art variants
    let artIdx = 0;
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
    function renderEdit() {
      const box = ov.querySelector('.cz-edit');
      const r = code ? deckCards.find(x => x.card_code === code) : null;
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
    function applyArt() {
      if (!ov) return;
      const a = arts[artIdx];
      if (a) ov.querySelector('.cz-img').src = a.image_url_lg || a.image_url || '';
      ov.querySelector('.cz-art').hidden = arts.length < 2; // only when alts exist
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
    function cycleArt() {
      if (arts.length < 2) return;
      artIdx = (artIdx + 1) % arts.length;
      applyArt();
      // Persist the choice and reflect it on the deck grid (index 0 = base = no override).
      const base = String(arts[artIdx].card_code).split('_')[0];
      if (artIdx === 0) delete cardArt[base];
      else cardArt[base] = arts[artIdx];
      persistCardArt();
      renderDeck();
    }
    function ensure() {
      if (ov) return ov;
      ov = document.createElement('div');
      ov.className = 'card-zoom-overlay';
      ov.hidden = true;
      ov.innerHTML = '<div class="cz-box"><div class="cz-imgwrap"><img class="cz-img" alt=""><span class="cz-art" role="button" aria-label="Swap art" hidden>' + ART_ICON + '</span></div><div class="cz-edit"></div></div>';
      ov.addEventListener('click', e => { if (e.target === ov) hide(); }); // backdrop only
      ov.querySelector('.cz-art').addEventListener('click', e => { e.stopPropagation(); cycleArt(); });
      document.addEventListener('keydown', e => { if (e.key === 'Escape') hide(); });
      document.body.appendChild(ov);
      return ov;
    }
    async function show(c) {
      const base = String(c.card_code).split('_')[0];
      const override = cardArt[base]; // open on the currently-chosen art, if any
      const url = (override && (override.image_url_lg || override.image_url)) || (c && (c.image_url_lg || c.image_url));
      if (!url) return;
      const el = ensure();
      code = c.card_code;
      arts = []; artIdx = 0;
      el.querySelector('.cz-img').src = url;
      el.querySelector('.cz-art').hidden = true;
      renderEdit();
      el.hidden = false;
      // Reveal the alt-art swap overlay once we know more than the base exists.
      const list = await loadArts(base);
      if (code !== c.card_code) return; // another card opened during the await
      arts = list;
      const chosen = override ? override.card_code : c.card_code;
      artIdx = Math.max(0, list.findIndex(a => a.card_code === chosen));
      applyArt();
    }
    // Keep the open lightbox in sync after a deck-cards reload; close it if the
    // magnified card was removed (qty stepped to 0).
    function refresh() {
      if (!ov || ov.hidden || !code) return;
      if (!deckCards.find(x => x.card_code === code)) { hide(); return; }
      renderEdit();
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

    const sorted = deckCards.slice().sort(byCostThenCode);

    sorted.forEach(r => {
      const c = cardInfo[r.card_code] || {};
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
      const art = cardArt[r.card_code]; // chosen alt-art print (set in magnified view)
      // Collection cross-check: this card is owned-short in the deck but you
      // physically hold copies in a non-wishlist binder. Badge → click to mark
      // owned (bumps deck `owned` up to cover your binder count, never down).
      // Show the badge only when your collection has MORE copies than you've
      // already marked owned — otherwise clicking would be a no-op (it never
      // marks owned beyond what you physically hold).
      const oe = ownedElsewhere[r.card_code];
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
    if (!(code in exceptions)) return 4;
    return exceptions[code]; // null = unlimited
  }

  // ---- Serialized deck-card writes ----
  // Every deck_cards mutation updates the local cache optimistically (instant
  // feedback) and queues its DB write so fast repeated clicks can't race on a
  // stale read — which previously lost increments or dropped duplicate inserts.
  // Each queued writer re-reads the live row, so deltas accumulate correctly.
  // One reconcile fetch runs once the burst settles (also rolling back anything
  // the gatekeeper trigger rejected).
  let dcQueue = Promise.resolve();
  let dcPending = 0;
  function queueDeckWrite(writer) {
    dcPending++;
    const settle = () => { if (--dcPending === 0) reloadDeckCards().then(renderBrowser); };
    dcQueue = dcQueue.then(writer).then(settle, (e) => {
      const msg = (e && e.message) || 'Update failed.';
      $('cbError').textContent = msg;
      $('edError').textContent = msg;
      settle();
    });
  }
  function renderDeckLocal() { renderDeck(); renderBrowser(); cardZoom.refresh(); }
  function localSetRow(code, fields) {
    const row = deckCards.find(r => r.card_code === code);
    if (row) Object.assign(row, fields);
    renderDeckLocal();
  }
  function localRemoveRow(code) {
    const i = deckCards.findIndex(r => r.card_code === code);
    if (i >= 0) deckCards.splice(i, 1);
    renderDeckLocal();
  }
  async function readDeckCard(code) {
    const { data } = await window.sb.from('deck_cards').select('quantity, owned')
      .eq('deck_id', deck.id).eq('card_code', code).maybeSingle();
    return data;
  }

  function stepCard(code, kind, delta) {
    const row = deckCards.find(r => r.card_code === code);
    if (!row) return;
    $('edError').textContent = '';
    if (kind === 'qty') {
      const nq = row.quantity + delta;
      if (nq <= 0) localRemoveRow(code);
      else localSetRow(code, { quantity: nq, owned: Math.min(row.owned, nq) });
      queueDeckWrite(async () => {
        const cur = await readDeckCard(code);
        if (!cur) return;
        const q = cur.quantity + delta;
        if (q <= 0) {
          const { error } = await window.sb.from('deck_cards').delete().eq('deck_id', deck.id).eq('card_code', code);
          if (error) throw error;
        } else {
          const { error } = await window.sb.from('deck_cards')
            .update({ quantity: q, owned: Math.min(cur.owned, q) }).eq('deck_id', deck.id).eq('card_code', code);
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
          .update({ owned: o }).eq('deck_id', deck.id).eq('card_code', code);
        if (error) throw error;
      });
    }
  }

  // Hold-to-jump: qty min=1 / max=copy cap (50 if unlimited); owned min=0 /
  // max=quantity. (Holding qty "-" stops at 1, never deletes the card.)
  function setCardValue(code, kind, target) {
    const row = deckCards.find(r => r.card_code === code);
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
          .update({ quantity: q, owned: Math.min(cur.owned, q) }).eq('deck_id', deck.id).eq('card_code', code);
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
          .update({ owned: oo }).eq('deck_id', deck.id).eq('card_code', code);
        if (error) throw error;
      });
    }
  }

  // Set an exact value from typed input (magnified-view qty/owned fields).
  // qty: clamped to [0, cap] (0 removes the card); owned: clamped to [0, qty].
  function setCardAbsolute(code, kind, value) {
    const row = deckCards.find(r => r.card_code === code);
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
          const { error } = await window.sb.from('deck_cards').delete().eq('deck_id', deck.id).eq('card_code', code);
          if (error) throw error;
        } else {
          const { error } = await window.sb.from('deck_cards')
            .update({ quantity: target, owned: Math.min(cur.owned, target) }).eq('deck_id', deck.id).eq('card_code', code);
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
          .update({ owned: o }).eq('deck_id', deck.id).eq('card_code', code);
        if (error) throw error;
      });
    }
  }

  // ---------------- bench (local-only staging) + drag-and-drop ----------------
  // The bench holds extra candidate cards that are NOT in the 50. It lives per
  // deck in localStorage only, so server-side validity / wishlist sync /
  // Cost-to-Finish (all keyed off the 50 in deck_cards) are untouched. Drag a
  // bench card onto a deck card to swap, or onto the deck/bench to move across.
  let bench = [];            // [{ code, qty }]
  let dragSrc = null;        // { zone:'deck'|'bench', code } while dragging

  function benchKey(id) { return `pawpaw:deckBench:${id}`; }
  function saveBench() { try { localStorage.setItem(benchKey(deck.id), JSON.stringify(bench)); } catch (e) {} }
  function readBenchLocal() {
    try {
      const a = JSON.parse(localStorage.getItem(benchKey(deck.id)) || '[]');
      return Array.isArray(a) ? a.filter(x => x && x.code && x.qty > 0).map(x => ({ code: x.code, qty: x.qty })) : [];
    } catch (e) { return []; }
  }
  async function loadBench() {
    bench = readBenchLocal();
    const need = bench.map(b => b.code).filter(c => !cardInfo[c]);
    if (need.length) {
      const { data } = await window.sb.from('cards')
        .select('card_code,name,color,cost,type,image_url,image_url_lg,counter,effect_text,types')
        .eq('game', GAME).in('card_code', need);
      (data || []).forEach(c => { cardInfo[c.card_code] = c; });
    }
    renderBench();
  }
  function benchCount() { return bench.reduce((s, b) => s + b.qty, 0); }
  function updateBenchBtn() { const btn = $('edBenchBtn'); if (btn) btn.textContent = `Bench (${benchCount()}) ▾`; }
  function benchAdd(code, qty) {
    const e = bench.find(x => x.code === code);
    if (e) e.qty += qty; else bench.push({ code, qty });
    saveBench(); renderBench();
  }
  function benchRemove(code) {
    const i = bench.findIndex(x => x.code === code);
    if (i >= 0) bench.splice(i, 1);
    saveBench(); renderBench();
  }
  function toggleBench() {
    const sec = $('edBenchSection');
    const show = !sec.style.display || sec.style.display === 'none';
    sec.style.display = show ? '' : 'none';
    $('edBenchBtn').setAttribute('aria-expanded', show ? 'true' : 'false');
  }

  // Insert / raise / remove a deck card to an exact quantity, creating or
  // deleting the deck_cards row as needed (new rows start owned=0). Optimistic +
  // queued, like the other deck-card writers.
  function setDeckQtyAbsolute(code, target) {
    const cap = capFor(code);
    if (cap !== null) target = Math.min(target, cap);
    target = Math.max(0, target);
    const existing = deckCards.find(r => r.card_code === code);
    if (target <= 0) localRemoveRow(code);
    else if (existing) localSetRow(code, { quantity: target, owned: Math.min(existing.owned, target) });
    else { deckCards.push({ card_code: code, quantity: target, owned: 0 }); renderDeckLocal(); }
    queueDeckWrite(async () => {
      const cur = await readDeckCard(code);
      if (target <= 0) {
        if (cur) { const { error } = await window.sb.from('deck_cards').delete().eq('deck_id', deck.id).eq('card_code', code); if (error) throw error; }
      } else if (cur) {
        const { error } = await window.sb.from('deck_cards').update({ quantity: target, owned: Math.min(cur.owned, target) }).eq('deck_id', deck.id).eq('card_code', code);
        if (error) throw error;
      } else {
        const { error } = await window.sb.from('deck_cards').insert({ deck_id: deck.id, card_code: code, quantity: target, owned: 0 });
        if (error) throw error;
      }
    });
  }

  function moveDeckToBench(code) {
    const row = deckCards.find(r => r.card_code === code);
    if (!row) return;
    $('edError').textContent = '';
    benchAdd(code, row.quantity);
    setDeckQtyAbsolute(code, 0);
  }
  function addBenchToDeck(code) {
    const b = bench.find(x => x.code === code);
    if (!b) return;
    const cap = capFor(code);
    const cur = (deckCards.find(r => r.card_code === code) || {}).quantity || 0;
    let target = cur + b.qty;
    if (cap !== null) target = Math.min(target, cap);
    if (target <= cur) { $('edError').textContent = `Already at the max ${cap} cop${cap === 1 ? 'y' : 'ies'} of ${code}.`; return; }
    benchRemove(code);
    setDeckQtyAbsolute(code, target);
  }
  function swapBenchIntoDeck(deckCode, benchCode) {
    if (deckCode === benchCode) return;
    const a = deckCards.find(r => r.card_code === deckCode);
    const b = bench.find(x => x.code === benchCode);
    if (!a || !b) return;
    $('edError').textContent = '';
    const qa = a.quantity;
    const capB = capFor(benchCode);
    const curB = (deckCards.find(r => r.card_code === benchCode) || {}).quantity || 0;
    let targetB = curB + qa;
    if (capB !== null) targetB = Math.min(targetB, capB);
    benchRemove(benchCode);
    benchAdd(deckCode, qa);
    setDeckQtyAbsolute(deckCode, 0);
    setDeckQtyAbsolute(benchCode, targetB);
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

  function renderBench() {
    updateBenchBtn();
    const grid = $('edBenchGrid');
    if (!grid) return;
    grid.innerHTML = '';
    if (!bench.length) {
      grid.innerHTML = '<p class="deck-bench-empty">Drag a card here from your deck to bench it. Cards you add past 50 land here too.</p>';
      return;
    }
    bench.slice().sort((x, y) => byCostThenCode({ card_code: x.code }, { card_code: y.code })).forEach(b => {
      const c = cardInfo[b.code] || {};
      const tile = document.createElement('div');
      tile.className = 'deck-card-tile bench-tile';
      tile.title = `${c.name || b.code} — benched ×${b.qty}`;
      tile.innerHTML = `
        <img src="${esc(c.image_url || '')}" alt="${esc(c.name || b.code)}">
        <div class="card-acts">
          <button class="card-act bench-up" aria-label="Move to deck" title="Move to deck">▲</button>
          <button class="card-act bench-del" aria-label="Remove from bench" title="Remove from bench">✕</button>
        </div>
        <span class="qty-badge"><span class="qty-total">${b.qty > 4 ? 'X' : 'x' + b.qty}</span></span>`;
      makeDragHandle(tile, 'bench', b.code);
      tile.querySelector('.bench-up').addEventListener('click', e => { e.stopPropagation(); addBenchToDeck(b.code); });
      tile.querySelector('.bench-del').addEventListener('click', e => { e.stopPropagation(); benchRemove(b.code); });
      grid.appendChild(tile);
    });
  }

  // ---------------- deck stats (over the 50; excludes leader + bench) ----------------
  const SEARCH_RE = /look at the top (\d+) cards? of your deck/i;
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
    $('stOverlay').style.display = '';
    const body = $('stBody');
    if (!deckCards.length) { body.innerHTML = '<p class="text-muted-line">No cards in the deck yet.</p>'; return; }

    let c2000 = 0, c1000 = 0, cNone = 0, total = 0;
    const costB = {};
    deckCards.forEach(r => {
      const c = cardInfo[r.card_code] || {};
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

    const searchers = deckCards.filter(r => SEARCH_RE.test((cardInfo[r.card_code] || {}).effect_text || ''));
    let searchHtml;
    if (!searchers.length) {
      searchHtml = '<p class="text-muted-line">No searchers detected.</p>';
    } else {
      const rows = searchers.map(r => {
        const c = cardInfo[r.card_code] || {};
        const m = (c.effect_text || '').match(SEARCH_RE);
        const N = m ? parseInt(m[1], 10) : 5;
        const tm = (c.effect_text || '').match(/\{([^}]+)\}/);
        let T, label;
        if (tm) {
          const trait = tm[1];
          label = `{${trait}}`;
          T = deckCards.reduce((s, x) => { const ci = cardInfo[x.card_code] || {}; return s + (Array.isArray(ci.types) && ci.types.includes(trait) ? x.quantity : 0); }, 0);
        } else {
          label = 'Characters';
          T = deckCards.reduce((s, x) => { const ci = cardInfo[x.card_code] || {}; return s + (ci.type === 'CHARACTER' ? x.quantity : 0); }, 0);
        }
        const pct = Math.round(hitChance(total, T, N) * 100);
        return `<tr><td>${esc(c.name || r.card_code)} <span class="pc-code">×${r.quantity}</span></td><td class="num">top ${N}</td><td class="num">${T} <span class="pc-code">${esc(label)}</span></td><td class="num">${pct}%</td></tr>`;
      }).join('');
      searchHtml = `<table class="st-search"><thead><tr><th>Searcher</th><th class="num">Depth</th><th class="num">Targets</th><th class="num">Hit %</th></tr></thead><tbody>${rows}</tbody></table>`;
    }
    const searchSection = `
      <div class="st-section">
        <h4>Searchers <span class="text-muted-line" style="font-weight:400;text-transform:none;letter-spacing:0;">— estimated chance to hit a target in the top N</span></h4>
        ${searchHtml}
      </div>`;

    body.innerHTML = `<p class="text-muted-line">${total} card${total === 1 ? '' : 's'} in the deck${total !== 50 ? ' (not 50 yet)' : ''}.</p>` + counters + costCurve + searchSection;
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
          : `<div class="card-placeholder small">${esc(c.card_code)}</div>`}${c.image_url ? `<div class="card-acts">${zoomBtnHTML()}</div>` : ''}</div>
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
  function addCard(card) {
    $('edError').textContent = '';
    $('cbError').textContent = '';
    cardInfo[card.card_code] = card;
    const deckTotal = deckCards.reduce((s, r) => s + r.quantity, 0);
    if (deckTotal >= 50) { // deck is full — overflow lands on the bench
      benchAdd(card.card_code, 1);
      $('cbError').textContent = `Deck is at 50 — ${card.card_code} added to the bench.`;
      return;
    }
    const owned = $('cbOwned').checked; // count the added copy as owned
    const existing = deckCards.find(r => r.card_code === card.card_code);
    const cap = capFor(card.card_code); // null = unlimited
    if (existing && cap !== null && existing.quantity >= cap) {
      $('cbError').textContent = `Max ${cap} cop${cap === 1 ? 'y' : 'ies'} of ${card.card_code}.`;
      return;
    }
    // Optimistic local update — instant ×N bump, no reload between clicks.
    if (existing) localSetRow(card.card_code, { quantity: existing.quantity + 1, owned: owned ? existing.owned + 1 : existing.owned });
    else { deckCards.push({ card_code: card.card_code, quantity: 1, owned: owned ? 1 : 0 }); renderDeckLocal(); }

    queueDeckWrite(async () => {
      const cur = await readDeckCard(card.card_code);
      if (cur) {
        const { error } = await window.sb.from('deck_cards')
          .update({ quantity: cur.quantity + 1, owned: owned ? (cur.owned || 0) + 1 : cur.owned })
          .eq('deck_id', deck.id).eq('card_code', card.card_code);
        if (error) throw error;
      } else {
        const { error } = await window.sb.from('deck_cards')
          .insert({ deck_id: deck.id, card_code: card.card_code, quantity: 1, owned: owned ? 1 : 0 });
        if (error) throw error;
      }
    });
  }

  async function refreshValidity() {
    const { data: v } = await window.sb.rpc('deck_validity', { p_deck_id: deck.id });
    if (!v) return;
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
    const fill = $('edCountFill');
    fill.style.width = `${Math.min(100, (total / 50) * 100)}%`;
    fill.classList.toggle('over', total > 50);
    fill.classList.toggle('ok', total <= 50 && v.valid && v.owned_complete); // green only when valid + fully owned

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
    const sorted = deckCards.slice().sort(byCostThenCode);
    $('dlText').value = [`1x${deck.leader_card_code}`, ...sorted.map(r => `${r.quantity}x${r.card_code}`)].join('\n');
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
    const missing = deckCards.filter(r => r.quantity - r.owned > 0).sort(byCostThenCode);
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


  // ---------------- cost to finish (missing-card prices) ----------------
  // Sums each still-needed copy (quantity − owned) at its cached cheapest
  // single price (cards.price_usd, kept fresh by scripts/update_prices.py).
  // Mirrors the manual price breakdown: dearest cards on top, grand total.

  function closePrices() { $('pcOverlay').style.display = 'none'; }

  async function openPrices(mode) {
    const isDeck = mode === 'deck';
    $('pcTitle').textContent = isDeck ? 'Cost of Deck' : 'Cost to Finish';
    $('pcSub').textContent = isDeck
      ? 'The whole deck — leader plus every card at full quantity — at each card’s cheapest single price.'
      : 'The cards you still need (deck quantity minus what you own), at each card’s cheapest single price.';
    $('pcOverlay').style.display = '';
    $('pcTotal').textContent = '';
    $('pcFoot').textContent = '';
    $('pcBody').innerHTML = '<p class="text-muted-line">Pricing…</p>';

    // Deck = leader + every card at full quantity; Finish = only the copies you're short.
    const items = isDeck
      ? [{ code: deck.leader_card_code, need: 1 }, ...deckCards.map(r => ({ code: r.card_code, need: r.quantity }))]
      : deckCards.map(r => ({ code: r.card_code, need: r.quantity - r.owned })).filter(x => x.need > 0);
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
      const info = cardInfo[x.code] || {};
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
    // Deck "owned" copies aren't tracked as binder listings, so they'd be lost
    // on delete. A single custom modal offers to move them to the trade binder
    // first (native confirm() chains get suppressed after the first dialog).
    const ownedRows = deckCards.filter(r => r.owned > 0);
    const ownedCopies = ownedRows.reduce((s, r) => s + r.owned, 0);

    const act = await confirmDeleteDeck(deck.name, ownedCopies);
    if (act === 'cancel') return;
    if (act === 'move') {
      const ok = await returnOwnedToCollection(ownedRows);
      if (!ok) return; // error surfaced; keep the deck so the cards aren't lost
    }

    const { error } = await window.sb.from('decks').delete().eq('id', deck.id);
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
      .select('id,name,flair').eq('user_id', user.id).eq('category', GAME).eq('flair', 'trade');
    let target = (binders || [])[0];
    if (!target) {
      const { data: nb, error: ce } = await window.sb.from('binders')
        .insert({ user_id: user.id, name: 'Collection', category: GAME, flair: 'trade' })
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

  init();
})();
