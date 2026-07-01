// ============================================
// Interactive demo sandboxes for signed-out visitors. Nothing persists
// (no auth, no Supabase writes); a reload resets everything. Real card art is
// pulled anonymously from the same `cards` table the app uses.
//   • DECK  — clones the real #editorWrap so it's 1:1 with the logged-in deck
//     editor, seeded with Ko's "GU Monkey.D.Luffy Deck". Adjust qty, add cards
//     (real Add-Cards overlay), enlarge a card, toggle the bench.
//   • BINDER — a playable 4×3 binder: drag to rearrange, flip trade/sell,
//     remove, and add cards.
// Auto-mounts any [data-pk-demo="binder"|"deck"] element.
// ============================================
(function () {
  const GAME = 'optcg';
  const LEADER = 'OP16-022';
  const CAP = 4;
  // Ko's real GU Monkey.D.Luffy deck (leader OP16-022) — [card_code, qty], sums to 50.
  const KO_DECK = [
    ['OP05-057', 2], ['OP11-061', 2], ['OP13-040', 2], ['OP15-032', 2], ['OP16-026', 3],
    ['OP16-027', 2], ['OP16-032', 4], ['OP16-034', 4], ['OP16-038', 3], ['OP16-042', 4],
    ['OP16-045', 4], ['OP16-048', 4], ['OP16-052', 1], ['OP16-054', 3], ['OP16-055', 4],
    ['OP16-056', 4], ['ST30-014', 2],
  ];
  const ZOOM_ICON = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  let pool = [];            // OP16 non-leader cards for the picker / binder
  const cardMap = {};       // card_code -> { name, image_url, image_url_lg, cost }
  let dataPromise = null;

  function whenSbReady() {
    return new Promise((resolve) => {
      let n = 0;
      (function poll() {
        if (window.sb && window.SB_READY) return resolve(true);
        if (n++ > 100) return resolve(false);
        setTimeout(poll, 50);
      })();
    });
  }

  function loadData() {
    if (dataPromise) return dataPromise;
    dataPromise = (async () => {
      if (!(await whenSbReady())) return;
      const SEL = 'card_code,name,image_url,image_url_lg,cost,type';
      try {
        // exact deck cards + leader
        const deckCodes = KO_DECK.map(d => d[0]).concat([LEADER]);
        const { data: dc } = await window.sb.from('cards').select(SEL).in('card_code', deckCodes);
        (dc || []).forEach(c => { cardMap[c.card_code] = c; });
        // a browsable pool for the Add-Cards picker / binder
        const { data: pl } = await window.sb.from('cards').select(SEL)
          .eq('game', GAME).like('card_code', 'OP16-%').not('image_url', 'is', null)
          .order('card_code').limit(30);
        (pl || []).forEach(c => { if (c.type !== 'LEADER') { cardMap[c.card_code] = cardMap[c.card_code] || c; pool.push(c); } });
      } catch (e) { /* graceful fallback below */ }
    })();
    return dataPromise;
  }

  const costOf = (code) => (cardMap[code] && cardMap[code].cost != null) ? cardMap[code].cost : 99;
  const byCostThenCode = (a, b) => (costOf(a.code) - costOf(b.code)) || a.code.localeCompare(b.code);

  function faceHTML(c, cls) {
    return c && c.image_url
      ? `<img class="${cls || ''}" src="${esc(c.image_url)}" alt="${esc(c.name || c.card_code)}" draggable="false" referrerpolicy="no-referrer">`
      : `<div class="demo-tile-ph">${esc((c && c.card_code) || '')}</div>`;
  }

  // full-size enlarge — reuses the real .card-zoom-overlay look
  function lightbox(code) {
    const c = cardMap[code] || {};
    const ov = document.createElement('div');
    ov.className = 'card-zoom-overlay';
    ov.innerHTML = `<div class="cz-box"><div class="cz-imgwrap"><img class="cz-img" src="${esc(c.image_url_lg || c.image_url || '')}" alt="${esc(c.name || code)}"></div></div>`;
    ov.addEventListener('click', () => ov.remove());
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { ov.remove(); document.removeEventListener('keydown', esc); } });
    document.body.appendChild(ov);
  }

  // ================= DECK — 1:1 clone of the real editor =================
  function deckDemo(mount) {
    const srcEditor = document.getElementById('editorWrap');
    if (!srcEditor || !cardMap[LEADER]) { mount.innerHTML = '<p class="demo-note">Preview unavailable — try again in a moment.</p>'; return; }

    const ed = srcEditor.cloneNode(true);
    ed.removeAttribute('id');
    ed.style.display = '';
    // keep a handle on the original ids, then drop them (no duplicate ids in the DOM)
    ed.querySelectorAll('[id]').forEach(n => { n.setAttribute('data-d', n.id); n.removeAttribute('id'); });
    const byd = (id) => ed.querySelector(`[data-d="${id}"]`);
    const back = ed.querySelector('.back-link'); if (back) back.remove();

    // static chrome
    const li = byd('edLeaderImg'); if (li) { li.src = cardMap[LEADER].image_url || ''; li.style.cursor = 'zoom-in'; li.addEventListener('click', () => lightbox(LEADER)); }
    const name = byd('edDeckName'); if (name) { name.value = 'GU Monkey.D.Luffy Deck'; name.readOnly = true; }
    const fmt = byd('edFormat'); if (fmt) fmt.querySelectorAll('.pill-choice-btn').forEach(b => b.classList.toggle('active', b.dataset.value === 'standard'));
    const badges = byd('edBadges'); if (badges) badges.innerHTML = '<span class="deck-badge ok">deck valid</span> <span class="deck-badge ok">owned</span>';
    const counts = byd('edCounts');
    const fill = byd('edCountFill');

    let cards = KO_DECK.map(([code, qty]) => ({ code, qty })).sort(byCostThenCode);

    const total = () => cards.reduce((s, c) => s + c.qty, 0);
    function updateStatus() {
      const t = total();
      if (counts) counts.innerHTML = `${t}/50 cards · ${t} owned · 0 missing`;
      if (fill) { fill.style.width = Math.min(100, t / 50 * 100) + '%'; fill.classList.toggle('ok', t === 50); fill.classList.toggle('over', t > 50); }
    }

    const grid = byd('edDeckGrid');
    function renderGrid() {
      cards.sort(byCostThenCode);
      grid.innerHTML = cards.map((cd) => {
        const c = cardMap[cd.code] || {};
        return `<div class="deck-card-tile" title="${esc(c.name || cd.code)} — ${cd.qty} in deck, ${cd.qty} owned">`
          + faceHTML(c)
          + `<div class="card-acts"><button class="card-act qty-dec" aria-label="Remove one">−</button>`
          + `<span class="card-act card-zoom" role="button" aria-label="Enlarge card">${ZOOM_ICON}</span>`
          + `<button class="card-act qty-inc" aria-label="Add one">+</button></div>`
          + `<span class="qty-badge"><span class="qty-total">${cd.qty > 4 ? 'X' : 'x' + cd.qty}</span><span class="qty-missing">x0</span></span>`
          + `</div>`;
      }).join('');
      grid.querySelectorAll('.deck-card-tile').forEach((tile, i) => {
        tile.querySelector('.qty-dec').addEventListener('click', e => { e.stopPropagation(); cards[i].qty--; if (cards[i].qty <= 0) cards.splice(i, 1); renderGrid(); updateStatus(); });
        tile.querySelector('.qty-inc').addEventListener('click', e => { e.stopPropagation(); if (cards[i].qty < CAP) cards[i].qty++; renderGrid(); updateStatus(); });
        tile.querySelector('.card-zoom').addEventListener('click', e => { e.stopPropagation(); lightbox(cards[i].code); });
        tile.addEventListener('click', () => lightbox(cards[i].code));
      });
    }
    renderGrid();
    updateStatus();

    // + Add Cards -> the real overlay, cloned + populated with the pool
    const addBtn = byd('edAddBtn');
    if (addBtn) addBtn.addEventListener('click', () => openAddOverlay((code) => {
      const ex = cards.find(c => c.code === code);
      if (ex) { if (ex.qty < CAP) ex.qty++; } else cards.push({ code, qty: 1 });
      renderGrid(); updateStatus();
    }));

    // Bench toggle
    const benchBtn = byd('edBenchBtn'); const benchSec = byd('edBenchSection');
    if (benchBtn && benchSec) benchBtn.addEventListener('click', () => {
      const show = benchSec.style.display === 'none' || !benchSec.style.display;
      benchSec.style.display = show ? '' : 'none';
      benchBtn.setAttribute('aria-expanded', String(show));
      if (show && !benchSec.dataset.filled) {
        benchSec.querySelector('.deck-bench-grid').innerHTML = '<div class="deck-bench-empty">Overflow and set-aside copies land here.</div>';
        benchSec.dataset.filled = '1';
      }
    });

    const wrap = document.createElement('div');
    wrap.className = 'demo-editor-wrap';
    wrap.appendChild(ed);
    const note = document.createElement('p'); note.className = 'demo-note'; note.textContent = 'Demo · nothing is saved';
    wrap.appendChild(note);
    mount.innerHTML = ''; mount.appendChild(wrap);
  }

  // clone the real Add-Cards overlay, fill its grid with the pool
  function openAddOverlay(onPick) {
    const src = document.getElementById('cbOverlay');
    if (!src) return;
    const ov = src.cloneNode(true);
    ov.removeAttribute('id');
    ov.classList.add('demo-add-overlay');
    ov.querySelectorAll('[id]').forEach(n => { n.setAttribute('data-d', n.id); n.removeAttribute('id'); });
    ov.style.display = 'flex';
    const grid = ov.querySelector('[data-d="cbGrid"]');
    const count = ov.querySelector('[data-d="cbCount"]');
    if (count) count.textContent = pool.length + ' cards';
    if (grid) {
      grid.innerHTML = '';
      pool.forEach(c => {
        const t = document.createElement('button');
        t.className = 'cb-tile';
        t.innerHTML = `<div class="cb-tile-img"><img loading="lazy" referrerpolicy="no-referrer" src="${esc(c.image_url)}" alt="${esc(c.name || c.card_code)}"></div>`
          + `<div class="cb-tile-name">${esc(c.name || '')}</div><div class="cb-tile-code">${esc(c.card_code)}</div>`;
        t.addEventListener('click', () => onPick(c.card_code));
        grid.appendChild(t);
      });
    }
    const closeOv = () => ov.remove();
    const cbClose = ov.querySelector('[data-d="cbClose"]');
    if (cbClose) cbClose.addEventListener('click', closeOv);
    const more = ov.querySelector('[data-d="cbMore"]'); if (more) more.style.display = 'none';
    ov.addEventListener('click', e => { if (e.target === ov) closeOv(); });
    document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { closeOv(); document.removeEventListener('keydown', esc); } });
    document.body.appendChild(ov);
  }

  // ================= BINDER — playable 4×3 =================
  function binderSandbox(mount) {
    let slots = pool.slice(0, 9).map((c, i) => ({ code: c.card_code, type: i % 3 === 2 ? 'sell' : 'trade' }));
    while (slots.length < 12) slots.push(null);
    let pickerOpen = false;

    const swap = (from, to) => { const t = slots[from]; slots[from] = slots[to]; slots[to] = t; render(); };
    const add = (code) => { const i = slots.findIndex(s => !s); if (i < 0) return; slots[i] = { code, type: 'trade' }; render(); };
    const toggle = (i) => { slots[i].type = slots[i].type === 'trade' ? 'sell' : 'trade'; render(); };
    const remove = (i) => { slots[i] = null; render(); };

    function wireDrag(el, index, onMove) {
      el.setAttribute('draggable', 'true');
      el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', String(index)); e.dataTransfer.effectAllowed = 'move'; el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; el.classList.add('drop-target'); });
      el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
      el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drop-target'); const from = parseInt(e.dataTransfer.getData('text/plain'), 10); if (!isNaN(from) && from !== index) onMove(from, index); });
    }

    const root = document.createElement('div');
    root.className = 'demo-sandbox demo-sandbox-binder';
    mount.innerHTML = ''; mount.appendChild(root);

    function render() {
      root.innerHTML = '';
      const full = slots.every(s => s);
      const head = document.createElement('div');
      head.className = 'demo-sb-head';
      head.innerHTML = `<span class="demo-sb-title">Trade Pile</span><span class="demo-pill demo-pill-game">One Piece</span>`;
      const addBtn = document.createElement('button');
      addBtn.className = 'demo-add-btn' + (pickerOpen ? ' open' : '');
      addBtn.textContent = '+ Add';
      addBtn.disabled = full && !pickerOpen;
      addBtn.addEventListener('click', () => { pickerOpen = !pickerOpen; render(); });
      head.appendChild(addBtn);
      root.appendChild(head);

      const grid = document.createElement('div');
      grid.className = 'demo-binder-grid2';
      slots.forEach((s, i) => {
        if (!s) {
          const slot = document.createElement('div');
          slot.className = 'demo-slot'; slot.textContent = '+';
          slot.addEventListener('dragover', e => { e.preventDefault(); slot.classList.add('drop-target'); });
          slot.addEventListener('dragleave', () => slot.classList.remove('drop-target'));
          slot.addEventListener('drop', e => { e.preventDefault(); slot.classList.remove('drop-target'); const from = parseInt(e.dataTransfer.getData('text/plain'), 10); if (!isNaN(from)) swap(from, i); });
          slot.addEventListener('click', () => { pickerOpen = true; render(); });
          grid.appendChild(slot); return;
        }
        const tile = document.createElement('div');
        tile.className = 'demo-tile';
        tile.innerHTML = faceHTML(cardMap[s.code])
          + `<button class="demo-remove" draggable="false" aria-label="Remove">×</button>`
          + `<button class="demo-type-pill ${s.type}" draggable="false">${s.type}</button>`;
        tile.querySelector('.demo-type-pill').addEventListener('click', e => { e.stopPropagation(); toggle(i); });
        tile.querySelector('.demo-remove').addEventListener('click', e => { e.stopPropagation(); remove(i); });
        wireDrag(tile, i, swap);
        grid.appendChild(tile);
      });
      root.appendChild(grid);

      if (pickerOpen) {
        const pk = document.createElement('div'); pk.className = 'demo-picker';
        const pg = document.createElement('div'); pg.className = 'demo-picker-grid';
        pool.forEach(c => { const t = document.createElement('div'); t.className = 'demo-tile demo-pick'; t.innerHTML = faceHTML(c); t.addEventListener('click', () => add(c.card_code)); pg.appendChild(t); });
        pk.appendChild(pg); root.appendChild(pk);
      }
      const note = document.createElement('p'); note.className = 'demo-note'; note.textContent = 'Demo · nothing is saved';
      root.appendChild(note);
    }
    render();
  }

  async function mount(el) {
    if (!el || el.dataset.pkDemoDone) return;
    const kind = el.getAttribute('data-pk-demo');
    if (kind !== 'binder' && kind !== 'deck') return;
    el.dataset.pkDemoDone = '1';
    await loadData();
    if (kind === 'deck') deckDemo(el);
    else if (pool.length) binderSandbox(el);
    else el.innerHTML = '<p class="demo-note">Preview unavailable — try again in a moment.</p>';
  }

  function mountAll(root) { (root || document).querySelectorAll('[data-pk-demo]').forEach(mount); }
  window.PKDemo = { mount, mountAll };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => mountAll());
  else mountAll();
})();
