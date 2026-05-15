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
  const binderId     = params.get('id');           // new: binder UUID
  const slug         = (params.get('slug') || '').toLowerCase();   // legacy
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
  let currentBinderId = null;     // the binder we're viewing

  async function init() {
    const me = await window.PK.currentUser();
    viewerUserId = me?.id || null;
    const isLoggedIn = !!me;

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
    sleeveImageUrl = binder.sleeve_image_url || null;
    const profile = binder;  // alias for the rest of the function

    // 2. Render header
    const displayName = profile.display_name || 'someone';
    const binderName  = profile.binder_name || 'binder';
    const titleText = `${displayName}'s ${binderName}`;
    const editIcon = isOwner
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
    renderCategory(profile.category || 'optcg');
    renderFlair(profile.flair || 'trade');
    applyLayout(profile.layout || '4x3');
    if (isOwner) { wireFlairSelect(); wireBinderNameEdit(); }

    if (isLoggedIn) {
      const rows = [];
      const boroughs = (profile.boroughs || []).join(', ');
      const subway   = (profile.subway_stops || []).join(', ');
      const shops    = (profile.local_shops || []).join(', ');
      if (boroughs) rows.push(metaRow(ICON_PIN,   boroughs));
      if (subway)   rows.push(metaRow(ICON_TRAIN, subway));
      if (shops)    rows.push(metaRow(ICON_SHOP,  shops));
      document.getElementById('binderMeta').innerHTML = rows.join('');

      // Show Discord contact only when viewer is NOT the owner (no need to contact yourself)
      if (!isOwner && profile.discord_handle) {
        document.getElementById('binderContact').innerHTML =
          `Contact on Discord: <strong>${escapeHtml(profile.discord_handle)}</strong>`;
      }
    } else {
      document.getElementById('binderMeta').innerHTML =
        `<span class="locked-pill"><a href="account.html">Sign in</a> to see location & contact</span>`;
    }

    // 3. Show edit button (owners) or search toggle (non-owners)
    if (isOwner) {
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

    loadListings(isOwner, isLoggedIn);
  }

  const FLAIR_LABELS = { trade: 'Trade Binder', flex: 'Flex Binder', lgs: 'Local Game Store' };
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
      if (aestheticsSortMode !== 'release' && aestheticsSortMode !== 'color' && aestheticsSortMode !== 'cost') {
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
  function exitAesthetics() {
    aestheticsMode = false;
    binderContent.classList.remove('aesthetics');
    const btn = document.getElementById('aestheticsToggle');
    if (btn) btn.setAttribute('aria-pressed', 'false');
    const sel = document.getElementById('aestheticsSort');
    if (sel) sel.style.display = 'none';
    moveExcludeToggle('header');
    setUrlParam('aesthetics', null);
    // Restore custom order for normal viewing.
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
    ['cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity'].forEach(id => {
      document.getElementById(id).addEventListener('change', filterBinderListings);
    });
    document.getElementById('cbName').addEventListener('input', () => {
      clearTimeout(cbDebounceTimer);
      cbDebounceTimer = setTimeout(filterBinderListings, 250);
    });
    document.getElementById('cbClear').addEventListener('click', () => {
      ['cbName','cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity'].forEach(id => {
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

  async function populateDropdowns() {
    // Distinct series — page up to 10000 rows so we don't miss any
    const seriesSet = new Set();
    let from = 0, page = 1000;
    while (from < 10000) {
      const { data, error } = await window.sb.from('cards').select('series').range(from, from + page - 1);
      if (error || !data || data.length === 0) break;
      data.forEach(r => r.series && seriesSet.add(r.series));
      if (data.length < page) break;
      from += page;
    }
    const seriesSel = document.getElementById('cbSeries');
    [...seriesSet].sort().forEach(s => {
      const o = document.createElement('option'); o.value = s; o.textContent = s;
      seriesSel.appendChild(o);
    });

    // Colors — One Piece has a fixed palette; hardcoded for completeness
    const COLORS = ['Red', 'Blue', 'Green', 'Purple', 'Black', 'Yellow'];
    const colorSel = document.getElementById('cbColor');
    COLORS.forEach(c => {
      const o = document.createElement('option'); o.value = c; o.textContent = c;
      colorSel.appendChild(o);
    });

    // Cost: 0 to 10
    const costSel = document.getElementById('cbCost');
    for (let i = 0; i <= 10; i++) {
      const o = document.createElement('option'); o.value = String(i); o.textContent = String(i);
      costSel.appendChild(o);
    }
  }

  function wireBrowserFilters() {
    const onChange = () => { loadCards(); filterBinderListings(); };
    ['cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity'].forEach(id => {
      document.getElementById(id).addEventListener('change', onChange);
    });
    document.getElementById('cbName').addEventListener('input', () => {
      clearTimeout(cbDebounceTimer);
      cbDebounceTimer = setTimeout(onChange, 250);
    });
    document.getElementById('cbClear').addEventListener('click', () => {
      ['cbName','cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity'].forEach(id => {
        document.getElementById(id).value = '';
      });
      onChange();
    });
    // "Show all (ignore filters)" toggle on the binder side — only re-render binder
    const exclude = document.getElementById('cbExcludeBinder');
    if (exclude) exclude.addEventListener('change', filterBinderListings);
  }

  async function loadCards() {
    const name      = document.getElementById('cbName').value.trim();
    const series    = document.getElementById('cbSeries').value;
    const color     = document.getElementById('cbColor').value;
    const ctype     = document.getElementById('cbType').value;
    const cost      = document.getElementById('cbCost').value;
    const attribute = document.getElementById('cbAttribute').value;
    const rarity    = document.getElementById('cbRarity').value;

    let q = window.sb.from('cards').select('card_code, name, series, color, type, cost, attribute, rarity, image_url');
    if (name) {
      const safe = name.replace(/[%,]/g, '');
      q = q.or(`name.ilike.%${safe}%,card_code.ilike.%${safe}%`);
    }
    if (series)    q = q.eq('series', series);
    if (color)     q = q.ilike('color', `%${color}%`);
    if (ctype)     q = q.eq('type', ctype);
    if (cost !== '') q = q.eq('cost', parseInt(cost, 10));
    if (attribute) q = q.eq('attribute', attribute);
    if (rarity)    q = q.eq('rarity', rarity);

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

  async function saveListing() {
    if (!activeCard) return;
    const errEl = document.getElementById('alError');
    errEl.textContent = '';
    const qty   = parseInt(document.getElementById('alQty').value, 10);
    const ltype = document.getElementById('alType').value;
    const notes = null;
    if (!qty || qty < 1) { errEl.textContent = 'Quantity must be at least 1'; return; }

    const { error } = await window.sb.from('listings').insert({
      binder_id: currentBinderId,
      card_code: activeCard.card_code,
      quantity: qty,
      listing_type: ltype,
      notes,
    });
    if (error) { errEl.textContent = error.message; return; }
    localStorage.setItem('pawpaw:lastListingType', ltype);
    closeAddListing();
    loadListings(true, true);   // refresh main grid (still in edit mode)
  }

  let allListings = [];        // full binder cache (used for client-side filtering)
  let currentListings = [];    // currently rendered (full or filtered)
  let currentPage = 1;
  let binderLayout = '4x3';  // set from DB on load
  const getPageSize = () => (binderLayout === '3x3' ? 9 : 12);
  let lastShowEditControls = false;
  let lastIsLoggedIn = false;
  let sleeveImageUrl = null;   // owner's custom sleeve background, applied to every tile

  async function loadListings(showEditControls, isLoggedIn) {
    lastShowEditControls = showEditControls;
    lastIsLoggedIn = isLoggedIn;
    const statusEl = document.getElementById('binderStatus');

    let listings, lerr;
    if (isLoggedIn) {
      ({ data: listings, error: lerr } = await window.sb
        .from('listings')
        .select('id, quantity, listing_type, notes, card_code, sort_order, created_at, cards(name, image_url, color, type, cost, attribute, rarity, series, release_order)')
        .eq('binder_id', currentBinderId)
        .order('sort_order', { ascending: true, nullsFirst: false })
        .order('created_at', { ascending: false }));
    } else {
      const { data: rawListings, error: rerr } = await window.sb.rpc('get_binder_listings_public', { p_binder_id: currentBinderId });
      if (rerr) { lerr = rerr; }
      else {
        const codes = (rawListings || []).map(r => r.card_code);
        let cardsByCode = {};
        if (codes.length) {
          const { data: cards } = await window.sb.from('cards')
            .select('card_code, name, image_url, color, type, cost, attribute, rarity, series, release_order')
            .in('card_code', codes);
          (cards || []).forEach(c => { cardsByCode[c.card_code] = c; });
        }
        listings = (rawListings || []).map(r => ({ ...r, cards: cardsByCode[r.card_code] || {} }));
      }
    }

    if (lerr) {
      statusEl.textContent = 'Error loading listings: ' + lerr.message;
      return;
    }

    allListings = listings || [];
    renderBinderUpdated(allListings);
    renderListings(allListings);
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
    currentPage = 1;
    renderCurrentPage();
  }

  function renderCurrentPage() {
    const grid     = document.getElementById('cardGrid');
    const statusEl = document.getElementById('binderStatus');
    const pagEl    = document.getElementById('binderPagination');
    grid.innerHTML = '';
    pagEl.innerHTML = '';

    const total      = currentListings.length;
    const totalPages = Math.max(1, Math.ceil(total / getPageSize()));
    if (currentPage > totalPages) currentPage = totalPages;
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

    // Pagination controls
    if (totalPages > 1) {
      const prev = pageButton('‹', currentPage > 1, () => { currentPage--; renderCurrentPage(); });
      pagEl.appendChild(prev);
      for (let p = 1; p <= totalPages; p++) {
        pagEl.appendChild(pageButton(String(p), true, () => { currentPage = p; renderCurrentPage(); }, p === currentPage));
      }
      const next = pageButton('›', currentPage < totalPages, () => { currentPage++; renderCurrentPage(); });
      pagEl.appendChild(next);
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
    const typePill = l.listing_type
      ? `<span class="listing-pill listing-${l.listing_type}">${listingLabel(l.listing_type)}</span>`
      : '';
    const notesHtml = '';
    const editControls = lastShowEditControls ? `
      <div class="card-edit-controls">
        <label>Qty <input type="number" min="1" value="${l.quantity}" data-id="${l.id}" class="qty-input form-input small"></label>
        <select class="type-select form-input small" data-id="${l.id}">
          ${(window.LISTING_TYPES || []).map(t =>
            `<option value="${t.value}" ${l.listing_type === t.value ? 'selected' : ''}>${t.label}</option>`).join('')}
        </select>
        <button class="btn small delete-btn" data-id="${l.id}">Remove</button>
      </div>` : '';
    tile.innerHTML = `
      <div class="card-tile-img">
        ${c.image_url ? `<img referrerpolicy="no-referrer" src="${escapeHtml(c.image_url)}" alt="${escapeHtml(c.name || l.card_code)}" onerror="this.outerHTML='<div class=&quot;card-placeholder&quot;>${escapeHtml(l.card_code)}</div>'">` : `<div class="card-placeholder">${escapeHtml(l.card_code)}</div>`}
      </div>
      <div class="card-tile-body">
        <div class="card-tile-meta">
          <span class="card-tile-code">${escapeHtml(l.card_code)}</span>
          <span class="card-tile-qty">×${l.quantity}</span>
        </div>
        ${typePill}
        ${notesHtml}
        ${editControls}
      </div>`;
    return tile;
  }

  function filterBinderListings() {
    // Bypass filters entirely when "Show all (ignore filters)" toggle is on
    const exclude = document.getElementById('cbExcludeBinder');
    if (exclude && exclude.checked) {
      renderListings(allListings);
      return;
    }

    const name      = document.getElementById('cbName').value.trim().toLowerCase();
    const series    = document.getElementById('cbSeries').value;
    const color     = document.getElementById('cbColor').value;
    const ctype     = document.getElementById('cbType').value;
    const cost      = document.getElementById('cbCost').value;
    const attribute = document.getElementById('cbAttribute').value;
    const rarity    = document.getElementById('cbRarity').value;

    const filtered = allListings.filter(l => {
      const c = l.cards || {};
      if (name) {
        const haystack = `${(c.name || '').toLowerCase()} ${l.card_code.toLowerCase()}`;
        if (!haystack.includes(name)) return false;
      }
      if (series && c.series !== series) return false;
      if (color && !((c.color || '').includes(color))) return false;
      if (ctype && c.type !== ctype) return false;
      if (cost !== '' && c.cost !== undefined && c.cost !== parseInt(cost, 10)) return false;
      if (attribute && c.attribute !== attribute) return false;
      if (rarity && c.rarity !== rarity) return false;
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
