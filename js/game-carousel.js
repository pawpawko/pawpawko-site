// ============================================================
// Home "Games we support" — 3D flip-card carousel.
// Rotates a 3D coverflow of game cards; click the front card to
// flip it and reveal what Pawpaw Ko currently supports. No inline
// handlers (CSP-safe). Progressive: if JS is off, all cards still
// render (stacked) via the CSS.
// ============================================================
(function () {
  const root = document.getElementById('gamesCarousel');
  if (!root) return;
  const stage = root.querySelector('.gc-stage');
  const cards = Array.from(root.querySelectorAll('.gc-card'));
  const n = cards.length;
  if (!n) return;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let active = 0;
  let timer = null;

  function layout() {
    cards.forEach((card, i) => {
      const off = ((i - active) % n + n) % n;      // 0 = centre, 1 = right, n-1 = left
      card.classList.remove('is-active', 'is-left', 'is-right');
      if (off === 0) card.classList.add('is-active');
      else if (off === 1) card.classList.add('is-right');
      else if (off === n - 1) card.classList.add('is-left');
      card.setAttribute('aria-hidden', off === 0 ? 'false' : 'true');
      card.tabIndex = off === 0 ? 0 : -1;
    });
  }
  function unflip() { cards.forEach(c => c.classList.remove('is-flipped')); }
  function go(dir) { active = (active + dir + n) % n; unflip(); layout(); }
  function activate(i) {
    if (i === active) { cards[i].classList.toggle('is-flipped'); return; }
    active = i; unflip(); layout();
  }

  // auto-advance, paused on interaction/hover/focus/reduced-motion
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function start() { if (reduced) return; stop(); timer = setInterval(() => go(1), 4500); }
  function bump() { start(); }                    // restart the idle timer after a user action

  const prev = root.querySelector('.gc-prev');
  const next = root.querySelector('.gc-next');
  if (prev) prev.addEventListener('click', () => { go(-1); bump(); });
  if (next) next.addEventListener('click', () => { go(1); bump(); });

  cards.forEach((card, i) => {
    card.addEventListener('click', () => { activate(i); bump(); });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(i); bump(); }
    });
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') { go(-1); bump(); }
    else if (e.key === 'ArrowRight') { go(1); bump(); }
  });

  // drag / swipe to spin
  let startX = null;
  stage.addEventListener('pointerdown', (e) => { startX = e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    if (startX == null) return;
    const dx = e.clientX - startX; startX = null;
    if (Math.abs(dx) > 40) { go(dx < 0 ? 1 : -1); bump(); }
  });

  root.addEventListener('mouseenter', stop);
  root.addEventListener('mouseleave', start);
  root.addEventListener('focusin', stop);
  root.addEventListener('focusout', start);

  layout();
  start();
})();
