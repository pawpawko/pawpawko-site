// ============================================
// My Binders — list of the signed-in user's binders
// ============================================

(function () {
  const setupNotice = document.getElementById('setupNotice');
  setupNotice.innerHTML = window.PK.notReadyMessage();
  if (!window.SB_READY) return;

  async function init() {
    const user = await window.PK.currentUser();
    if (!user) {
      document.getElementById('signedOutPreview').style.display = '';
      if (window.PKDemo) window.PKDemo.mountAll();
      return;
    }

    document.getElementById('bindersWrap').style.display = '';
    loadBinders(user.id);

    // Persistence helpers — share the same key as trades.js so the
    // last-used game choice flows across pages.
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
    function setPill(groupId, value) {
      document.querySelectorAll(`#${groupId} .pill-choice-btn`).forEach(b => {
        b.classList.toggle('active', b.dataset.value === value);
      });
    }

    document.getElementById('newBinderBtn').addEventListener('click', () => {
      // Default the category picker to whatever game the user last
      // looked at or created — saves a click for repeat Pokémon users.
      setPill('newBinderCategory', readLastGame());
      document.getElementById('newBinderForm').style.display = '';
      document.getElementById('newBinderName').focus();
    });

    // Pill-choice groups (single-select)
    document.querySelectorAll('.pill-choice').forEach(group => {
      group.addEventListener('click', e => {
        const btn = e.target.closest('.pill-choice-btn');
        if (!btn || btn.disabled) return;
        group.querySelectorAll('.pill-choice-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    function pillValue(id) {
      const el = document.querySelector(`#${id} .pill-choice-btn.active`);
      return el ? el.dataset.value : null;
    }

    document.getElementById('cancelNewBinder').addEventListener('click', () => {
      document.getElementById('newBinderForm').style.display = 'none';
      document.getElementById('newBinderName').value = '';
      document.getElementById('newBinderError').textContent = '';
    });
    document.getElementById('newBinderForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('newBinderError');
      errEl.textContent = '';
      const name = document.getElementById('newBinderName').value.trim();
      if (!name) return;
      const category = pillValue('newBinderCategory') || 'optcg';
      const flair    = pillValue('newBinderFlair') || 'trade';
      const { error } = await window.sb.from('binders').insert({ user_id: user.id, name, category, flair });
      if (error) {
        // Friendly message for the partial-unique-index violation that
        // enforces "only one trade/wishlist binder per user per game".
        if (error.code === '23505' && /one_(trade|wishlist)_per_user_game/.test(error.message || '')) {
          const flairName = flair === 'wishlist' ? 'wishlist' : 'trade';
          const gameName = { pokemon: 'Pokémon', cyberpunk: 'Cyberpunk', optcg: 'OPTCG' }[category] || 'OPTCG';
          errEl.textContent = `You already have a ${flairName} binder for ${gameName}. Only one per game is allowed.`;
        } else {
          errEl.textContent = error.message;
        }
        return;
      }
      // Successful create — remember this category so the trades-page
      // tabs and the next new-binder default both reflect the choice.
      writeLastGame(category);
      document.getElementById('newBinderForm').style.display = 'none';
      document.getElementById('newBinderName').value = '';
      loadBinders(user.id);
    });
  }

  // Display order: OPTCG group first, then Pokémon, then Cyberpunk; created_at order within.
  const GAME_ORDER = ['optcg', 'pokemon', 'cyberpunk'];
  const GAME_LABEL = { optcg: 'One Piece TCG', pokemon: 'Pokémon', cyberpunk: 'Cyberpunk TCG' };

  async function loadBinders(userId) {
    const wrap = document.getElementById('bindersGroups');
    const countEl = document.getElementById('bindersCount');
    wrap.innerHTML = '';

    const { data: owned, error } = await window.sb
      .from('binders')
      .select('id, name, description, sleeve_image_url, flair, category, created_at')
      .eq('user_id', userId)
      .order('created_at');

    if (error) { countEl.textContent = error.message; return; }

    // Binders a partner has shared with this account (co-edit). Tag them so the
    // card can show a "Shared" badge; they're owned by someone else.
    const { data: shared } = await window.sb.rpc('shared_binders');
    (shared || []).forEach(b => { b._shared = true; });
    const binders = [...(owned || []), ...(shared || [])];

    if (binders.length === 0) {
      countEl.textContent = 'No binders yet — create one to get started.';
      return;
    }
    countEl.textContent = `${binders.length} binder${binders.length === 1 ? '' : 's'}`;

    // Pull listing counts in parallel, keyed by binder id.
    const countList = await Promise.all(binders.map(b =>
      window.sb.from('listings').select('id', { count: 'exact', head: true }).eq('binder_id', b.id)
        .then(r => r.count ?? 0).catch(() => 0)
    ));
    const countById = {};
    binders.forEach((b, i) => { countById[b.id] = countList[i]; });

    // Group by game, preserving GAME_ORDER and created_at order within a game.
    const buckets = {};
    binders.forEach(b => {
      const g = GAME_ORDER.includes(b.category) ? b.category : 'optcg';
      (buckets[g] = buckets[g] || []).push(b);
    });

    GAME_ORDER.filter(g => buckets[g] && buckets[g].length).forEach(g => {
      wrap.appendChild(renderGroup(g, buckets[g], countById));
    });
  }

  function renderGroup(game, binders, countById) {
    const section = document.createElement('section');
    section.className = 'binder-group';

    const cards = binders.map(b => {
      const flair = b.flair || 'trade';
      const flairLabel = { trade: 'Trade Binder', wishlist: 'Wishlist Binder', flex: 'Flex Binder', lgs: 'Local Game Store' }[flair] || 'Trade Binder';
      const cat = b.category || 'optcg';
      const catLabel = { optcg: 'OPTCG', pokemon: 'Pokémon', cyberpunk: 'Cyberpunk' }[cat] || 'OPTCG';
      const count = countById[b.id] || 0;
      const sleeve = b.sleeve_image_url
        ? `<div class="binder-card-sleeve" style="background-image:url(${escapeAttr(b.sleeve_image_url)})"></div>`
        : `<div class="binder-card-sleeve binder-card-sleeve-default">📓</div>`;
      return `
        <li class="binder-card">
          <a href="binder.html?id=${encodeURIComponent(b.id)}" class="binder-card-link">
            ${sleeve}
            <div class="binder-card-body">
              <div class="binder-card-name">${escapeHtml(b.name)}</div>
              <div class="binder-card-pills">
                <span class="category-pill cat-${cat}">${escapeHtml(catLabel)}</span>
                <span class="binder-flair-pill flair-${flair}">${escapeHtml(flairLabel)}</span>
                ${b._shared ? '<span class="binder-flair-pill flair-shared">Shared</span>' : ''}
              </div>
              <div class="binder-card-count">${count} listing${count === 1 ? '' : 's'}</div>
            </div>
          </a>
        </li>`;
    }).join('');

    section.innerHTML = `
      <h3 class="binder-group-title">${escapeHtml(GAME_LABEL[game] || game)}</h3>
      <ul class="binders-grid">${cards}</ul>`;
    return section;
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) {
    return String(s ?? '').replace(/["<>]/g, c => ({'"':'&quot;','<':'&lt;','>':'&gt;'}[c]));
  }

  init();
})();
