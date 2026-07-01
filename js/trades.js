// ============================================
// Trades page — search/filter binders (one per user)
// ============================================

(function () {
  // ----- Pill-in-dropdown helper -----
  // values: either an array of strings (value === label) or an array of
  //         { value, label } objects.
  // singleSelect: when true, clicking a pill clears any other selection.
  // onChange: optional callback fired after selection changes;
  //           receives the array of currently-selected values.
  // The returned API exposes setValues() so callers can swap the pill set
  // at runtime (used to cascade borough → subway).
  function buildPillDropdown(opts) {
    const {
      pillsEl, btnEl, panelEl, labelEl, defaultLabel,
      singleSelect = false, onChange = null, emptyHint = null,
    } = opts;

    function normalize(items) {
      return (items || []).map(v => typeof v === 'string' ? { value: v, label: v } : v);
    }

    function buildPills(items) {
      pillsEl.innerHTML = '';
      const normalized = normalize(items);
      if (normalized.length === 0 && emptyHint) {
        const hint = document.createElement('div');
        hint.className = 'filter-pill-hint';
        hint.textContent = emptyHint;
        pillsEl.appendChild(hint);
        return;
      }
      normalized.forEach(item => {
        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'filter-pill-toggle';
        pill.dataset.value = item.value;
        pill.textContent = item.label;
        pill.setAttribute('aria-pressed', 'false');
        pill.addEventListener('click', () => {
          if (singleSelect && !pill.classList.contains('active')) {
            pillsEl.querySelectorAll('.filter-pill-toggle.active').forEach(p => {
              p.classList.remove('active');
              p.setAttribute('aria-pressed', 'false');
            });
          }
          pill.classList.toggle('active');
          pill.setAttribute('aria-pressed', pill.classList.contains('active'));
          refreshLabel();
          if (onChange) onChange(selected());
        });
        pillsEl.appendChild(pill);
      });
    }

    function selected() {
      return [...pillsEl.querySelectorAll('.filter-pill-toggle.active')].map(p => p.dataset.value);
    }

    function refreshLabel() {
      const activePills = pillsEl.querySelectorAll('.filter-pill-toggle.active');
      if (activePills.length === 0) { labelEl.textContent = defaultLabel; return; }
      if (activePills.length === 1) { labelEl.textContent = activePills[0].textContent; return; }
      labelEl.textContent = `${activePills.length} selected`;
    }

    function reset() {
      pillsEl.querySelectorAll('.filter-pill-toggle').forEach(p => {
        p.classList.remove('active');
        p.setAttribute('aria-pressed', 'false');
      });
      refreshLabel();
    }

    // Swap in a different list of pills, preserving any active selections
    // that still appear in the new set. Used for borough → subway cascade.
    function setValues(items) {
      const wasSelected = new Set(selected());
      buildPills(items);
      pillsEl.querySelectorAll('.filter-pill-toggle').forEach(p => {
        if (wasSelected.has(p.dataset.value)) {
          p.classList.add('active');
          p.setAttribute('aria-pressed', 'true');
        }
      });
      refreshLabel();
    }

    // Programmatically mark a set of values as active. With silent=true
    // (the default for bootstrap flows), onChange is NOT fired — callers
    // typically run the cascade manually when seeding from profile data.
    function setSelected(values, silent = true) {
      const wanted = new Set(values || []);
      pillsEl.querySelectorAll('.filter-pill-toggle').forEach(p => {
        const isOn = wanted.has(p.dataset.value);
        p.classList.toggle('active', isOn);
        p.setAttribute('aria-pressed', isOn ? 'true' : 'false');
      });
      refreshLabel();
      if (!silent && onChange) onChange(selected());
    }

    buildPills(opts.values);

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

    return { selected, reset, setValues, setSelected };
  }

  // Category is implemented as tabs above the filter row, not as a dropdown.
  // The active tab's data-category attribute is the canonical state. The
  // last-used game is persisted in localStorage so the choice survives
  // refresh + page navigation. First visit defaults to OPTCG (matches
  // the first tab marked `.active` in trades.html). Tab clicks fire
  // loadBinders directly, so category works for anon users without
  // needing the Apply button.
  const LAST_GAME_KEY = 'pawpaw:lastGame';
  function readLastGame() {
    try {
      const v = localStorage.getItem(LAST_GAME_KEY);
      return v === 'pokemon' || v === 'optcg' || v === 'cyberpunk' ? v : 'optcg';
    } catch (e) { return 'optcg'; }
  }
  function writeLastGame(g) {
    try { localStorage.setItem(LAST_GAME_KEY, g); } catch (e) {}
  }
  let currentCategory = readLastGame();
  const selectedCategoryTab = () => currentCategory || null;

  // City is a native <select> (single-select, always-visible options A→Z).
  // Exposes the same {selected, reset, setSelected} surface as the pill
  // dropdowns so the rest of the file is unchanged.
  const cityDD = (function buildCitySelect() {
    const selectEl = document.getElementById('citySelect');
    const items = [...(window.CITIES || [])]
      .sort((a, b) => a.label.localeCompare(b.label));
    selectEl.innerHTML =
      '<option value="">Any</option>' +
      items.map(c => `<option value="${c.value}">${c.label}</option>`).join('');
    selectEl.addEventListener('change', () => refreshBoroughDropdown(api.selected()));
    const api = {
      selected: () => selectEl.value ? [selectEl.value] : [],
      reset:    () => { selectEl.value = ''; },
      setSelected: (values) => { selectEl.value = (values && values[0]) || ''; },
    };
    return api;
  })();
  // Borough and subway start empty — they only populate once the user
  // picks the upstream filter (city for borough; borough for subway).
  const boroughDD = buildPillDropdown({
    values:    [],
    pillsEl:   document.getElementById('boroughPills'),
    btnEl:     document.getElementById('boroughBtn'),
    panelEl:   document.getElementById('boroughPanel'),
    labelEl:   document.getElementById('boroughLabel'),
    defaultLabel: 'Any',
    emptyHint: 'Select a city first',
    onChange:  refreshSubwayDropdown,
  });
  const subwayDD = buildPillDropdown({
    values:    [],
    pillsEl:   document.getElementById('subwayPills'),
    btnEl:     document.getElementById('subwayBtn'),
    panelEl:   document.getElementById('subwayPanel'),
    labelEl:   document.getElementById('subwayLabel'),
    defaultLabel: 'Any',
    emptyHint: 'Select a borough first',
  });
  const selectedBoroughs = () => boroughDD.selected();
  const selectedSubways  = () => subwayDD.selected();
  const selectedCategory = selectedCategoryTab;
  const selectedCity     = () => cityDD.selected()[0] || null;

  // When city changes, swap the borough pill set to that city's
  // neighborhoods. With no city selected, the borough dropdown stays
  // empty (its hint prompts the user to pick a city first). Cascades
  // into the subway dropdown via refreshSubwayDropdown.
  function refreshBoroughDropdown(currentCitySelection) {
    const city = (currentCitySelection && currentCitySelection[0]) || null;
    const byCity = window.BOROUGHS_BY_CITY || {};
    boroughDD.setValues(city ? (byCity[city] || []) : []);
    refreshSubwayDropdown(boroughDD.selected());
  }

  // Subway data exists only for NYC. For any other city, disable the
  // subway dropdown and show "N/A". For NYC, the dropdown stays empty
  // (hint visible) until at least one borough is selected, then narrows
  // to those boroughs' stops.
  function refreshSubwayDropdown(currentBoroughs) {
    const city = selectedCity();
    const subwayBtn   = document.getElementById('subwayBtn');
    const subwayLabel = document.getElementById('subwayLabel');

    if (city && city !== 'nyc') {
      subwayDD.setValues([]);
      subwayBtn.disabled = true;
      subwayBtn.setAttribute('aria-disabled', 'true');
      subwayLabel.textContent = 'N/A';
      return;
    }

    subwayBtn.disabled = false;
    subwayBtn.removeAttribute('aria-disabled');

    if (!currentBoroughs || currentBoroughs.length === 0) {
      subwayDD.setValues([]);
      return;
    }
    const byBorough = window.NYC_MAJOR_SUBWAY_STOPS_BY_BOROUGH || {};
    const stops = currentBoroughs.flatMap(b => byBorough[b] || []);
    subwayDD.setValues(stops);
  }

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
    // Replace the list with PAGE_SIZE invisible placeholders instead of
    // clearing it outright — this keeps the container's height stable
    // during the RPC round-trip so the footer / page bottom doesn't
    // flicker on tab switches and filter applies.
    listEl.innerHTML = '';
    for (let i = 0; i < PAGE_SIZE; i++) {
      const ph = document.createElement('li');
      ph.className = 'binder-row binder-row-placeholder';
      ph.setAttribute('aria-hidden', 'true');
      listEl.appendChild(ph);
    }
    if (pageEl) pageEl.innerHTML = '';

    // Category is the only filter anon users can apply. Everything else
    // (city / borough / subway / shop / cards) is gated behind sign-in.
    const category = selectedCategory();
    const city     = isLoggedInCached ? selectedCity()     : null;
    const boroughs = isLoggedInCached ? selectedBoroughs() : [];
    const subways  = isLoggedInCached ? selectedSubways()  : [];
    const shop     = isLoggedInCached
      ? (document.getElementById('filterShop').value.trim() || null)
      : null;
    const cardCodes = isLoggedInCached ? parsedCardCodes() : [];

    let { data, error } = await window.sb.rpc('search_binders', {
      p_boroughs:   boroughs.length ? boroughs : null,
      p_subways:    subways.length  ? subways  : null,
      p_shop:       shop,
      p_category:   category,
      p_city:       city,
      p_card_codes: cardCodes.length ? cardCodes : null
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
      // Keep the list area the same height as a populated page so
      // empty-state transitions don't bounce the footer.
      for (let i = 0; i < PAGE_SIZE; i++) {
        const ph = document.createElement('li');
        ph.className = 'binder-row binder-row-placeholder';
        ph.setAttribute('aria-hidden', 'true');
        listEl.appendChild(ph);
      }
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
    const flair = p.flair || 'trade';
    const flairLabel = { trade: 'Trade Binder', wishlist: 'Wishlist Binder', flex: 'Flex Binder', lgs: 'Local Game Store' }[flair] || 'Trade Binder';
    const cat = p.category || 'optcg';
    const catLabel = { optcg: 'OPTCG', pokemon: 'Pokémon', cyberpunk: 'Cyberpunk' }[cat] || 'OPTCG';
    const updatedLabel = formatLastUpdated(p.last_updated_at);
    const href = `binder.html?id=${encodeURIComponent(p.binder_id)}`;
    const matchedCount = p.matched_card_count || 0;
    const matchedCards = p.matched_cards || [];
    const matchedHtml = matchedCount > 0
      ? `<button type="button" class="matched-badge" aria-expanded="false">${matchedCount} card${matchedCount === 1 ? '' : 's'} matched</button>`
      : '';
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
        ${matchedHtml}
      </a>`;

    // Wire the matched-cards badge: clicking toggles an inline expansion
    // showing which card codes matched, without navigating to the binder.
    const badge = li.querySelector('.matched-badge');
    if (badge) {
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const existing = li.querySelector('.matched-expansion');
        if (existing) {
          existing.remove();
          badge.setAttribute('aria-expanded', 'false');
          return;
        }
        const expansion = document.createElement('div');
        expansion.className = 'matched-expansion';
        expansion.innerHTML = matchedCards
          .map(c => `<span class="matched-card-chip">${escapeHtml(c)}</span>`)
          .join('');
        li.appendChild(expansion);
        badge.setAttribute('aria-expanded', 'true');
      });
    }

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

  // ====================================================================
  // Card-search autocomplete
  // ====================================================================
  // The card input accepts a comma-separated list of card codes. The
  // active "segment" (the partial code being typed between commas) drives
  // a suggestion popup populated from window.sb.from('cards'). Up/Down
  // navigates suggestions, Enter accepts the highlighted one.

  let cardCodesAll = [];   // [{card_code, name}, ...] for the active category
  let activeSuggIndex = -1;
  let cardSuggBox, cardInput;

  // Fetch all card codes for the active category. cards.game is the
  // discriminator (added in the multi-game migration); filter on it so
  // OPTCG and Pokémon autocompletes don't pollute each other. Limit is
  // bumped to 25k since the Pokémon catalog alone is ~17k.
  async function refreshCardSuggestionsSource(category) {
    if (!window.SB_READY) return;
    const { data, error } = await window.sb
      .from('cards')
      .select('card_code, name')
      .eq('game', category)
      .order('card_code')
      .limit(25000);
    if (error) { console.warn('[Pawpaw Ko] card suggestions fetch failed', error); cardCodesAll = []; return; }
    cardCodesAll = data || [];
  }

  // The comma-separated segment around the caret.
  function getActiveSegment(input) {
    const v = input.value;
    const pos = input.selectionStart != null ? input.selectionStart : v.length;
    const beforeChunk = v.slice(0, pos).split(',').pop() || '';
    const afterChunk  = v.slice(pos).split(',')[0] || '';
    const start = pos - beforeChunk.length;
    const end   = pos + afterChunk.length;
    return { text: (beforeChunk + afterChunk).trim(), start, end };
  }

  function renderSuggestions(seg) {
    if (!cardSuggBox) return;
    if (!seg.text || seg.text.length < 1) { cardSuggBox.hidden = true; return; }
    const q = seg.text.toUpperCase();
    const matches = cardCodesAll
      .filter(c => c.card_code.toUpperCase().includes(q))
      .slice(0, 10);
    if (matches.length === 0) { cardSuggBox.hidden = true; return; }
    cardSuggBox.innerHTML = matches.map((c, i) => `
      <div class="card-sugg-item${i === 0 ? ' active' : ''}" data-card="${escapeHtml(c.card_code)}" role="option">
        <span class="card-sugg-code">${escapeHtml(c.card_code)}</span>
        <span class="card-sugg-name">${escapeHtml(c.name || '')}</span>
      </div>`).join('');
    cardSuggBox.hidden = false;
    activeSuggIndex = 0;
  }

  function acceptSuggestion(idx) {
    if (!cardSuggBox || !cardInput) return;
    const items = cardSuggBox.querySelectorAll('.card-sugg-item');
    if (idx < 0 || idx >= items.length) return;
    const code = items[idx].dataset.card;
    const seg = getActiveSegment(cardInput);
    const before = cardInput.value.slice(0, seg.start);
    const afterRaw = cardInput.value.slice(seg.end);
    const after = afterRaw.startsWith(',') ? afterRaw : '';
    cardInput.value = before + code + (after || ', ');
    // Place caret after the inserted comma+space so the user can keep typing
    const caret = (before + code + ', ').length;
    cardInput.setSelectionRange(caret, caret);
    cardSuggBox.hidden = true;
    activeSuggIndex = -1;
    cardInput.focus();
  }

  function updateSuggActiveUI() {
    if (!cardSuggBox) return;
    cardSuggBox.querySelectorAll('.card-sugg-item').forEach((it, i) => {
      it.classList.toggle('active', i === activeSuggIndex);
    });
  }

  function setupCardAutocomplete() {
    cardInput   = document.getElementById('filterCards');
    cardSuggBox = document.getElementById('cardSuggestions');
    if (!cardInput || !cardSuggBox) return;

    cardInput.addEventListener('input', () => {
      renderSuggestions(getActiveSegment(cardInput));
    });

    cardInput.addEventListener('keydown', (e) => {
      const open = !cardSuggBox.hidden;
      const items = cardSuggBox.querySelectorAll('.card-sugg-item');
      if (e.key === 'ArrowDown' && open) {
        e.preventDefault();
        activeSuggIndex = Math.min(activeSuggIndex + 1, items.length - 1);
        updateSuggActiveUI();
      } else if (e.key === 'ArrowUp' && open) {
        e.preventDefault();
        activeSuggIndex = Math.max(activeSuggIndex - 1, 0);
        updateSuggActiveUI();
      } else if (e.key === 'Enter' && open && activeSuggIndex >= 0) {
        e.preventDefault();
        acceptSuggestion(activeSuggIndex);
      } else if (e.key === 'Enter' && !open) {
        // No suggestion shown — submit the current filter set (only for
        // signed-in users; anon's input is disabled).
        e.preventDefault();
        if (isLoggedInCached) loadBinders();
      } else if (e.key === 'Escape') {
        cardSuggBox.hidden = true;
      } else if (e.key === 'Tab' && open && activeSuggIndex >= 0) {
        e.preventDefault();
        acceptSuggestion(activeSuggIndex);
      }
    });

    cardSuggBox.addEventListener('mousedown', (e) => {
      // mousedown (not click) so we accept before the input loses focus
      const item = e.target.closest('.card-sugg-item');
      if (!item) return;
      e.preventDefault();
      const items = cardSuggBox.querySelectorAll('.card-sugg-item');
      const idx = [...items].indexOf(item);
      acceptSuggestion(idx);
    });

    cardInput.addEventListener('blur', () => {
      // Close suggestions on blur, but with a tiny delay so clicks register
      setTimeout(() => { if (cardSuggBox) cardSuggBox.hidden = true; }, 120);
    });
  }

  // Parse the comma-separated card-codes the user has typed.
  // OPTCG codes are stored uppercase ('OP01-001'); Pokémon codes are
  // stored lowercase ('sv1-1'). The cards.card_code column is matched
  // case-sensitively by search_binders, so we have to preserve the
  // active game's casing instead of blindly uppercasing.
  function parsedCardCodes() {
    const el = document.getElementById('filterCards');
    if (!el || !el.value) return [];
    // OPTCG codes are uppercase ('OP01-001'); Pokémon ('sv1-1') and
    // Cyberpunk ('cb-v-streetkid-wnc-005a') codes are lowercase.
    const normalize = (currentCategory === 'pokemon' || currentCategory === 'cyberpunk')
      ? s => s.trim().toLowerCase()
      : s => s.trim().toUpperCase();
    const codes = el.value.split(',').map(normalize).filter(Boolean);
    return [...new Set(codes)];
  }

  // Swap the Cards-input placeholder + label based on the active tab so
  // the example code matches the game the user is searching.
  function updateCardInputPlaceholder() {
    const el = document.getElementById('filterCards');
    if (!el) return;
    el.placeholder = currentCategory === 'pokemon'
      ? 'sv1-1, sv3pt5-160, …'
      : currentCategory === 'cyberpunk'
      ? 'cb-v-streetkid-wnc-005a, …'
      : 'OP01-001, ST15-003, …';
  }

  // Pre-fill the city / borough / subway filters from a signed-in user's
  // profile, so the first search reflects their saved preferences. The
  // cascade is driven manually (instead of via onChange) so each step
  // sees the freshly-populated upstream filter.
  async function applyProfileDefaults(user) {
    if (!user) return;
    const { data, error } = await window.sb
      .from('profiles')
      .select('city, boroughs, subway_stops')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error || !data) return;

    if (data.city) {
      cityDD.setSelected([data.city]);
      refreshBoroughDropdown([data.city]);
    }
    if (Array.isArray(data.boroughs) && data.boroughs.length > 0) {
      boroughDD.setSelected(data.boroughs);
      refreshSubwayDropdown(data.boroughs);
    }
    if (Array.isArray(data.subway_stops) && data.subway_stops.length > 0) {
      subwayDD.setSelected(data.subway_stops);
    }
  }

  (async function init() {
    const user = await window.PK.currentUser();
    isLoggedInCached = !!user;

    // Wire up the category tabs. Each click sets the active tab, refreshes
    // the autocomplete source for that game, and reloads. Works for
    // everyone (anon + signed in) — the tabs are the one filter that
    // doesn't require sign-in.
    const tabsEl = document.getElementById('categoryTabs');
    if (tabsEl) {
      // Sync the visual tab state to the persisted category before the
      // first render — the HTML always ships with the OPTCG tab marked
      // active, so we have to flip it manually when restoring 'pokemon'.
      tabsEl.querySelectorAll('.category-tab').forEach(t => {
        const match = t.dataset.category === currentCategory;
        t.classList.toggle('active', match);
        t.setAttribute('aria-selected', match ? 'true' : 'false');
      });

      tabsEl.addEventListener('click', async (e) => {
        const tab = e.target.closest('.category-tab');
        if (!tab || tab.classList.contains('active')) return;
        tabsEl.querySelectorAll('.category-tab').forEach(t => {
          t.classList.remove('active');
          t.setAttribute('aria-selected', 'false');
        });
        tab.classList.add('active');
        tab.setAttribute('aria-selected', 'true');
        currentCategory = tab.dataset.category || 'optcg';
        writeLastGame(currentCategory);
        updateCardInputPlaceholder();
        await refreshCardSuggestionsSource(currentCategory);
        loadBinders();
      });
    }

    // Set up the card-search autocomplete once we know the user state.
    setupCardAutocomplete();
    updateCardInputPlaceholder();
    await refreshCardSuggestionsSource(currentCategory);

    if (isLoggedInCached) {
      // Pre-populate filters from the user's profile before the first
      // search runs.
      await applyProfileDefaults(user);

      document.getElementById('applyFilters').addEventListener('click', loadBinders);
      document.getElementById('clearFilters').addEventListener('click', () => {
        cityDD.reset();
        boroughDD.reset();
        subwayDD.reset();
        document.getElementById('filterShop').value = '';
        document.getElementById('filterCards').value = '';
        document.getElementById('cardSuggestions').hidden = true;
        refreshBoroughDropdown([]);
        loadBinders();
      });
    } else {
      // Anon users: replace Apply/Clear with a sign-in CTA for the
      // location/card filters. The category tabs above still work.
      const buttonsGroup = document.querySelector('.trades-filters-top .filter-buttons');
      if (buttonsGroup) {
        buttonsGroup.innerHTML = '<a href="account.html" class="btn btn-filled">Sign in to filter</a>';
      }
      // Anon users can't use the card-search input either.
      const cardInputDisable = document.getElementById('filterCards');
      if (cardInputDisable) {
        cardInputDisable.disabled = true;
        cardInputDisable.placeholder = 'Sign in to search by card';
      }
    }

    loadBinders();
  })();
})();
