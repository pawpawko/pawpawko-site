// ============================================
// PAWPAW KO — Main JavaScript
// ============================================

// ---- Navigation scroll effect ----

const nav = document.getElementById('nav');
const navToggle = document.getElementById('navToggle');
const navMobile = document.getElementById('navMobile');
const navClose = document.getElementById('navClose');

window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 50);
});

// Mobile menu open/close
navToggle?.addEventListener('click', () => {
  navMobile.classList.add('open');
  document.body.style.overflow = 'hidden';
});

navClose?.addEventListener('click', () => {
  navMobile.classList.remove('open');
  document.body.style.overflow = '';
});

navMobile?.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navMobile.classList.remove('open');
    document.body.style.overflow = '';
  });
});

// Active nav link highlight (a page inside a dropdown lights its trigger too)
const currentPage = window.location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.nav-links a').forEach(link => {
  if (link.getAttribute('href') === currentPage) {
    link.classList.add('active');
    link.closest('.nav-dd-wrap')?.querySelector('.nav-dd-btn')?.classList.add('active');
  }
});

// Nav dropdowns ("My Collection") — desktop click-toggle + mobile drawer group
document.querySelectorAll('.nav-dd-wrap').forEach(wrap => {
  const btn = wrap.querySelector('.nav-dd-btn');
  const dd  = wrap.querySelector('.nav-dd');
  if (!btn || !dd) return;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    btn.setAttribute('aria-expanded', String(dd.classList.toggle('open')));
  });
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) dd.classList.remove('open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dd.classList.remove('open');
  });
});
document.querySelectorAll('.nav-mobile-group').forEach(btn => {
  btn.addEventListener('click', () => {
    const sub = btn.nextElementSibling;
    if (!sub) return;
    btn.setAttribute('aria-expanded', String(sub.classList.toggle('open')));
  });
});

// ---- Scroll fade-in animation ----
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.style.opacity = '1';
      entry.target.style.transform = 'translateY(0)';
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.feature-card, .gallery-item, .chapter-item, .shop-category').forEach(el => {
  el.style.opacity = '0';
  el.style.transform = 'translateY(20px)';
  el.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
  observer.observe(el);
});


// ---- Auth button (Profile dropdown / Sign In) ----
// Both states ship in the HTML, shown/hidden via the html.is-signed-in class.
// The inline head script sets that class from the cached Supabase session for a
// flicker-free first paint. Here we reconcile it against the SDK's verified
// session: the notification bell below is built from this same currentUser()
// check, so trusting only the cache lets the nav show the "Sign In" button next
// to a live bell (a signed-in user whose is-signed-in cache was missing/stale),
// or a Profile menu after the session was revoked elsewhere. Reconciling keeps
// the button, the bell, and the real session in agreement; a one-frame
// correction when the cache was stale beats a self-contradictory nav.

async function renderAuthButton() {
  const mobileLink = document.getElementById('mobileAuthLink');
  if (!window.PK || !window.SB_READY) return;

  let user = null;
  try { user = await window.PK.currentUser(); } catch (e) {}

  document.documentElement.classList.toggle('is-signed-in', !!user);

  if (mobileLink) {
    mobileLink.textContent = user ? 'Account' : 'Sign In';
  }
}

function wireProfileDropdown() {
  const btn = document.getElementById('navProfileBtn');
  const dd  = document.getElementById('navProfileDropdown');
  const out = document.getElementById('navProfileSignOut');
  if (!btn || !dd) return;

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    dd.classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!dd.contains(e.target) && !btn.contains(e.target)) {
      dd.classList.remove('open');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dd.classList.remove('open');
  });
  out?.addEventListener('click', async () => {
    if (window.PK) await window.PK.signOut();
    window.location.reload();
  });
}

wireProfileDropdown();
renderAuthButton();

