// ============================================
// Binder demo carousel (my-binders.html, signed out). Two panels, each an
// embedded real binder.html running in ?demo mode (in-memory binder, no saves)
// — One Piece and Pokémon. Slide between them with the arrows / dots. Iframes
// are only loaded once the signed-out preview is shown, and each is sized to
// its content via a postMessage from binder-view.js.
// (The decks demo is handled by decks.js in signed-out "demo mode".)
// ============================================
(function () {
  function initBinderCarousel() {
    const car = document.getElementById('binderCarousel');
    if (!car || car.dataset.pkInit) return;
    // Only load the iframes when the demo is actually on screen (signed-out).
    const sop = document.getElementById('signedOutPreview');
    if (sop && sop.style.display === 'none') return;
    car.dataset.pkInit = '1';

    const frames = Array.prototype.slice.call(car.querySelectorAll('.demo-binder-frame'));
    frames.forEach(f => { if (f.dataset.src && !f.src) f.src = f.dataset.src; });

    const track = car.querySelector('.demo-carousel-track');
    const viewport = car.querySelector('.demo-carousel-viewport');
    const dots = Array.prototype.slice.call(car.querySelectorAll('.dot'));
    const n = frames.length;
    let idx = 0;

    // Scale each embedded binder down so the whole thing fits in one screen (no
    // scroll). 250px leaves room for the nav + demo header + dots.
    const availH = () => Math.max(460, window.innerHeight - 250);
    function fit(f) {
      const H = parseInt(f.dataset.h || '0', 10);
      if (!H) return;
      const s = Math.min(1, availH() / H);
      f.style.height = H + 'px';
      f.style.transformOrigin = 'top center';
      f.style.transform = s < 1 ? 'scale(' + s + ')' : 'none';
      f.style.marginBottom = s < 1 ? (-(H - Math.round(H * s))) + 'px' : '0';
      f.dataset.vish = Math.round(H * s);
    }
    function syncHeight() { if (viewport && frames[idx]) viewport.style.height = (frames[idx].dataset.vish || frames[idx].dataset.h || 760) + 'px'; }
    function go(i) {
      idx = Math.max(0, Math.min(n - 1, i));
      track.style.transform = 'translateX(-' + (idx * 100) + '%)';
      dots.forEach((d, k) => d.classList.toggle('active', k === idx));
      syncHeight();
    }
    const prev = car.querySelector('.prev'), next = car.querySelector('.next');
    if (prev) prev.addEventListener('click', () => go(idx - 1));
    if (next) next.addEventListener('click', () => go(idx + 1));
    dots.forEach(d => d.addEventListener('click', () => go(parseInt(d.dataset.i, 10))));

    // Each binder.html demo posts its content height; scale-to-fit + size the viewport.
    window.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== 'pk-binder-demo-height') return;
      const f = frames.find(fr => fr.contentWindow === e.source);
      if (!f) return;
      f.dataset.h = Math.max(300, (e.data.height || 0) + 4);
      fit(f);
      if (f === frames[idx]) syncHeight();
    });
    window.addEventListener('resize', () => { frames.forEach(fit); syncHeight(); });
  }

  window.PKDemo = { mountAll: initBinderCarousel, initBinderCarousel };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initBinderCarousel);
  } else {
    initBinderCarousel();
  }
})();
