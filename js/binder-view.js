// ============================================
// Binder page — unified view + (owner-only) edit
// URL: /binders/<slug>  (Netlify rewrites to binder.html?slug=<slug>)
// Falls back to ?user=<userId> for backwards compat.
// ============================================

(function () {
  const setupNotice = document.getElementById('setupNotice');
  setupNotice.innerHTML = window.PK.notReadyMessage();
  if (!window.SB_READY) return;

  const params       = new URLSearchParams(location.search);
  let   binderId     = params.get('id');           // binder UUID (canonical)
  const slug         = (params.get('slug') || '').toLowerCase();   // pretty share link
  const userId       = params.get('user');         // legacy fallback
  const autoEditMode = params.get('edit') === '1' || params.get('aesthetics') === '1';
  const autoAesthetics = params.get('aesthetics') === '1';

  if (!binderId && !slug && !userId) {
    document.getElementById('binderStatus').textContent = 'No binder specified.';
    return;
  }

  const binderContent = document.getElementById('binderContent');
  const editBtn       = document.getElementById('editBtn');
  const doneBtn       = document.getElementById('doneBtn');
  const actionsBar    = document.getElementById('binderActions');

  let ownerUserId = null;
  let viewerUserId = null;
  let isOwner = false;
  let isCollab = false;           // viewer is a shared-binder collaborator (co-editor)
  let canEdit = false;            // isOwner || isCollab — may edit the binder + its cards
  let currentBinderId = null;     // the binder we're viewing
  let binderCategory = 'optcg';   // 'optcg' | 'pokemon' — drives filter UI + card-browser query
  let binderFlair = null;         // binder flair ('wishlist' enables deck-origin surfacing)

  // Game-specific option lists for the card-browser filters.
  const OPTCG_COLORS     = ['Red', 'Blue', 'Green', 'Purple', 'Black', 'Yellow'];
  const OPTCG_TYPES      = ['LEADER', 'CHARACTER', 'EVENT', 'STAGE'];
  const OPTCG_ATTRIBUTES = ['Slash', 'Strike', 'Special', 'Wisdom', 'Ranged'];
  const OPTCG_RARITIES   = ['L', 'C', 'UC', 'R', 'SR', 'SEC', 'P'];
  const POKEMON_TYPES = [
    'Grass','Fire','Water','Lightning','Psychic','Fighting',
    'Darkness','Metal','Dragon','Colorless','Fairy'
  ];
  const POKEMON_SUPERTYPES = ['Pokémon', 'Trainer', 'Energy'];
  // Rarity sort order, rarest → most common (per game; values are disjoint so
  // one combined list is fine). Unknown / null rarities sort last.
  const RARITY_ORDER = [
    // One Piece (rarest first; leaders + promos grouped at the end)
    'SEC', 'SP CARD', 'TR', 'SR', 'R', 'UC', 'C', 'L', 'P',
    // Pokémon
    'Rare Secret', 'Rare Holo EX', 'Rare Holo', 'Rare', 'Uncommon', 'Common', 'Promo'
  ];
  const POKEMON_SUBTYPES = [
    'Basic','Stage 1','Stage 2','V','VMAX','VSTAR','ex','EX','GX',
    'BREAK','Mega','LEGEND','Tag Team','Radiant','Item','Tool','Stadium','Supporter'
  ];
  const POKEMON_RARITIES = [
    'Common','Uncommon','Rare','Rare Holo','Rare Holo EX','Rare Holo GX','Rare Holo V','Rare Holo VMAX',
    'Rare Ultra','Rare Secret','Rare Rainbow','Radiant Rare','Amazing Rare',
    'Illustration Rare','Special Illustration Rare','Hyper Rare','Double Rare','Promo'
  ];
  const POKEMON_HP_BUCKETS = [30, 60, 90, 120, 150, 180, 210, 240, 270, 300];

  async function init() {
    const me = await window.PK.currentUser();
    viewerUserId = me?.id || null;
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

    currentBinderId = binder.id;
    ownerUserId = binder.user_id;
    isOwner = isLoggedIn && viewerUserId === ownerUserId;
    // Shared binders: a collaborator (e.g. a partner) co-edits the same binder.
    isCollab = false;
    if (isLoggedIn && !isOwner) {
      const { data: cr } = await window.sb
        .from('binder_collaborators').select('user_id')
        .eq('binder_id', currentBinderId).eq('user_id', viewerUserId).maybeSingle();
      isCollab = !!cr;
    }
    canEdit = isOwner || isCollab;
    sleeveImageUrl = binder.sleeve_image_url || null;
    binderCategory = binder.category === 'pokemon' ? 'pokemon' : 'optcg';
    binderFlair = binder.flair || null;
    applyGameUI(binderCategory);
    const profile = binder;  // alias for the rest of the function

    // 2. Render header
    const displayName = profile.display_name || 'someone';
    const binderName  = profile.binder_name || 'binder';
    const titleText = `${displayName}'s ${binderName}`;
    const editIcon = canEdit
      ? `<button type="button" id="binderNameEditBtn" class="binder-name-edit-btn" aria-label="Edit binder name" title="Edit name">
           <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
             <path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.04a1 1 0 0 0 0-1.42l-2.5-2.5a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75 2-1.66Z"/>
           </svg>
         </button>`
      : '';
    document.getElementById('binderTitle').innerHTML =
      `${escapeHtml(displayName)}'s <span class="binder-name-group"><em id="binderNameView">${escapeHtml(binderName)}</em>${editIcon}</span>`;
    document.title = `${titleText} — Pawpaw Ko`;
    setupShare(profile);
    setupCollab();   // owner: manage sharing; collaborator: shows who it's shared with
    renderCategory(profile.category || 'optcg');
    renderFlair(profile.flair || 'trade');
    applyLayout(profile.layout || '4x3');
    if (canEdit) { wireFlairSelect(); wireBinderNameEdit(); }

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
      if (!canEdit && profile.discord_handle) {
        document.getElementById('binderContact').innerHTML =
          `Contact on Discord: <strong>${escapeHtml(profile.discord_handle)}</strong>`;
      }
    } else {
      document.getElementById('binderMeta').innerHTML =
        `<span class="locked-pill"><a href="account.html">Sign in</a> to see location & contact</span>`;
    }

    // 3. Show edit button (owner or collaborator) or search toggle (viewers)
    if (canEdit) {
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
    if (canEdit) subscribeBinderRealtime();

    // Restore the page the user was last on for this binder (survives refresh).
    const savedPage = parseInt(sessionStorage.getItem('pawpaw:binderPage:' + currentBinderId), 10);
    if (savedPage > 1) pendingKeepPage = savedPage;
    loadListings(canEdit, isLoggedIn);
  }

  const FLAIR_LABELS = { trade: 'Trade Binder', wishlist: 'Wishlist Binder', flex: 'Flex Binder', lgs: 'Local Game Store' };
  const CATEGORY_LABELS = { optcg: 'OPTCG', pokemon: 'Pokémon' };

  function renderCategory(category) {
    const el = document.getElementById('binderCategory');
    if (!el) return;
    const cat = category || 'optcg';
    el.textContent = CATEGORY_LABELS[cat] || CATEGORY_LABELS.optcg;
    el.className = `category-pill cat-${cat}`;
    el.style.display = '';
  }

  function renderFlair(flair) {
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
        .update({ name: next }).eq('id', currentBinderId);
      if (error) { alert('Could not rename binder: ' + error.message); view.textContent = original; return; }
      original = next;
      document.title = `${document.getElementById('binderTitle').textContent.split("'s")[0]}'s ${next} — Pawpaw Ko`;
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
          .update({ flair: newFlair }).eq('id', currentBinderId);
        if (error) { alert('Could not update flair: ' + error.message); return; }
        renderFlair(newFlair);
      });
    });
  }

  function enterEdit() {
    binderContent.classList.add('editing');
    document.body.classList.add('binder-editing');
    actionsBar.style.display = 'none';   // hides Edit Binder button row
    doneBtn.style.display = '';          // Done lives in the title row
    if (!cardBrowserInited) initCardBrowser();
    wireAestheticsToggle();
    setUrlParam('edit', '1');
  }
  function exitEdit() {
    binderContent.classList.remove('editing');
    document.body.classList.remove('binder-editing');
    actionsBar.style.display = '';       // show Edit Binder again
    doneBtn.style.display = 'none';
    if (aestheticsMode) exitAesthetics();
    setUrlParam('edit', null);
    setUrlParam('aesthetics', null);
  }

  // ---------- Aesthetics mode (rearrange cards) ----------
  let aestheticsMode = false;
  let aestheticsWired = false;

  function wireAestheticsToggle() {
    if (aestheticsWired) return;
    const btn = document.getElementById('aestheticsToggle');
    if (!btn) return;
    aestheticsWired = true;
    btn.addEventListener('click', () => {
      aestheticsMode ? exitAesthetics() : enterAesthetics();
    });
  }
  const COLOR_ORDER = ['Red', 'Blue', 'Green', 'Purple', 'Black', 'Yellow'];
  let aestheticsSortMode = 'custom-4x3';

  function applyLayout(layout) {
    binderLayout = (layout === '3x3') ? '3x3' : '4x3';
    binderContent.classList.toggle('layout-3x3', binderLayout === '3x3');
    binderContent.classList.toggle('layout-4x3', binderLayout === '4x3');
    currentPage = 1;
  }

  async function saveLayout(layout) {
    applyLayout(layout);
    const { error } = await window.sb.from('binders')
      .update({ layout }).eq('id', currentBinderId);
    if (error) console.warn('layout save failed:', error.message);
  }

  function applySortMode(mode) {
    aestheticsSortMode = mode;
    if (mode === 'custom-4x3' || mode === 'custom-3x3') {
      const targetLayout = (mode === 'custom-3x3') ? '3x3' : '4x3';
      if (targetLayout !== binderLayout) saveLayout(targetLayout);
      // Custom sort = use saved sort_order (natural order of allListings).
      currentListings = allListings.slice();
    } else if (mode === 'release') {
      currentListings = allListings.slice().sort((a, b) =>
        (b.cards?.release_order || 0) - (a.cards?.release_order || 0) ||
        String(a.card_code).localeCompare(b.card_code));
    } else if (mode === 'color') {
      const rank = c => { const i = COLOR_ORDER.indexOf(c?.cards?.color); return i < 0 ? 99 : i; };
      currentListings = allListings.slice().sort((a, b) =>
        rank(a) - rank(b) ||
        (a.cards?.cost || 0) - (b.cards?.cost || 0) ||
        String(a.card_code).localeCompare(b.card_code));
    } else if (mode === 'cost') {
      currentListings = allListings.slice().sort((a, b) =>
        (a.cards?.cost ?? 99) - (b.cards?.cost ?? 99) ||
        String(a.card_code).localeCompare(b.card_code));
    } else if (mode === 'rarity') {
      // Group by rarity (rarest first); within each rarity, newest release first.
      const rank = c => { const i = RARITY_ORDER.indexOf(c?.cards?.rarity); return i < 0 ? 99 : i; };
      currentListings = allListings.slice().sort((a, b) =>
        rank(a) - rank(b) ||
        (b.cards?.release_order || 0) - (a.cards?.release_order || 0) ||
        String(a.card_code).localeCompare(b.card_code));
    } else if (mode === 'ptype') {
      // Pokémon elemental type. Sort by the first listed type, fall
      // back alphabetical; ties broken by HP desc then card_code.
      const rank = c => {
        const t = (c?.cards?.types || [])[0];
        const i = POKEMON_TYPES.indexOf(t);
        return i < 0 ? 99 : i;
      };
      currentListings = allListings.slice().sort((a, b) =>
        rank(a) - rank(b) ||
        (b.cards?.hp || 0) - (a.cards?.hp || 0) ||
        String(a.card_code).localeCompare(b.card_code));
    } else if (mode === 'hp') {
      currentListings = allListings.slice().sort((a, b) =>
        (b.cards?.hp ?? -1) - (a.cards?.hp ?? -1) ||
        String(a.card_code).localeCompare(b.card_code));
    } else if (mode === 'supertype') {
      const rank = c => {
        const i = POKEMON_SUPERTYPES.indexOf(c?.cards?.supertype);
        return i < 0 ? 99 : i;
      };
      currentListings = allListings.slice().sort((a, b) =>
        rank(a) - rank(b) ||
        String(a.card_code).localeCompare(b.card_code));
    }
    currentPage = 1;
    renderCurrentPage();
  }

  function wireAestheticsSort() {
    const sel = document.getElementById('aestheticsSort');
    if (!sel || sel.dataset.wired) return;
    sel.dataset.wired = '1';
    sel.addEventListener('change', () => applySortMode(sel.value));
  }

  function setUrlParam(key, value) {
    const url = new URL(window.location.href);
    if (value === null || value === undefined) url.searchParams.delete(key);
    else url.searchParams.set(key, value);
    window.history.replaceState({}, '', url);
  }

  function enterAesthetics() {
    aestheticsMode = true;
    binderContent.classList.add('aesthetics');
    document.getElementById('aestheticsToggle').setAttribute('aria-pressed', 'true');
    const sel = document.getElementById('aestheticsSort');
    if (sel) {
      sel.style.display = '';
      // Default the dropdown to whichever custom layout the binder currently uses.
      const NON_CUSTOM_SORTS = ['release','rarity','color','cost','ptype','hp','supertype'];
      if (!NON_CUSTOM_SORTS.includes(aestheticsSortMode)) {
        aestheticsSortMode = (binderLayout === '3x3') ? 'custom-3x3' : 'custom-4x3';
      }
      sel.value = aestheticsSortMode;
    }
    wireAestheticsSort();
    moveExcludeToggle('filter-bar');
    setUrlParam('aesthetics', '1');
    setUrlParam('edit', '1');
    renderCurrentPage();
  }
  async function exitAesthetics() {
    aestheticsMode = false;
    binderContent.classList.remove('aesthetics');
    const btn = document.getElementById('aestheticsToggle');
    if (btn) btn.setAttribute('aria-pressed', 'false');
    const sel = document.getElementById('aestheticsSort');
    if (sel) sel.style.display = 'none';
    moveExcludeToggle('header');
    setUrlParam('aesthetics', null);
    // If an auto-sort (release / rarity / color / cost / …) is active, bake the
    // sorted order in as the binder's new saved order so it persists after
    // exiting — otherwise the view would snap back to the old custom order.
    // (Manual custom layouts are already saved on drag.) Guard on equal length
    // so a stray filtered view can never drop cards.
    const isAuto = aestheticsSortMode !== 'custom-4x3' && aestheticsSortMode !== 'custom-3x3';
    if (isAuto && currentListings.length === allListings.length) {
      allListings = currentListings.slice();
      await persistPositions();
      aestheticsSortMode = (binderLayout === '3x3') ? 'custom-3x3' : 'custom-4x3';
      if (sel) sel.value = aestheticsSortMode;
    }
    currentListings = allListings.slice();
    renderCurrentPage();
  }

  function moveExcludeToggle(target) {
    const toggle = document.getElementById('excludeBinderToggle');
    if (!toggle) return;
    if (target === 'filter-bar') {
      // Wrap Clear filters + toggle in a flex row at the end of the filter bar.
      const filterBar = document.getElementById('editFilters');
      const clearBtn  = document.getElementById('cbClear');
      if (!filterBar || !clearBtn) return;
      let endRow = document.getElementById('filterEndRow');
      if (!endRow) {
        endRow = document.createElement('div');
        endRow.id = 'filterEndRow';
        endRow.className = 'filter-end-row';
        filterBar.appendChild(endRow);
      }
      toggle.classList.add('exclude-toggle-bottom');
      endRow.appendChild(toggle);    // toggle on the left
      endRow.appendChild(clearBtn);  // Clear filters on the right
    } else {
      // Restore Clear back to filter bar directly; toggle back to cards header.
      const filterBar = document.getElementById('editFilters');
      const clearBtn  = document.getElementById('cbClear');
      const endRow    = document.getElementById('filterEndRow');
      const header    = document.querySelector('.binder-cards-header');
      if (clearBtn && filterBar) filterBar.appendChild(clearBtn);
      if (header && toggle.parentElement !== header) {
        toggle.classList.remove('exclude-toggle-bottom');
        header.appendChild(toggle);
      }
      if (endRow) endRow.remove();
    }
  }

  // Drag-and-drop reorder within currentListings.
  // Persists by writing `sort_order` (0..N-1) for affected rows.
  let dragSrcId = null;
  function attachDragHandlers(tile, listing) {
    tile.setAttribute('draggable', 'true');
    tile.dataset.listingId = listing.id;
    tile.addEventListener('dragstart', e => {
      dragSrcId = listing.id;
      tile.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', listing.id); } catch (_) {}
    });
    tile.addEventListener('dragend', () => {
      tile.classList.remove('dragging');
      document.querySelectorAll('.card-tile.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    tile.addEventListener('dragover', e => {
      if (!dragSrcId || dragSrcId === listing.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      tile.classList.add('drag-over');
    });
    tile.addEventListener('dragleave', () => tile.classList.remove('drag-over'));
    tile.addEventListener('drop', async e => {
      e.preventDefault();
      tile.classList.remove('drag-over');
      const srcId = dragSrcId;
      const dstId = listing.id;
      dragSrcId = null;
      if (!srcId || srcId === dstId) return;
      await moveListing(srcId, dstId);
    });
  }

  async function moveListing(srcId, dstId) {
    // If user reorders while in an auto-sort, that becomes the new custom.
    if (aestheticsSortMode !== 'custom-4x3' && aestheticsSortMode !== 'custom-3x3') {
      allListings = currentListings.slice();
      aestheticsSortMode = (binderLayout === '3x3') ? 'custom-3x3' : 'custom-4x3';
      const sel = document.getElementById('aestheticsSort');
      if (sel) sel.value = aestheticsSortMode;
    }
    const srcIdx = allListings.findIndex(l => l.id === srcId);
    const dstIdx = allListings.findIndex(l => l.id === dstId);
    if (srcIdx < 0 || dstIdx < 0) return;
    const [moved] = allListings.splice(srcIdx, 1);
    allListings.splice(dstIdx, 0, moved);
    await persistPositions();
    currentListings = allListings.slice();
    renderCurrentPage();
  }

  async function persistPositions() {
    // Write sort_order = index for every listing. Could be optimized to only the affected range.
    const updates = allListings.map((l, i) => ({ id: l.id, sort_order: i, binder_id: currentBinderId, card_code: l.card_code, quantity: l.quantity, listing_type: l.listing_type }));
    // Use single upsert keyed on id.
    const { error } = await window.sb.from('listings').upsert(updates, { onConflict: 'id' });
    if (error) console.warn('reorder save failed:', error.message);
    allListings.forEach((l, i) => { l.sort_order = i; });
  }

  // "Move to page N" click handler — replaces openAddListing in aesthetics mode.
  async function openMovePagePicker(listing) {
    const total = currentListings.length;
    const pageSize = getPageSize();
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    if (totalPages < 2) { alert('Only one page so far.'); return; }
    const input = prompt(`Move "${listing.cards?.name || listing.card_code}" to which page? (1–${totalPages})`);
    const target = parseInt((input || '').trim(), 10);
    if (!target || target < 1 || target > totalPages) return;
    const srcIdx = allListings.findIndex(l => l.id === listing.id);
    if (srcIdx < 0) return;
    // Remove and re-insert at end-of-target-page sort_order.
    const [moved] = allListings.splice(srcIdx, 1);
    // After removal, target-page end index is min(target*pageSize, len) - 1, then +1 for insertion point.
    const insertAt = Math.min(target * pageSize, allListings.length);
    allListings.splice(insertAt, 0, moved);
    await persistPositions();
    currentListings = allListings.slice();
    currentPage = target;
    renderCurrentPage();
  }

  // ----- Non-owner search mode -----
  let searchInited = false;
  function toggleSearch() {
    const btn = document.getElementById('searchThisBinder');
    const wasPressed = btn.getAttribute('aria-pressed') === 'true';
    const nowPressed = !wasPressed;
    btn.setAttribute('aria-pressed', String(nowPressed));
    if (nowPressed) {
      binderContent.classList.add('searching');
      if (!searchInited) {
        initSearchFilters();
        searchInited = true;
      }
      filterBinderListings();
    } else {
      binderContent.classList.remove('searching');
      renderListings(allListings);
    }
  }

  async function initSearchFilters() {
    await populateDropdowns();
    ['cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity','cbSupertype','cbSubtype','cbHp'].forEach(id => {
      document.getElementById(id).addEventListener('change', filterBinderListings);
    });
    document.getElementById('cbName').addEventListener('input', () => {
      clearTimeout(cbDebounceTimer);
      cbDebounceTimer = setTimeout(filterBinderListings, 250);
    });
    document.getElementById('cbClear').addEventListener('click', () => {
      ['cbName','cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity','cbSupertype','cbSubtype','cbHp'].forEach(id => {
        document.getElementById(id).value = '';
      });
      filterBinderListings();
    });
  }

  // ------------------- Card browser -------------------
  let cardBrowserInited = false;
  let cbDebounceTimer = null;

  async function initCardBrowser() {
    cardBrowserInited = true;
    await populateDropdowns();
    wireBrowserFilters();
    loadCards();
    wireAddListingModal();
  }

  // Toggle filter groups and sort-options that are scoped to one game.
  // Elements with data-game-filter / data-game-opt that don't match the
  // current game are hidden so they neither render nor get read by the
  // load/filter code paths (which check the input value, which stays '').
  function applyGameUI(category) {
    document.querySelectorAll('[data-game-filter]').forEach(el => {
      el.style.display = el.dataset.gameFilter === category ? '' : 'none';
    });
    document.querySelectorAll('#aestheticsSort [data-game-opt]').forEach(opt => {
      opt.hidden = opt.dataset.gameOpt !== category;
    });
    // Update the Search placeholder so the example card-code matches.
    const searchInput = document.getElementById('cbName');
    if (searchInput) {
      searchInput.placeholder = category === 'pokemon'
        ? 'Pikachu, sv1-1, …'
        : 'Luffy, OP01-001, …';
    }
  }

  function appendOptions(selectEl, values) {
    if (!selectEl) return;
    values.forEach(v => {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = String(v);
      selectEl.appendChild(o);
    });
  }

  async function populateDropdowns() {
    // Distinct series for the active game only — paginated up to 10k rows
    // so very long catalogs (Pokémon ~17k) don't lose sets.
    const seriesSet = new Set();
    let from = 0, page = 1000;
    while (from < 20000) {
      const { data, error } = await window.sb
        .from('cards').select('series')
        .eq('game', binderCategory)
        .range(from, from + page - 1);
      if (error || !data || data.length === 0) break;
      data.forEach(r => r.series && seriesSet.add(r.series));
      if (data.length < page) break;
      from += page;
    }
    const seriesSel = document.getElementById('cbSeries');
    // Series-name display rule: a hyphen survives ONLY when it's part of a
    // series code (e.g. "OP-01", "sv1-1" — letter/digit on each side). Drop
    // " - " separators, stand-alone word hyphens, and any leading/trailing
    // dashes. Value stays raw so the `.eq('series', …)` query still matches.
    // Applies to all sets, current and future.
    const prettySeries = (raw) => raw
      .replace(/\s+-\s+/g, ' ')
      .replace(/([A-Za-z])-([A-Za-z])/g, '$1 $2')
      .replace(/^[\s-]+|[\s-]+$/g, '')
      .replace(/\s{2,}/g, ' ');
    [...seriesSet].sort().forEach(s => {
      const o = document.createElement('option'); o.value = s; o.textContent = prettySeries(s);
      seriesSel.appendChild(o);
    });

    if (binderCategory === 'pokemon') {
      appendOptions(document.getElementById('cbType'),      POKEMON_TYPES);
      appendOptions(document.getElementById('cbSupertype'), POKEMON_SUPERTYPES);
      appendOptions(document.getElementById('cbSubtype'),   POKEMON_SUBTYPES);
      appendOptions(document.getElementById('cbHp'),        POKEMON_HP_BUCKETS);
      appendOptions(document.getElementById('cbRarity'),    POKEMON_RARITIES);
    } else {
      appendOptions(document.getElementById('cbColor'),     OPTCG_COLORS);
      appendOptions(document.getElementById('cbType'),      OPTCG_TYPES);
      appendOptions(document.getElementById('cbCost'),      Array.from({ length: 11 }, (_, i) => i));
      appendOptions(document.getElementById('cbAttribute'), OPTCG_ATTRIBUTES);
      appendOptions(document.getElementById('cbRarity'),    OPTCG_RARITIES);
    }
  }

  function wireBrowserFilters() {
    const onChange = () => { loadCards(); filterBinderListings(); };
    ['cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity','cbSupertype','cbSubtype','cbHp'].forEach(id => {
      document.getElementById(id).addEventListener('change', onChange);
    });
    document.getElementById('cbName').addEventListener('input', () => {
      clearTimeout(cbDebounceTimer);
      cbDebounceTimer = setTimeout(onChange, 250);
    });
    document.getElementById('cbClear').addEventListener('click', () => {
      ['cbName','cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity','cbSupertype','cbSubtype','cbHp'].forEach(id => {
        document.getElementById(id).value = '';
      });
      onChange();
    });
    // "Show all (ignore filters)" toggle on the binder side — only re-render binder
    const exclude = document.getElementById('cbExcludeBinder');
    if (exclude) exclude.addEventListener('change', filterBinderListings);
  }

  async function loadCards() {
    const name   = document.getElementById('cbName').value.trim();
    const series = document.getElementById('cbSeries').value;
    const ctype  = document.getElementById('cbType').value;
    const rarity = document.getElementById('cbRarity').value;

    // Game-aware select list so Pokémon-only columns come back when
    // we need them for client-side filtering / display.
    const projection = binderCategory === 'pokemon'
      ? 'card_code, name, series, type, types, supertype, subtypes, hp, rarity, image_url'
      : 'card_code, name, series, color, type, cost, attribute, rarity, image_url';

    let q = window.sb.from('cards')
      .select(projection)
      .eq('game', binderCategory);

    if (name) {
      const safe = name.replace(/[%,]/g, '');
      q = q.or(`name.ilike.%${safe}%,card_code.ilike.%${safe}%`);
    }
    if (series) q = q.eq('series', series);
    if (rarity) q = q.eq('rarity', rarity);

    if (binderCategory === 'pokemon') {
      const supertype = document.getElementById('cbSupertype').value;
      const subtype   = document.getElementById('cbSubtype').value;
      const hpMin     = document.getElementById('cbHp').value;
      // Pokémon `type` filter targets the `types` text[] column. Use
      // `cs` (contains) so a card listed as ['Lightning'] matches the
      // Lightning option.
      if (ctype)     q = q.contains('types', [ctype]);
      if (supertype) q = q.eq('supertype', supertype);
      if (subtype)   q = q.contains('subtypes', [subtype]);
      if (hpMin)     q = q.gte('hp', parseInt(hpMin, 10));
    } else {
      const color     = document.getElementById('cbColor').value;
      const cost      = document.getElementById('cbCost').value;
      const attribute = document.getElementById('cbAttribute').value;
      if (color)        q = q.ilike('color', `%${color}%`);
      if (ctype)        q = q.eq('type', ctype);
      if (cost !== '')  q = q.eq('cost', parseInt(cost, 10));
      if (attribute)    q = q.eq('attribute', attribute);
    }

    const { data, error } = await q
      .order('release_order', { ascending: false })
      .order('card_code', { ascending: false })
      .limit(120);

    const grid     = document.getElementById('cbGrid');
    const countEl  = document.getElementById('cbCount');
    grid.innerHTML = '';

    if (error) { countEl.textContent = 'Error: ' + error.message; return; }
    if (!data || data.length === 0) { countEl.textContent = 'No cards match.'; cbAllResults = []; renderCbPage(); return; }

    cbAllResults = data;
    cbPage = 1;
    countEl.textContent = `${data.length}${data.length >= 120 ? '+' : ''} cards`;
    renderCbPage();
  }

  let cbAllResults = [];
  let cbPage = 1;
  const CB_PAGE_SIZE = 15;  // 3x5

  function renderCbPage() {
    const grid = document.getElementById('cbGrid');
    const pag  = document.getElementById('cbPagination');
    grid.innerHTML = '';
    if (pag) pag.innerHTML = '';
    const total = cbAllResults.length;
    if (!total) return;
    const totalPages = Math.max(1, Math.ceil(total / CB_PAGE_SIZE));
    if (cbPage > totalPages) cbPage = totalPages;
    const start = (cbPage - 1) * CB_PAGE_SIZE;
    const slice = cbAllResults.slice(start, start + CB_PAGE_SIZE);
    slice.forEach(c => {
      const tile = document.createElement('button');
      tile.className = 'cb-tile';
      tile.innerHTML = `
        <div class="cb-tile-img">
          ${c.image_url ? `<img loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(c.image_url)}" alt="${escapeHtml(c.name || c.card_code)}" onerror="this.outerHTML='<div class=&quot;card-placeholder small&quot;>${escapeHtml(c.card_code)}</div>'">` : `<div class="card-placeholder small">${escapeHtml(c.card_code)}</div>`}
        </div>
        <div class="cb-tile-name">${escapeHtml(c.name || '')}</div>
        <div class="cb-tile-code">${escapeHtml(c.card_code)}</div>`;
      tile.addEventListener('click', () => openAddListing(c));
      grid.appendChild(tile);
    });
    if (pag && totalPages > 1) {
      const mkBtn = (label, enabled, onClick, isActive) => {
        const b = document.createElement('button');
        b.className = 'page-btn' + (isActive ? ' active' : '');
        b.textContent = label;
        b.disabled = !enabled;
        if (enabled) b.addEventListener('click', onClick);
        return b;
      };
      pag.appendChild(mkBtn('‹', cbPage > 1, () => { cbPage--; renderCbPage(); }));
      for (let p = 1; p <= totalPages; p++) {
        pag.appendChild(mkBtn(String(p), true, () => { cbPage = p; renderCbPage(); }, p === cbPage));
      }
      pag.appendChild(mkBtn('›', cbPage < totalPages, () => { cbPage++; renderCbPage(); }));
    }
  }

  // ------------------- Add-to-binder modal -------------------
  let activeCard = null;

  function wireAddListingModal() {
    document.getElementById('addListingClose').addEventListener('click', closeAddListing);
    document.getElementById('alSave').addEventListener('click', saveListing);
    document.getElementById('alRemove').addEventListener('click', removeAllListingsForCard);
  }

  async function openAddListing(card) {
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
    if (alTypeRow) alTypeRow.style.display = (binderFlair === 'wishlist') ? 'none' : '';
    document.getElementById('alError').textContent = '';
    document.getElementById('addListingModal').style.display = '';

    // If this card is already in the binder, surface a Remove option
    const { data: existing } = await window.sb
      .from('listings').select('id').eq('binder_id', currentBinderId).eq('card_code', card.card_code);
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
    const { error } = await window.sb
      .from('listings').delete().eq('binder_id', currentBinderId).eq('card_code', activeCard.card_code);
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
    const isWishlist = binderFlair === 'wishlist';
    // Wishlist cards carry no trade/sell status — store an inert default.
    const ltype = isWishlist ? 'trade' : document.getElementById('alType').value;
    const notes = null;
    if (!qty || qty < 1) { errEl.textContent = 'Quantity must be at least 1'; return; }

    savingListing = true;
    const { error } = await window.sb.from('listings').insert({
      binder_id: currentBinderId,
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
    pendingFocusCode = activeCard.card_code;
    closeAddListing();
    loadListings(true, true);   // refresh main grid (still in edit mode)
  }

  let allListings = [];        // full binder cache (used for client-side filtering)
  let decksById = {};          // deck_id → {id,name,leader_card_code} for wishlist deck-origin pills
  let currentListings = [];    // currently rendered (full or filtered)
  let currentPage = 1;
  let pendingFocusCode = null; // card_code to scroll the binder to after the next render (e.g. just-added card)
  let pendingKeepPage = null;  // page number to stay on across the next render (e.g. after "Got it")
  let binderLayout = '4x3';  // set from DB on load
  const getPageSize = () => (binderLayout === '3x3' ? 9 : 12);
  let lastShowEditControls = false;
  let lastIsLoggedIn = false;
  let sleeveImageUrl = null;   // owner's custom sleeve background, applied to every tile

  async function loadListings(showEditControls, isLoggedIn) {
    lastShowEditControls = showEditControls;
    lastIsLoggedIn = isLoggedIn;
    const statusEl = document.getElementById('binderStatus');

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
        .eq('binder_id', currentBinderId)
        .order('sort_order', { ascending: true, nullsFirst: false })
        // Un-placed cards (null sort_order) append at the end: oldest first,
        // newest last. So auto-added rows (e.g. deck wishlist sync) land at
        // the bottom of the binder rather than jumping to page one.
        .order('created_at', { ascending: true });
      lerr = res.error;
      rawListings = res.data;
    } else {
      const { data, error } = await window.sb.rpc('get_binder_listings_public', { p_binder_id: currentBinderId });
      lerr = error;
      rawListings = data;
    }

    if (!lerr) {
      const codes = (rawListings || []).map(r => r.card_code);
      let cardsByCode = {};
      if (codes.length) {
        const { data: cards } = await window.sb.from('cards')
          .select('card_code, name, image_url, color, type, cost, attribute, rarity, series, release_order, supertype, subtypes, types, hp')
          .eq('game', binderCategory)
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
    decksById = {};
    if (isOwner && binderFlair === 'wishlist') {
      const deckIds = [...new Set((listings || []).map(l => l.deck_id).filter(Boolean))];
      if (deckIds.length) {
        const { data: decks } = await window.sb
          .from('decks').select('id, name, leader_card_code').in('id', deckIds);
        (decks || []).forEach(d => { decksById[d.id] = d; });
      }
    }

    allListings = listings || [];
    renderDeckFilter();
    renderBinderUpdated(allListings);
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
    if (ps !== lastPageSize) { lastPageSize = ps; currentPage = 1; renderCurrentPage(); }
  });

  function renderListings(listings) {
    currentListings = listings || [];
    if (pendingKeepPage != null) {
      // Stay on the page the user was on (e.g. after "Got it"); renderCurrentPage
      // clamps to the new total if a card dropped off.
      currentPage = pendingKeepPage;
      pendingKeepPage = null;
    } else {
      // Default to page 1, unless a card was flagged to focus (e.g. just added) —
      // then jump to the page that card lands on.
      currentPage = 1;
      if (pendingFocusCode) {
        const idx = currentListings.findIndex(l => l.card_code === pendingFocusCode);
        if (idx >= 0) currentPage = Math.floor(idx / getPageSize()) + 1;
        pendingFocusCode = null;
      }
    }
    renderCurrentPage();
  }

  function renderCurrentPage() {
    const grid     = document.getElementById('cardGrid');
    const statusEl = document.getElementById('binderStatus');
    const pagEl    = document.getElementById('binderPagination');
    const pagTopEl = document.getElementById('binderPaginationTop');
    grid.innerHTML = '';
    pagEl.innerHTML = '';
    if (pagTopEl) pagTopEl.innerHTML = '';

    const total      = currentListings.length;
    const totalPages = Math.max(1, Math.ceil(total / getPageSize()));
    if (currentPage > totalPages) currentPage = totalPages;
    // Remember the current page so a browser refresh lands here again.
    try { sessionStorage.setItem('pawpaw:binderPage:' + currentBinderId, currentPage); } catch (e) {}
    const start = (currentPage - 1) * getPageSize();
    const pageItems = currentListings.slice(start, start + getPageSize());

    // Status
    const filteredSuffix = (total !== allListings.length) ? ` of ${allListings.length}` : '';
    if (total === 0) {
      statusEl.textContent = lastShowEditControls
        ? 'No cards yet. Click Edit Binder, then add some.'
        : 'No cards in this binder yet.';
    } else {
      statusEl.textContent = `${total}${filteredSuffix} listing${total === 1 ? '' : 's'}` +
        (totalPages > 1 ? ` · Page ${currentPage} of ${totalPages}` : '');
    }

    // Render 25 slots — fill with cards, then empty placeholders to fill the 5x5
    for (let i = 0; i < getPageSize(); i++) {
      const l = pageItems[i];
      if (l) {
        const tile = buildListingTile(l);
        if (aestheticsMode) {
          tile.classList.add('aesthetics-tile');
          attachDragHandlers(tile, l);
          tile.addEventListener('click', e => {
            // Intercept any inner clicks — open move-to-page picker instead.
            e.preventDefault();
            e.stopPropagation();
            openMovePagePicker(l);
          }, true);
        }
        grid.appendChild(tile);
      } else {
        const empty = document.createElement('div');
        empty.className = 'card-tile empty-slot';
        if (sleeveImageUrl) {
          empty.classList.add('has-sleeve');
          empty.style.backgroundImage = `url(${sleeveImageUrl})`;
        }
        grid.appendChild(empty);
      }
    }

    // Pagination controls — mirror the same ‹ 1 2 3 › row above and below the grid.
    const goToPage = (p) => { currentPage = p; renderCurrentPage(); };
    const buildPagination = (container) => {
      if (!container || totalPages <= 1) return;
      container.appendChild(pageButton('‹', currentPage > 1, () => goToPage(currentPage - 1)));
      for (let p = 1; p <= totalPages; p++) {
        container.appendChild(pageButton(String(p), true, () => goToPage(p), p === currentPage));
      }
      container.appendChild(pageButton('›', currentPage < totalPages, () => goToPage(currentPage + 1)));
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
      sidePrev.disabled = currentPage <= 1;
      sideNext.disabled = currentPage >= totalPages;
      sidePrev.onclick = () => { if (currentPage > 1) goToPage(currentPage - 1); };
      sideNext.onclick = () => { if (currentPage < totalPages) goToPage(currentPage + 1); };
    }

    if (lastShowEditControls) wireEditHandlers();
  }

  function pageButton(label, enabled, onClick, isActive) {
    const b = document.createElement('button');
    b.className = 'page-btn' + (isActive ? ' active' : '');
    b.textContent = label;
    b.disabled = !enabled;
    if (enabled) b.addEventListener('click', onClick);
    return b;
  }

  function buildListingTile(l) {
    const c = l.cards || {};
    const tile = document.createElement('div');
    tile.className = 'card-tile';
    if (sleeveImageUrl) {
      tile.classList.add('has-sleeve');
      tile.style.backgroundImage = `url(${sleeveImageUrl})`;
    }
    const deck = l.deck_id ? decksById[l.deck_id] : null;
    const isWishlist = binderFlair === 'wishlist';
    // Wishlist cards have no trade/sell status — never show the listing pill.
    const typePill = (l.listing_type && !deck && !isWishlist)
      ? `<span class="listing-pill listing-${l.listing_type}">${listingLabel(l.listing_type)}</span>`
      : '';
    const deckPill = deck
      ? `<span class="deck-pill" title="Needed for your &quot;${escapeHtml(deck.name || 'deck')}&quot; deck">🃏 ${escapeHtml(deck.name || 'deck')}</span>`
      : '';
    const qtyHtml = deck
      ? `<span class="card-tile-qty card-tile-need">×${l.quantity}</span>`
      : `<span class="card-tile-qty">×${l.quantity}</span>`;
    // Owner action on a wishlist binder: mark a card as received (got it).
    const receivedBtn = (isWishlist && lastShowEditControls)
      ? `<button class="received-btn" data-id="${l.id}" title="Mark this card as collected">GOT IT!</button>`
      : '';
    const notesHtml = '';
    const editControls = lastShowEditControls ? `
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
        ${c.image_url ? `<img referrerpolicy="no-referrer" src="${escapeHtml(c.image_url)}" alt="${escapeHtml(c.name || l.card_code)}" onerror="this.outerHTML='<div class=&quot;card-placeholder&quot;>${escapeHtml(l.card_code)}</div>'">` : `<div class="card-placeholder">${escapeHtml(l.card_code)}</div>`}
      </div>
      <div class="card-tile-body">
        <div class="card-tile-meta">
          <span class="card-tile-code">${escapeHtml(l.card_code)}</span>
          ${qtyHtml}
        </div>
        ${typePill}
        ${isWishlist ? `<div class="deck-pill-slot">${deckPill}</div>` : deckPill}
        ${receivedBtn}
        ${notesHtml}
        ${editControls}
      </div>`;
    return tile;
  }

  // Populate + reveal the "For deck" filter on wishlist binders (owner-only).
  // Options: All cards / Deck cards only / Manual only / one per deck present.
  let deckFilterWired = false;
  function renderDeckFilter() {
    const group = document.getElementById('deckFilterGroup');
    const sel   = document.getElementById('cbDeck');
    if (!group || !sel) return;

    const deckIds = [...new Set(allListings.map(l => l.deck_id).filter(Boolean))]
      .filter(id => decksById[id]);
    if (!isOwner || binderFlair !== 'wishlist' || !deckIds.length) {
      group.style.display = 'none';
      sel.value = '';
      return;
    }

    const prev = sel.value;
    let html = '<option value="">All cards</option>'
      + '<option value="__deck__">Deck cards only</option>'
      + '<option value="__manual__">Manual only</option>';
    deckIds
      .map(id => decksById[id])
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

  function filterBinderListings() {
    // Bypass filters entirely when "Show all (ignore filters)" toggle is on
    const exclude = document.getElementById('cbExcludeBinder');
    if (exclude && exclude.checked) {
      renderListings(allListings);
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

    const filtered = allListings.filter(l => {
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

      if (binderCategory === 'pokemon') {
        // `type` here means elemental type, stored as text[] in `types`.
        if (ctype && !(Array.isArray(c.types) && c.types.includes(ctype))) return false;
        if (supertype && c.supertype !== supertype) return false;
        if (subtype && !(Array.isArray(c.subtypes) && c.subtypes.includes(subtype))) return false;
        if (hpMin && (c.hp == null || c.hp < parseInt(hpMin, 10))) return false;
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
        await window.sb.from('listings').update({ quantity: q }).eq('id', id);
      });
    });
    grid.querySelectorAll('.type-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        await window.sb.from('listings').update({ listing_type: sel.value }).eq('id', sel.dataset.id);
      });
    });
    grid.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this listing?')) return;
        await window.sb.from('listings').delete().eq('id', btn.dataset.id);
        loadListings(true, true);
      });
    });
    grid.querySelectorAll('.received-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        burstSparkles(e.clientX, e.clientY);
        const l = allListings.find(x => x.id === btn.dataset.id);
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
    const idx = allListings.findIndex(x => x.id === l.id);
    if (idx >= 0) {
      const row = allListings[idx];
      if ((row.quantity || 1) > 1) allListings[idx] = { ...row, quantity: row.quantity - 1 };
      else allListings.splice(idx, 1);
    }
    pendingKeepPage = currentPage; // stay on the page the user is viewing
    filterBinderListings();        // re-render the current view from the updated cache

    // Persist in the background, serialized so concurrent clicks can't read a
    // stale owned/quantity and lose increments.
    receiveQueue = receiveQueue
      .then(() => persistReceive(l))
      .catch(err => console.warn('mark-collected failed:', err && err.message));
  }

  async function persistReceive(l) {
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
    if (!canEdit) { el.style.display = 'none'; return; }
    // Only trade binders support a co-editing partner — wishlist/flex/lgs can't
    // be shared. (Collaborators only ever exist on trade binders, so the
    // collaborator-view branch below is unaffected.)
    if (isOwner && binderFlair !== 'trade') { el.style.display = 'none'; return; }
    el.style.display = '';

    const refresh = async () => {
      const { data: collabs } = await window.sb
        .rpc('binder_collaborators_list', { p_binder_id: currentBinderId });
      if (isOwner) {
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
      const { error } = await window.sb.rpc('share_binder', { p_binder_id: currentBinderId, p_display_name: name.trim() });
      if (error) { if (errEl) errEl.textContent = error.message; return; }
      await refresh();
      const e2 = document.getElementById('collabError');
      if (e2) { e2.style.color = '#7ec96a'; e2.textContent = `Invite sent to ${name.trim()} — they'll get a notification to accept.`; }
    };
    const removeCollab = async (uid) => {
      if (!confirm('Remove this person from the binder?')) return;
      const { error } = await window.sb.rpc('unshare_binder', { p_binder_id: currentBinderId, p_user_id: uid });
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
    if (!window.sb || !window.sb.channel || !currentBinderId) return;
    if (realtimeChannel) { try { window.sb.removeChannel(realtimeChannel); } catch (e) {} realtimeChannel = null; }
    realtimeChannel = window.sb
      .channel('binder-' + currentBinderId)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'listings', filter: 'binder_id=eq.' + currentBinderId },
        () => {
          if (aestheticsMode) return; // don't yank the grid out from under a drag
          pendingKeepPage = currentPage;
          loadListings(canEdit, lastIsLoggedIn);
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

    const shareUrl = `${location.origin}/binder.html?id=${currentBinderId}`;
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

  function listingLabel(t) {
    return ({trade:'Trade Only', sell:'Sell Only', free:'Free', combo:'Trade or Sell'})[t] || t;
  }
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // ----- Meta row icons -----
  const ICON_PIN = '<svg class="meta-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>';
  const ICON_TRAIN = '<svg class="meta-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c-4 0-8 .5-8 4v9.5C4 17.4 5.6 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.9 0 3.5-1.6 3.5-3.5V6c0-3.5-3.6-4-8-4zm-3.5 14a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm7 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM18 11H6V6h12v5z"/></svg>';
  const ICON_SHOP = '<svg class="meta-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M21.9 8.89l-1.05-4.37c-.22-.9-1-1.52-1.91-1.52H5.05c-.9 0-1.69.63-1.9 1.52L2.1 8.89c-.24 1.02-.02 2.06.62 2.88.08.11.19.19.28.29V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-6.94c.09-.09.2-.18.28-.28.64-.82.87-1.87.62-2.89zM13 19H5v-5.04c.13.01.26.04.39.04.91 0 1.74-.38 2.36-1 .62.62 1.45 1 2.39 1 .91 0 1.74-.38 2.36-1 .62.62 1.45 1 2.39 1V19zm5.61-6c-.6 0-1.18-.25-1.61-.69L16 11.06l-1.01 1.26c-.43.43-1 .68-1.61.68-.6 0-1.18-.25-1.61-.69L11 11.06l-1.01 1.26c-.43.43-1 .68-1.61.68-.6 0-1.18-.25-1.61-.69L6 11.06l-1.01 1.26c-.43.44-1.01.68-1.61.68z"/></svg>';

  function metaRow(icon, text) {
    return `<span class="meta-row">${icon}<span>${escapeHtml(text)}</span></span>`;
  }

  init();
})();
