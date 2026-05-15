// ============================================
// Trades page — search/filter binders (one per user)
// ============================================

(function () {
  // ----- Pill-in-dropdown helper -----
  function buildPillDropdown(opts) {
    const { values, pillsEl, btnEl, panelEl, labelEl, defaultLabel } = opts;
    values.forEach(v => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'filter-pill-toggle';
      pill.dataset.value = v;
      pill.textContent = v;
      pill.setAttribute('aria-pressed', 'false');
      pill.addEventListener('click', () => {
        pill.classList.toggle('active');
        pill.setAttribute('aria-pressed', pill.classList.contains('active'));
        refreshLabel();
      });
      pillsEl.appendChild(pill);
    });
    function selected() {
      return [...pillsEl.querySelectorAll('.filter-pill-toggle.active')].map(p => p.dataset.value);
    }
    function refreshLabel() {
      const sel = selected();
      labelEl.textContent = sel.length === 0 ? defaultLabel
        : sel.length === 1 ? sel[0]
        : `${sel.length} selected`;
    }
    function reset() {
      pillsEl.querySelectorAll('.filter-pill-toggle').forEach(p => {
        p.classList.remove('active');
        p.setAttribute('aria-pressed', 'false');
      });
      refreshLabel();
    }
    btnEl.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !panelEl.hasAttribute('hidden');
      if (open) panelEl.setAttribute('hidden', '');
      else      panelEl.removeAttribute('hidden');
      btnEl.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', (e) => {
      if (!panelEl.contains(e.target) && !btnEl.contains(e.target)) {
        panelEl.setAttribute('hidden', '');
        btnEl.setAttribute('aria-expanded', 'false');
      }
    });
    return { selected, reset };
  }

  const boroughDD = buildPillDropdown({
    values:    window.NYC_BOROUGHS || [],
    pillsEl:   document.getElementById('boroughPills'),
    btnEl:     document.getElementById('boroughBtn'),
    panelEl:   document.getElementById('boroughPanel'),
    labelEl:   document.getElementById('boroughLabel'),
    defaultLabel: 'Any',
  });
  const subwayDD = buildPillDropdown({
    values:    window.NYC_MAJOR_SUBWAY_STOPS || [],
    pillsEl:   document.getElementById('subwayPills'),
    btnEl:     document.getElementById('subwayBtn'),
    panelEl:   document.getElementById('subwayPanel'),
    labelEl:   document.getElementById('subwayLabel'),
    defaultLabel: 'Any',
  });
  const selectedBoroughs = () => boroughDD.selected();
  const selectedSubways  = () => subwayDD.selected();

  const setupNotice = document.getElementById('setupNotice');
  setupNotice.innerHTML = window.PK.notReadyMessage();
  if (!window.SB_READY) {
    document.getElementById('resultsCount').textContent = '';
    return;
  }

  const listEl  = document.getElementById('binderList');
  const countEl = document.getElementById('resultsCount');
  const pageEl  = document.getElementById('binderPagination');
  const PAGE_SIZE = 10;
  let allBinders = [];
  let currentPage = 1;
  let isLoggedInCached = false;

  async function loadBinders() {
    countEl.textContent = 'Loading binders…';
    listEl.innerHTML = '';
    if (pageEl) pageEl.innerHTML = '';

    isLoggedInCached = !!(await window.PK.currentUser());

    const boroughs = selectedBoroughs();
    const subways  = selectedSubways();
    const shop     = document.getElementById('filterShop').value.trim() || null;

    let { data, error } = await window.sb.rpc('search_binders', {
      p_boroughs: boroughs.length ? boroughs : null,
      p_subways:  subways.length  ? subways  : null,
      p_shop: shop
    });

    if (error) {
      countEl.textContent = 'Error loading binders: ' + error.message;
      return;
    }
    allBinders = data || [];
    currentPage = 1;
    renderPage();
  }

  function renderPage() {
    listEl.innerHTML = '';
    if (pageEl) pageEl.innerHTML = '';
    const total = allBinders.length;
    if (total === 0) {
      countEl.textContent = 'No binders match those filters yet.';
      return;
    }
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (currentPage > totalPages) currentPage = totalPages;
    const start = (currentPage - 1) * PAGE_SIZE;
    const slice = allBinders.slice(start, start + PAGE_SIZE);
    countEl.textContent = `${total} binder${total === 1 ? '' : 's'} — page ${currentPage} of ${totalPages}`;

    slice.forEach(p => listEl.appendChild(buildBinderRow(p)));
    // Pad with invisible placeholders to keep the page height consistent.
    for (let i = slice.length; i < PAGE_SIZE; i++) {
      const ph = document.createElement('li');
      ph.className = 'binder-row binder-row-placeholder';
      ph.setAttribute('aria-hidden', 'true');
      listEl.appendChild(ph);
    }

    if (pageEl && totalPages > 1) {
      pageEl.appendChild(pageBtn('‹', currentPage > 1, () => { currentPage--; renderPage(); }));
      for (let p = 1; p <= totalPages; p++) {
        pageEl.appendChild(pageBtn(String(p), true, () => { currentPage = p; renderPage(); }, p === currentPage));
      }
      pageEl.appendChild(pageBtn('›', currentPage < totalPages, () => { currentPage++; renderPage(); }));
    }
  }

  function buildBinderRow(p) {
    const li = document.createElement('li');
    li.className = 'binder-row';
    let metaHtml = '';
    if (!isLoggedInCached) {
      metaHtml = `<div class="binder-row-meta"><span class="locked-pill"><a href="account.html">Sign in</a> to see location</span></div>`;
    }
    const flair = p.flair || 'trade';
    const flairLabel = { trade: 'Trade Binder', flex: 'Flex Binder', lgs: 'Local Game Store' }[flair] || 'Trade Binder';
    const cat = p.category || 'optcg';
    const catLabel = { optcg: 'OPTCG', pokemon: 'Pokémon' }[cat] || 'OPTCG';
    const updatedLabel = formatLastUpdated(p.last_updated_at);
    const href = `binder.html?id=${encodeURIComponent(p.binder_id)}`;
    li.innerHTML = `
      <a href="${href}" class="binder-row-link">
        <div class="binder-row-header">
          <div class="binder-row-title">
            ${escapeHtml(p.display_name || 'someone')}'s <em>${escapeHtml(p.binder_name || 'binder')}</em>
            <span class="category-pill cat-${cat}">${escapeHtml(catLabel)}</span>
            <span class="binder-flair-pill flair-${flair}">${escapeHtml(flairLabel)}</span>
          </div>
          ${updatedLabel ? `<div class="binder-row-updated">${escapeHtml(updatedLabel)}</div>` : ''}
        </div>
        ${metaHtml}
      </a>`;
    return li;
  }

  function pageBtn(label, enabled, onClick, isActive) {
    const b = document.createElement('button');
    b.className = 'page-btn' + (isActive ? ' active' : '');
    b.textContent = label;
    b.disabled = !enabled;
    if (enabled) b.addEventListener('click', onClick);
    return b;
  }

  function formatLastUpdated(iso) {
    if (!iso) return '';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return '';
    const diff = Date.now() - t;
    if (diff < 60000) return 'Updated just now';
    const m = Math.floor(diff / 60000);
    if (m < 60) return `Updated ${m} minute${m === 1 ? '' : 's'} ago`;
    const h = Math.floor(diff / 3600000);
    if (h < 24) return `Updated ${h} hour${h === 1 ? '' : 's'} ago`;
    return `Updated ${new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })}`;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function slugifyPart(s) {
    return (s || '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().replace(/^-+|-+$/g, '');
  }
  function clientSlug(displayName, binderName) {
    return `${slugifyPart(displayName)}_${slugifyPart(binderName)}`;
  }

  document.getElementById('applyFilters').addEventListener('click', loadBinders);
  document.getElementById('clearFilters').addEventListener('click', () => {
    boroughDD.reset();
    subwayDD.reset();
    document.getElementById('filterShop').value = '';
    loadBinders();
  });

  loadBinders();
})();
