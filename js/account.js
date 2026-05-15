// ============================================
// Account page — auth + single profile/binder editor
// ============================================

(function () {
  const setupNotice = document.getElementById('setupNotice');
  setupNotice.innerHTML = window.PK.notReadyMessage();
  if (!window.SB_READY) return;

  const authPanel      = document.getElementById('authPanel');
  const dashboardPanel = document.getElementById('dashboardPanel');

  const loginForm   = document.getElementById('loginForm');
  const signupForm  = document.getElementById('signupForm');
  const loginError  = document.getElementById('loginError');
  const signupError = document.getElementById('signupError');

  // Tab toggle
  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const which = tab.dataset.tab;
      loginForm.style.display  = which === 'login'  ? '' : 'none';
      signupForm.style.display = which === 'signup' ? '' : 'none';
    });
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    try {
      await window.PK.signIn(
        document.getElementById('loginEmail').value.trim(),
        document.getElementById('loginPassword').value
      );
      await render();
    } catch (err) {
      loginError.textContent = err.message || 'Sign-in failed';
    }
  });

  document.getElementById('googleAuthBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('oauthError');
    errEl.textContent = '';
    try {
      await window.PK.signInWithGoogle();
    } catch (err) {
      errEl.textContent = err.message || 'Google sign-in failed';
    }
  });

  document.getElementById('discordAuthBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('oauthError');
    errEl.textContent = '';
    try {
      await window.PK.signInWithDiscord();
    } catch (err) {
      errEl.textContent = err.message || 'Discord sign-in failed';
    }
  });

  signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    signupError.textContent = '';
    try {
      await window.PK.signUp(
        document.getElementById('signupEmail').value.trim(),
        document.getElementById('signupPassword').value,
        document.getElementById('signupName').value.trim()
      );
      signupError.textContent = 'Account created. Check your email if confirmation is enabled, then sign in.';
      signupError.classList.add('auth-success');
    } catch (err) {
      signupError.textContent = err.message || 'Sign-up failed';
    }
  });

  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('profileError');
    const okEl  = document.getElementById('profileSuccess');
    errEl.textContent = ''; okEl.textContent = '';

    const user = await window.PK.currentUser();
    if (!user) return;

    const boroughs = pillsSelected('#pfBoroughPills');
    const subway_stops = pillsSelected('#pfSubwayPills');
    const update = {
      user_id:        user.id,
      display_name:   document.getElementById('pfName').value.trim(),
      discord_handle: document.getElementById('pfDiscord').value.trim() || null,
      boroughs,
      subway_stops,
      local_shops:    splitCsv(document.getElementById('pfShops').value)
    };

    const { error } = await window.sb.from('profiles').upsert(update, { onConflict: 'user_id' });
    if (error) {
      if (error.code === '23505' && /display_name/i.test(error.message || '')) {
        errEl.textContent = `That display name is already taken — try another.`;
      } else {
        errEl.textContent = error.message;
      }
    } else {
      okEl.textContent = 'Saved.';
    }
  });

  function splitCsv(s) {
    return (s || '').split(',').map(x => x.trim()).filter(Boolean);
  }

  function pillsSelected(sel) {
    return [...document.querySelectorAll(sel + ' .filter-pill-toggle.active')].map(p => p.dataset.value);
  }
  function renderPills(host, values, selected) {
    host.innerHTML = '';
    const owned = new Set(selected || []);
    values.forEach(v => {
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'filter-pill-toggle' + (owned.has(v) ? ' active' : '');
      pill.dataset.value = v;
      pill.textContent = v;
      pill.setAttribute('aria-pressed', owned.has(v) ? 'true' : 'false');
      pill.addEventListener('click', () => {
        pill.classList.toggle('active');
        const isOn = pill.classList.contains('active');
        pill.setAttribute('aria-pressed', isOn ? 'true' : 'false');
        if (host.id === 'pfSubwayPills') updateSubwayLabel();
      });
      host.appendChild(pill);
    });
  }
  function updateSubwayLabel() {
    const sel = pillsSelected('#pfSubwayPills');
    document.getElementById('pfSubwayLabel').textContent =
      sel.length === 0 ? 'Any' : sel.length === 1 ? sel[0] : `${sel.length} selected`;
  }

  // Open/close the subway pill-dropdown
  (function wireSubwayDropdown() {
    const btn = document.getElementById('pfSubwayBtn');
    const panel = document.getElementById('pfSubwayPanel');
    if (!btn || !panel) return;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = !panel.hasAttribute('hidden');
      if (open) panel.setAttribute('hidden', ''); else panel.removeAttribute('hidden');
      btn.setAttribute('aria-expanded', String(!open));
    });
    document.addEventListener('click', (e) => {
      if (!panel.contains(e.target) && !btn.contains(e.target)) {
        panel.setAttribute('hidden', '');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  })();

  async function loadProfile(user) {
    const { data } = await window.sb.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
    document.getElementById('pfName').value     = data?.display_name   || '';
    document.getElementById('pfDiscord').value  = data?.discord_handle || '';
    document.getElementById('pfShops').value    = (data?.local_shops  || []).join(', ');

    renderPills(document.getElementById('pfBoroughPills'), window.NYC_BOROUGHS || [], data?.boroughs);
    renderPills(document.getElementById('pfSubwayPills'),  window.NYC_MAJOR_SUBWAY_STOPS || [], data?.subway_stops);
    updateSubwayLabel();
  }

  async function render() {
    const user = await window.PK.currentUser();
    if (!user) {
      authPanel.style.display      = '';
      dashboardPanel.style.display = 'none';
      return;
    }
    authPanel.style.display      = 'none';
    dashboardPanel.style.display = '';
    document.getElementById('welcomeEmail').textContent = user.email;
    await loadProfile(user);
    document.getElementById('welcomeName').textContent = `Welcome back, ${document.getElementById('pfName').value || 'trader'}`;
  }

  render();
})();
