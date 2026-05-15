// ============================================
// My Binders — list of the signed-in user's binders
// ============================================

(function () {
  const setupNotice = document.getElementById('setupNotice');
  setupNotice.innerHTML = window.PK.notReadyMessage();
  if (!window.SB_READY) return;

  async function init() {
    const user = await window.PK.currentUser();
    if (!user) { document.getElementById('needsAuth').style.display = ''; return; }

    document.getElementById('bindersWrap').style.display = '';
    loadBinders(user.id);

    document.getElementById('newBinderBtn').addEventListener('click', () => {
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
          const gameName = category === 'pokemon' ? 'Pokémon' : 'OPTCG';
          errEl.textContent = `You already have a ${flairName} binder for ${gameName}. Only one per game is allowed.`;
        } else {
          errEl.textContent = error.message;
        }
        return;
      }
      document.getElementById('newBinderForm').style.display = 'none';
      document.getElementById('newBinderName').value = '';
      loadBinders(user.id);
    });
  }

  async function loadBinders(userId) {
    const grid = document.getElementById('bindersGrid');
    const countEl = document.getElementById('bindersCount');
    grid.innerHTML = '';

    const { data: binders, error } = await window.sb
      .from('binders')
      .select('id, name, description, sleeve_image_url, flair, category, created_at')
      .eq('user_id', userId)
      .order('created_at');

    if (error) { countEl.textContent = error.message; return; }

    // Pull listing counts in parallel for each binder
    const counts = await Promise.all((binders || []).map(b =>
      window.sb.from('listings').select('id', { count: 'exact', head: true }).eq('binder_id', b.id)
        .then(r => r.count ?? 0).catch(() => 0)
    ));

    if (!binders || binders.length === 0) {
      countEl.textContent = 'No binders yet — create one to get started.';
      return;
    }
    countEl.textContent = `${binders.length} binder${binders.length === 1 ? '' : 's'}`;

    binders.forEach((b, i) => {
      const li = document.createElement('li');
      li.className = 'binder-card';
      const sleeve = b.sleeve_image_url
        ? `<div class="binder-card-sleeve" style="background-image:url(${escapeAttr(b.sleeve_image_url)})"></div>`
        : `<div class="binder-card-sleeve binder-card-sleeve-default">📓</div>`;
      const flair = b.flair || 'trade';
      const flairLabel = { trade: 'Trade Binder', wishlist: 'Wishlist Binder', flex: 'Flex Binder', lgs: 'Local Game Store' }[flair] || 'Trade Binder';
      const cat = b.category || 'optcg';
      const catLabel = { optcg: 'OPTCG', pokemon: 'Pokémon' }[cat] || 'OPTCG';
      li.innerHTML = `
        <a href="binder.html?id=${encodeURIComponent(b.id)}" class="binder-card-link">
          ${sleeve}
          <div class="binder-card-body">
            <div class="binder-card-name">${escapeHtml(b.name)}</div>
            <div class="binder-card-pills">
              <span class="category-pill cat-${cat}">${escapeHtml(catLabel)}</span>
              <span class="binder-flair-pill flair-${flair}">${escapeHtml(flairLabel)}</span>
            </div>
            <div class="binder-card-count">${counts[i]} listing${counts[i] === 1 ? '' : 's'}</div>
          </div>
        </a>`;
      grid.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function escapeAttr(s) {
    return String(s ?? '').replace(/["<>]/g, c => ({'"':'&quot;','<':'&lt;','>':'&gt;'}[c]));
  }

  init();
})();
