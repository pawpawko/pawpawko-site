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

// Active nav link highlight
const currentPage = window.location.pathname.split('/').pop() || 'index.html';
document.querySelectorAll('.nav-links a').forEach(link => {
  if (link.getAttribute('href') === currentPage) {
    link.classList.add('active');
  }
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
// Both states ship in the HTML, hidden/shown via the html.is-signed-in class.
// The inline head script sets that class from the cached Supabase session for
// flicker-free first paint. We deliberately do NOT re-sync the class against
// the server-verified state here — that would cause a visible swap on every
// page load when the cache is briefly out of sync (e.g., session revoked
// elsewhere). Real auth transitions on this page are picked up by the
// onAuthStateChange listener below. The getUser() call is kept so the SDK
// can refresh the access token in the background.

async function renderAuthButton() {
  const mobileLink = document.getElementById('mobileAuthLink');
  if (!window.PK || !window.SB_READY) return;

  let user = null;
  try { user = await window.PK.currentUser(); } catch (e) {}

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

(function wireBuildBindersBtn() {
  const btn = document.getElementById('buildBindersBtn');
  if (!btn) return;
  btn.addEventListener('click', async (e) => {
    if (!window.PK || !window.SB_READY) return;  // fall back to default href (account.html)
    e.preventDefault();
    let user = null;
    try { user = await window.PK.currentUser(); } catch (err) {}
    window.location.href = user ? 'my-binders.html' : 'account.html';
  });
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
    if (event === 'SIGNED_IN' && session) {
      document.documentElement.classList.add('is-signed-in');
      const ml = document.getElementById('mobileAuthLink');
      if (ml) ml.textContent = 'Account';
    }
  });
}