// ---- Dark mode toggle ----
// Variant C "Charcoal Festival". The pref is applied pre-paint by the inline
// <head> script (no flash); here we inject the toggle into the profile menu and
// keep <html data-theme>, localStorage, and the control label in sync.
const THEME_KEY = 'pawpaw:theme';
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function applyTheme(theme) {
  if (theme === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
  else document.documentElement.removeAttribute('data-theme');
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  // Reflect state on the visual switch (gold + knob-right when dark).
  document.querySelectorAll('.theme-toggle').forEach((t) => {
    t.setAttribute('aria-checked', String(theme === 'dark'));
  });
}
function injectThemeToggle() {
  const dd = document.getElementById('navProfileDropdown');
  if (!dd || dd.querySelector('.theme-toggle')) return;

  // Switch styling injected here so it doesn't depend on css/styles.css.
  if (!document.getElementById('themeToggleStyle')) {
    const st = document.createElement('style');
    st.id = 'themeToggleStyle';
    st.textContent =
      '.theme-toggle{display:flex;align-items:center;justify-content:space-between;gap:1rem;}' +
      '.theme-switch{position:relative;flex:none;width:40px;height:20px;border-radius:999px;background:rgba(127,127,127,.45);transition:background .2s ease;}' +
      '.theme-toggle[aria-checked="true"] .theme-switch{background:var(--accent);}' +
      '.theme-switch-knob{position:absolute;top:3px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.45);transition:transform .2s ease;}' +
      '.theme-toggle[aria-checked="true"] .theme-switch-knob{transform:translateX(20px);}';
    document.head.appendChild(st);
  }

  const divider = document.createElement('div');
  divider.className = 'nav-profile-divider';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'nav-profile-menu-item theme-toggle';
  btn.setAttribute('role', 'switch');
  btn.setAttribute('aria-checked', 'false');
  btn.setAttribute('aria-label', 'Dark mode');
  btn.innerHTML = '<span class="theme-toggle-label">Dark Mode</span><span class="theme-switch" aria-hidden="true"><span class="theme-switch-knob"></span></span>';
  // Insert above the existing divider that precedes "Log Out".
  const firstDivider = dd.querySelector('.nav-profile-divider');
  dd.insertBefore(divider, firstDivider || null);
  dd.insertBefore(btn, firstDivider || null);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
  applyTheme(currentTheme());
}
injectThemeToggle();

// ---- Notifications (bell + dropdown) ----
// Injected into the nav for signed-in users so it lives on every page without
// editing each one. Shows binder-share invites with Accept/Decline, plus info
// notices when a partner accepts/declines.
(function initNotifications() {
  if (!window.PK || !window.SB_READY) return;
  const navAuth = document.getElementById('navAuth');
  const profileWrap = navAuth ? navAuth.querySelector('.nav-profile-wrap') : null;
  if (!navAuth || !profileWrap) return;

  let badge, dd, list, notifs = [];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function buildUI() {
    const wrap = document.createElement('div');
    wrap.className = 'nav-notif-wrap';
    wrap.innerHTML = `
      <button class="nav-notif-icon" id="navNotifBtn" aria-label="Notifications" aria-haspopup="true">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 22a2.4 2.4 0 0 0 2.4-2h-4.8A2.4 2.4 0 0 0 12 22Zm6.3-6V11a6.3 6.3 0 0 0-5-6.17V4a1.3 1.3 0 0 0-2.6 0v.83A6.3 6.3 0 0 0 5.7 11v5l-1.5 1.5a1 1 0 0 0 .7 1.7h14.2a1 1 0 0 0 .7-1.7L18.3 16Z"/></svg>
        <span class="nav-notif-badge" id="navNotifBadge" hidden>0</span>
      </button>
      <div class="nav-notif-dropdown" id="navNotifDropdown" role="menu">
        <div class="nav-notif-header">Notifications</div>
        <div class="nav-notif-list" id="navNotifList"><div class="nav-notif-empty">Loading…</div></div>
      </div>`;
    navAuth.insertBefore(wrap, profileWrap);
    const btn = wrap.querySelector('#navNotifBtn');
    badge = wrap.querySelector('#navNotifBadge');
    dd = wrap.querySelector('#navNotifDropdown');
    list = wrap.querySelector('#navNotifList');

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const open = dd.classList.toggle('open');
      if (open && notifs.some(n => !n.read)) {
        await window.sb.rpc('mark_notifications_read');
        notifs.forEach(n => { n.read = true; });
        renderBadge();
      }
    });
    document.addEventListener('click', (e) => {
      if (!dd.contains(e.target) && !btn.contains(e.target)) dd.classList.remove('open');
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dd.classList.remove('open'); });
  }

  function renderBadge() {
    const unread = notifs.filter(n => !n.read).length;
    if (unread > 0) { badge.textContent = unread > 9 ? '9+' : String(unread); badge.hidden = false; }
    else badge.hidden = true;
  }

  function renderList() {
    if (!notifs.length) { list.innerHTML = '<div class="nav-notif-empty">No notifications yet.</div>'; return; }
    list.innerHTML = notifs.map(n => {
      const d = n.data || {};
      let inner = '', deckId = '';
      // ---- Binder sharing ----
      if (n.type === 'binder_invite' && n.status === 'pending') {
        inner = `<div class="nav-notif-text"><strong>${esc(d.from_name)}</strong> wants to share their binder <strong>${esc(d.binder_name)}</strong> with you.</div>
          <div class="nav-notif-actions">
            <button class="btn small notif-accept" data-id="${n.id}" data-kind="binder">Accept</button>
            <button class="btn small notif-decline" data-id="${n.id}" data-kind="binder">Decline</button>
          </div>`;
      } else if (n.type === 'binder_invite') {
        inner = `<div class="nav-notif-text">You ${esc(n.status)} sharing <strong>${esc(d.binder_name)}</strong>.</div>`;
      } else if (n.type === 'binder_invite_accepted') {
        inner = `<div class="nav-notif-text"><strong>${esc(d.by_name)}</strong> accepted your shared binder <strong>${esc(d.binder_name)}</strong>.</div>`;
      } else if (n.type === 'binder_invite_declined') {
        inner = `<div class="nav-notif-text"><strong>${esc(d.by_name)}</strong> declined your shared binder <strong>${esc(d.binder_name)}</strong>.</div>`;
      // ---- Deck sharing ----
      } else if (n.type === 'deck_invite' && n.status === 'pending') {
        inner = `<div class="nav-notif-text"><strong>${esc(d.from_name)}</strong> wants to share their deck <strong>${esc(d.deck_name)}</strong> with you.</div>
          <div class="nav-notif-actions">
            <button class="btn small notif-accept" data-id="${n.id}" data-kind="deck">Accept</button>
            <button class="btn small notif-decline" data-id="${n.id}" data-kind="deck">Decline</button>
          </div>`;
      } else if (n.type === 'deck_invite') {
        inner = `<div class="nav-notif-text">You ${esc(n.status)} sharing deck <strong>${esc(d.deck_name)}</strong>.</div>`;
      } else if (n.type === 'deck_invite_accepted') {
        inner = `<div class="nav-notif-text"><strong>${esc(d.by_name)}</strong> accepted your shared deck <strong>${esc(d.deck_name)}</strong>.</div>`;
        deckId = d.deck_id || '';
      } else if (n.type === 'deck_invite_declined') {
        inner = `<div class="nav-notif-text"><strong>${esc(d.by_name)}</strong> declined your shared deck <strong>${esc(d.deck_name)}</strong>.</div>`;
      } else if (n.type === 'deck_card_collected') {
        const qty = Number(d.qty) > 1 ? ` ×${esc(d.qty)}` : '';
        inner = `<div class="nav-notif-text"><strong>${esc(d.by_name)}</strong> got <strong>${esc(d.card_name)}</strong>${qty} — <strong>${esc(d.deck_name)}</strong> and your wishlist updated.</div>`;
        deckId = d.deck_id || '';
      } else {
        return '';
      }
      const linkCls = deckId ? ' nav-notif-link' : '';
      const deckAttr = deckId ? ` data-deck="${esc(deckId)}"` : '';
      return `<div class="nav-notif-item${linkCls}"${deckAttr}>
          <button class="nav-notif-dismiss" data-id="${n.id}" aria-label="Dismiss" title="Dismiss">×</button>
          ${inner}
        </div>`;
    }).join('');
    list.querySelectorAll('.notif-accept').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); respond(b.dataset.id, true, b.dataset.kind); }));
    list.querySelectorAll('.notif-decline').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); respond(b.dataset.id, false, b.dataset.kind); }));
    // × dismiss — stop propagation so it never triggers the deck-link navigation.
    list.querySelectorAll('.nav-notif-dismiss').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); dismiss(b.dataset.id); }));
    // Clicking a deck-related notice opens that deck.
    list.querySelectorAll('.nav-notif-link').forEach(el => el.addEventListener('click', () => {
      if (el.dataset.deck) window.location.href = 'decks.html?deck=' + encodeURIComponent(el.dataset.deck);
    }));
  }

  async function dismiss(id) {
    const { error } = await window.sb.rpc('dismiss_notification', { p_notification_id: id });
    if (error) { alert(error.message); return; }
    notifs = notifs.filter(n => n.id !== id);  // optimistic remove
    renderBadge();
    renderList();
  }

  async function respond(id, accept, kind) {
    if (kind === 'deck') {
      // Accepting REPLACES the recipient's own deck for this leader (the server
      // deletes it). Warn first when such a deck actually exists.
      if (accept) {
        const n = notifs.find(x => x.id === id);
        const d = (n && n.data) || {};
        if (d.leader_card_code && d.game) {
          const { data: au } = await window.sb.auth.getUser();
          const myId = au && au.user && au.user.id;
          if (myId) {
            const { data: own } = await window.sb.from('decks')
              .select('id,name').eq('user_id', myId).eq('game', d.game)
              .eq('leader_card_code', d.leader_card_code).limit(1);
            const mine = own && own[0];
            if (mine && mine.id !== d.deck_id &&
                !confirm(`Accepting permanently DELETES your own deck "${mine.name}" for this leader — you'll co-edit "${d.deck_name}" instead. Continue?`)) return;
          }
        }
      }
      const { error } = await window.sb.rpc('respond_deck_invite', { p_notification_id: id, p_accept: accept });
      if (error) { alert(error.message); return; }
      await load();
      return;
    }
    // binder
    if (accept && !confirm("Accepting MERGES your own trade binder for that game into this shared binder — your cards move into it and you'll co-edit it together. Your separate trade binder is then removed. Continue?")) return;
    const { error } = await window.sb.rpc('respond_binder_invite', { p_notification_id: id, p_accept: accept });
    if (error) { alert(error.message); return; }
    await load();
  }

  async function load() {
    const { data, error } = await window.sb.from('notifications')
      .select('*').order('created_at', { ascending: false }).limit(30);
    if (error) { notifs = []; renderBadge(); list.innerHTML = '<div class="nav-notif-empty">No notifications yet.</div>'; return; }
    notifs = data || [];
    renderBadge();
    renderList();
  }

  (async function start() {
    let user = null;
    try { user = await window.PK.currentUser(); } catch (e) {}
    if (!user) return;        // signed-in users only
    buildUI();
    // Best-effort prune of >2wk-read notices. The supabase builder is a
    // thenable without .catch(), so swallow errors via then's 2nd arg — and
    // never let it block the bell from loading.
    window.sb.rpc('prune_notifications').then(() => {}, () => {});
    await load();
    // Instant updates via Realtime (requires public.notifications in the
    // supabase_realtime publication — scripts/realtime_migration.sql). RLS
    // scopes the stream to the user's own rows; the filter narrows it further.
    if (window.sb.channel) {
      window.sb
        .channel('notif-' + user.id)
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + user.id },
          () => load())
        .subscribe();
    }
    setInterval(load, 60000); // fallback poll if Realtime is unavailable / drops
  })();
})();

