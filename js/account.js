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

  const POST_SIGNIN_FLAG = 'pk_post_signin';

  // Returns true if the user has confirmed a display name (saved the
  // profile form at least once). The signup trigger pre-fills
  // display_name from the email prefix, so we rely on the explicit
  // display_name_set flag instead of just checking the column for a
  // non-empty value. Used both for the post-sign-in redirect and the
  // site-wide setup gate.
  async function profileIsSetUp(user) {
    const { data } = await window.sb
      .from('profiles')
      .select('display_name_set')
      .eq('user_id', user.id)
      .maybeSingle();
    return !!(data && data.display_name_set);
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    loginError.textContent = '';
    try {
      await window.PK.signIn(
        document.getElementById('loginEmail').value.trim(),
        document.getElementById('loginPassword').value
      );
      const user = await window.PK.currentUser();
      if (user && await profileIsSetUp(user)) {
        window.location.href = 'trades.html';
        return;
      }
      await render();
    } catch (err) {
      loginError.textContent = err.message || 'Sign-in failed';
    }
  });

  document.getElementById('googleAuthBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('oauthError');
    errEl.textContent = '';
    try {
      sessionStorage.setItem(POST_SIGNIN_FLAG, '1');
      await window.PK.signInWithGoogle();
    } catch (err) {
      sessionStorage.removeItem(POST_SIGNIN_FLAG);
      errEl.textContent = err.message || 'Google sign-in failed';
    }
  });

  document.getElementById('discordAuthBtn').addEventListener('click', async () => {
    const errEl = document.getElementById('oauthError');
    errEl.textContent = '';
    try {
      sessionStorage.setItem(POST_SIGNIN_FLAG, '1');
      await window.PK.signInWithDiscord();
    } catch (err) {
      sessionStorage.removeItem(POST_SIGNIN_FLAG);
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

  // Original display name at load time. Used to detect renames so we only
  // pay the availability-check round-trip / cooldown gate when needed.
  let pfNameOriginal = '';
  // True while the 90-day display-name cooldown is active for this user.
  let pfNameLocked = false;

  document.getElementById('profileForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('profileError');
    const okEl  = document.getElementById('profileSuccess');
    errEl.textContent = ''; okEl.textContent = '';

    const user = await window.PK.currentUser();
    if (!user) return;

    const nameInput = document.getElementById('pfName');
    const nameVal = nameInput.value.trim();
    if (!nameVal) {
      errEl.textContent = 'Display name is required.';
      nameInput.focus();
      return;
    }
    const nameChanged = nameVal.toLowerCase() !== (pfNameOriginal || '').toLowerCase();
    if (nameChanged && pfNameLocked) {
      errEl.textContent = 'Display name is locked — it can only be changed once every 90 days.';
      return;
    }
    if (nameChanged) {
      // Pre-flight moderation + uniqueness checks so the user sees a
      // clean error instead of a 23505 or trigger exception from the
      // upsert. The server enforces both as a backstop.
      const { data: acceptable, error: modErr } =
        await window.sb.rpc('display_name_acceptable', { p_name: nameVal });
      if (modErr) {
        errEl.textContent = modErr.message || 'Could not verify display name.';
        return;
      }
      if (acceptable !== true) {
        errEl.textContent = `“${nameVal}” contains disallowed words — pick a different name.`;
        nameInput.focus();
        return;
      }
      const { data: available, error: checkErr } =
        await window.sb.rpc('display_name_available', { p_name: nameVal });
      if (checkErr) {
        errEl.textContent = checkErr.message || 'Could not verify display name.';
        return;
      }
      if (available !== true) {
        errEl.textContent = `“${nameVal}” is already taken — pick another.`;
        nameInput.focus();
        return;
      }
    }

    const cityVal = document.getElementById('pfCity').value || null;
    const boroughs = pillsSelected('#pfBoroughPills');
    // Subway stops are only meaningful for NYC; drop any stale selection
    // if the user has since picked a different city.
    const subway_stops = cityVal === 'nyc' ? pillsSelected('#pfSubwayPills') : [];
    const update = {
      user_id:           user.id,
      display_name:      nameVal,
      display_name_set:  true,
      discord_handle:    document.getElementById('pfDiscord').value.trim() || null,
      city:              cityVal,
      boroughs,
      subway_stops,
      local_shops:       splitCsv(document.getElementById('pfShops').value)
    };

    const { error } = await window.sb.from('profiles').upsert(update, { onConflict: 'user_id' });
    if (error) {
      if (error.code === '23505' && /display_name/i.test(error.message || '')) {
        errEl.textContent = `That display name is already taken — try another.`;
      } else if (/90 days/i.test(error.message || '')) {
        errEl.textContent = 'Display name can only be changed once every 90 days.';
      } else if (/disallowed words/i.test(error.message || '')) {
        errEl.textContent = 'That display name contains disallowed words — pick a different name.';
      } else {
        errEl.textContent = error.message;
      }
    } else {
      okEl.textContent = 'Saved.';
      // Hide the setup-required banner once the profile is saved — the
      // user is now free to navigate the rest of the site.
      const notice = document.getElementById('setupRequiredNotice');
      if (notice) notice.style.display = 'none';
      // Refresh the lock state in case the user just renamed.
      if (nameChanged) {
        pfNameOriginal = nameVal;
        applyNameLock(new Date().toISOString());
      }
    }
  });

  function splitCsv(s) {
    return (s || '').split(',').map(x => x.trim()).filter(Boolean);
  }

  // Display-name availability check. Wires every [data-name-check] button
  // to the public.display_name_available RPC. The RPC excludes the
  // caller's own row, so the editor doesn't flag the saved name as taken.
  document.querySelectorAll('.name-check-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const input  = document.getElementById(btn.dataset.nameCheck);
      const status = document.getElementById(btn.dataset.status);
      if (!input || !status) return;
      const name = (input.value || '').trim();
      status.classList.remove('is-ok', 'is-bad', 'is-busy');
      if (!name) {
        status.textContent = 'Enter a display name first.';
        status.classList.add('is-bad');
        return;
      }
      status.textContent = 'Checking…';
      status.classList.add('is-busy');
      btn.disabled = true;
      try {
        // Two checks in parallel: content moderation + uniqueness. The
        // server enforces both via triggers; this just gives the user
        // a clean message before they hit Save.
        const [acceptableRes, availableRes] = await Promise.all([
          window.sb.rpc('display_name_acceptable', { p_name: name }),
          window.sb.rpc('display_name_available',  { p_name: name }),
        ]);
        if (acceptableRes.error) throw acceptableRes.error;
        if (availableRes.error)  throw availableRes.error;
        status.classList.remove('is-busy');
        if (acceptableRes.data !== true) {
          status.textContent = `“${name}” contains disallowed words — pick a different name.`;
          status.classList.add('is-bad');
        } else if (availableRes.data === true) {
          status.textContent = `“${name}” is available.`;
          status.classList.add('is-ok');
        } else {
          status.textContent = `“${name}” is already taken.`;
          status.classList.add('is-bad');
        }
      } catch (err) {
        status.classList.remove('is-busy');
        status.textContent = err.message || 'Check failed.';
        status.classList.add('is-bad');
      } finally {
        btn.disabled = false;
      }
    });
  });

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

  // Populate the city <select> once. Options are sorted alphabetically by
  // label and prefixed with a blank "—" so "no city saved" is expressible.
  (function buildCitySelect() {
    const sel = document.getElementById('pfCity');
    if (!sel) return;
    const items = [...(window.CITIES || [])].sort((a, b) => a.label.localeCompare(b.label));
    sel.innerHTML = '<option value="">—</option>' +
      items.map(c => `<option value="${c.value}">${c.label}</option>`).join('');
    sel.addEventListener('change', () => {
      cascadeFromCity(sel.value, [], []);
    });
  })();

  // Re-render the borough/subway pills to match the chosen city, preserving
  // any saved selections passed in (used during initial load). Subway is
  // NYC-only — the group is hidden for every other city.
  function cascadeFromCity(city, selectedBoroughs, selectedSubway) {
    const byCity = window.BOROUGHS_BY_CITY || {};
    const boroughs = city ? (byCity[city] || []) : [];
    const boroughHint = document.getElementById('pfBoroughHint');
    const boroughHost = document.getElementById('pfBoroughPills');
    renderPills(boroughHost, boroughs, selectedBoroughs || []);
    if (boroughHint) boroughHint.style.display = boroughs.length === 0 ? '' : 'none';

    const subwayGroup = document.getElementById('pfSubwayGroup');
    if (city === 'nyc') {
      subwayGroup.style.display = '';
      renderPills(document.getElementById('pfSubwayPills'),
                  window.NYC_MAJOR_SUBWAY_STOPS || [],
                  selectedSubway || []);
      updateSubwayLabel();
    } else {
      subwayGroup.style.display = 'none';
      renderPills(document.getElementById('pfSubwayPills'), [], []);
    }
  }

  // Toggle the 90-day display-name lock based on the saved
  // `display_name_changed_at` timestamp. While locked, the input is
  // read-only and a lock message shows the next eligible change date.
  function applyNameLock(changedAtIso) {
    const input  = document.getElementById('pfName');
    const lockEl = document.getElementById('pfNameLock');
    if (!input || !lockEl) return;
    const changedAt = changedAtIso ? new Date(changedAtIso) : null;
    if (!changedAt || isNaN(changedAt.getTime())) {
      pfNameLocked = false;
      input.readOnly = false;
      lockEl.style.display = 'none';
      return;
    }
    const unlockAt = new Date(changedAt.getTime() + 90 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const checkBtn = document.querySelector('.name-check-btn[data-name-check="pfName"]');
    if (now < unlockAt) {
      pfNameLocked = true;
      input.readOnly = true;
      if (checkBtn) checkBtn.disabled = true;
      const dateStr = unlockAt.toLocaleDateString(undefined,
        { year: 'numeric', month: 'short', day: 'numeric' });
      lockEl.textContent = `Display name is locked until ${dateStr}.`;
      lockEl.style.display = '';
    } else {
      pfNameLocked = false;
      input.readOnly = false;
      if (checkBtn) checkBtn.disabled = false;
      lockEl.style.display = 'none';
    }
  }

  async function loadProfile(user) {
    const { data } = await window.sb.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
    document.getElementById('pfName').value     = data?.display_name   || '';
    document.getElementById('pfDiscord').value  = data?.discord_handle || '';
    document.getElementById('pfShops').value    = (data?.local_shops  || []).join(', ');
    document.getElementById('pfCity').value     = data?.city || '';
    // The signup trigger pre-fills display_name from the email prefix, so
    // clear the input when the profile isn't set up yet — the user should
    // type a real name rather than confirm an auto-generated one.
    const notSetUp = !data || data.display_name_set !== true;
    if (notSetUp) {
      document.getElementById('pfName').value = '';
      const notice = document.getElementById('setupRequiredNotice');
      if (notice) notice.style.display = '';
    }
    pfNameOriginal = notSetUp ? '' : (data?.display_name || '');
    // The 90-day cooldown only matters once the user has confirmed a name;
    // skip it for first-time setup so the user can pick their name freely.
    applyNameLock(notSetUp ? null : data?.display_name_changed_at);

    cascadeFromCity(data?.city || '', data?.boroughs || [], data?.subway_stops || []);
  }

  async function render() {
    const user = await window.PK.currentUser();
    if (!user) {
      authPanel.style.display      = '';
      dashboardPanel.style.display = 'none';
      return;
    }
    // If the user just completed an OAuth round-trip AND their profile
    // is already set up, skip the dashboard and send them to trades.
    // Direct visits to /account.html (no flag) always render the
    // dashboard so the profile remains editable.
    if (sessionStorage.getItem(POST_SIGNIN_FLAG)) {
      sessionStorage.removeItem(POST_SIGNIN_FLAG);
      if (await profileIsSetUp(user)) {
        window.location.href = 'trades.html';
        return;
      }
    }
    authPanel.style.display      = 'none';
    dashboardPanel.style.display = '';
    document.getElementById('welcomeEmail').textContent = user.email;
    await loadProfile(user);
    document.getElementById('welcomeName').textContent = `Welcome back, ${document.getElementById('pfName').value || 'trader'}`;
  }

  render();
})();
