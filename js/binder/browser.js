// Card browser (edit-mode "Add Cards" panel + the filter dropdowns it
// shares with non-owner search). Moved verbatim from the old
// js/binder-view.js; only export keywords and the imports were added.

import { state } from './state.js';
import { escapeHtml, wireImgFallbacks, OPTCG_COLORS, OPTCG_TYPES, OPTCG_ATTRIBUTES, OPTCG_RARITIES, POKEMON_TYPES, POKEMON_SUPERTYPES, POKEMON_SUBTYPES, POKEMON_RARITIES, POKEMON_HP_BUCKETS, CYBERPUNK_COLORS, CYBERPUNK_TYPES, CYBERPUNK_RARITIES, CYBERPUNK_RAM, CYBERPUNK_TAGS } from './helpers.js';
import { filterBinderListings, openAddListing, wireAddListingModal } from './index.js';

// ------------------- Card browser -------------------

export async function initCardBrowser() {
  state.cardBrowserInited = true;
  await populateDropdowns();
  wireBrowserFilters();
  loadCards();
  wireAddListingModal();
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

export async function populateDropdowns() {
  // Distinct series for the active game only — paginated up to 10k rows
  // so very long catalogs (Pokémon ~17k) don't lose sets.
  const seriesSet = new Set();
  let from = 0, page = 1000;
  while (from < 20000) {
    const { data, error } = await window.sb
      .from('cards').select('series')
      .eq('game', state.binderCategory)
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

  if (state.binderCategory === 'pokemon') {
    appendOptions(document.getElementById('cbType'),      POKEMON_TYPES);
    appendOptions(document.getElementById('cbSupertype'), POKEMON_SUPERTYPES);
    appendOptions(document.getElementById('cbSubtype'),   POKEMON_SUBTYPES);
    appendOptions(document.getElementById('cbHp'),        POKEMON_HP_BUCKETS);
    appendOptions(document.getElementById('cbRarity'),    POKEMON_RARITIES);
  } else if (state.binderCategory === 'cyberpunk') {
    appendOptions(document.getElementById('cbColor'),  CYBERPUNK_COLORS);
    appendOptions(document.getElementById('cbType'),   CYBERPUNK_TYPES);
    appendOptions(document.getElementById('cbCost'),   Array.from({ length: 9 }, (_, i) => i + 1));
    appendOptions(document.getElementById('cbTag'),    CYBERPUNK_TAGS);
    appendOptions(document.getElementById('cbRam'),    CYBERPUNK_RAM);
    appendOptions(document.getElementById('cbRarity'), CYBERPUNK_RARITIES);
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
  ['cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity','cbSupertype','cbSubtype','cbHp','cbTag','cbRam'].forEach(id => {
    document.getElementById(id).addEventListener('change', onChange);
  });
  document.getElementById('cbName').addEventListener('input', () => {
    clearTimeout(state.cbDebounceTimer);
    state.cbDebounceTimer = setTimeout(onChange, 250);
  });
  document.getElementById('cbClear').addEventListener('click', () => {
    ['cbName','cbSeries','cbColor','cbType','cbCost','cbAttribute','cbRarity','cbSupertype','cbSubtype','cbHp','cbTag','cbRam'].forEach(id => {
      document.getElementById(id).value = '';
    });
    onChange();
  });
  // "Show all (ignore filters)" toggle on the binder side — only re-render binder
  const exclude = document.getElementById('cbExcludeBinder');
  if (exclude) exclude.addEventListener('change', filterBinderListings);
}

export async function loadCards() {
  const name   = document.getElementById('cbName').value.trim();
  const series = document.getElementById('cbSeries').value;
  const ctype  = document.getElementById('cbType').value;
  const rarity = document.getElementById('cbRarity').value;

  // Game-aware select list so each game's columns come back for
  // client-side filtering / display.
  const projection = state.binderCategory === 'pokemon'
    ? 'card_code, name, series, type, types, supertype, subtypes, hp, rarity, image_url'
    : state.binderCategory === 'cyberpunk'
    ? 'card_code, name, series, color, type, cost, ram, types, rarity, image_url'
    : 'card_code, name, series, color, type, cost, attribute, rarity, image_url';

  let q = window.sb.from('cards')
    .select(projection)
    .eq('game', state.binderCategory);

  if (name) {
    const safe = name.replace(/[%,]/g, '');
    q = q.or(`name.ilike.%${safe}%,card_code.ilike.%${safe}%`);
  }
  if (series) q = q.eq('series', series);
  if (rarity) q = q.eq('rarity', rarity);

  if (state.binderCategory === 'pokemon') {
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
  } else if (state.binderCategory === 'cyberpunk') {
    const color = document.getElementById('cbColor').value;
    const cost  = document.getElementById('cbCost').value;
    const tag   = document.getElementById('cbTag').value;
    const ram   = document.getElementById('cbRam').value;
    if (color)       q = q.eq('color', color);
    if (ctype)       q = q.eq('type', ctype);                 // Legend/Unit/Gear/Program
    if (cost !== '') q = q.eq('cost', parseInt(cost, 10));
    if (tag)         q = q.contains('types', [tag]);          // classifications text[]
    if (ram !== '')  q = q.eq('ram', parseInt(ram, 10));
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
        ${c.image_url ? `<img loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(c.image_url)}" alt="${escapeHtml(c.name || c.card_code)}" data-fallback="card-placeholder small" data-code="${escapeHtml(c.card_code)}">` : `<div class="card-placeholder small">${escapeHtml(c.card_code)}</div>`}
      </div>
      <div class="cb-tile-name">${escapeHtml(c.name || '')}</div>
      <div class="cb-tile-code">${escapeHtml(c.card_code)}</div>`;
    tile.addEventListener('click', () => openAddListing(c));
    grid.appendChild(tile);
  });
  wireImgFallbacks(grid);
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