// ---- Profile-setup gate ----
// Signed-in users who haven't confirmed a display name (display_name_set
// is false) are pinned to account.html. The handle_new_user trigger
// pre-fills display_name from the email prefix, so we can't gate on the
// column being empty — we gate on the explicit flag the profile form
// flips to true on save. The gate is a no-op on account.html itself.
(async function enforceProfileSetup() {
  if (!window.PK || !window.SB_READY) return;
  const page = (window.location.pathname.split('/').pop() || 'index.html').toLowerCase();
  if (page === 'account.html') return;
  let user = null;
  try { user = await window.PK.currentUser(); } catch (e) {}
  if (!user) return;
  const { data, error } = await window.sb
    .from('profiles')
    .select('display_name_set')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return;
  if (data && data.display_name_set === true) return;
  // The setup-required banner inside the dashboard panel on account.html
  // surfaces the message; no need to pass anything through sessionStorage.
  window.location.replace('account.html');
})();

(function wireGatedHomeCTAs() {
  // Hero CTAs that need auth: signed-in users go straight to the tool, everyone
  // else is routed to sign-in (account.html). Default hrefs already point at
  // account.html so this is a no-op if Supabase never loads.
  const CTAS = [
    ['buildBindersBtn', 'my-binders.html'],
    ['buildDecksBtn', 'decks.html'],
  ];
  for (const [id, dest] of CTAS) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.addEventListener('click', async (e) => {
      if (!window.PK || !window.SB_READY) return;  // fall back to default href (account.html)
      e.preventDefault();
      let user = null;
      try { user = await window.PK.currentUser(); } catch (err) {}
      window.location.href = user ? dest : 'account.html';
    });
  }
})();

// Update the nav when the user actually signs in on this page (login form on
// account.html, OAuth return). Skip the first event — onAuthStateChange fires
// once on subscribe with the cached state, which the precheck already handled.
// Sign-out is intentionally not reacted to here: the Log Out button reloads
// the page (precheck handles that), and reacting to SIGNED_OUT would re-create
// the stale-cache flicker we're avoiding.
if (window.SB_READY) {
  let firstFired = false;
  window.sb.auth.onAuthStateChange((event, session) => {
    if (!firstFired) { firstFired = true; return; }
    // TOKEN_REFRESHED fires when the SDK silently renews an expired access token
    // from the stored refresh token — the "remembered login" case. Treat it like
    // SIGNED_IN so the nav reflects the signed-in state without needing the user
    // to interact with the page first.
    if ((event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') && session) {
      document.documentElement.classList.add('is-signed-in');
      const ml = document.getElementById('mobileAuthLink');
      if (ml) ml.textContent = 'Account';
    }
  });
}
