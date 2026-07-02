// Signed-out demo (?demo=optcg|pokemon, embedded in the my-binders.html
// carousel): the REAL binder view running on an in-memory binder. Moved
// verbatim from the old js/binder-view.js; only the export keyword and the
// imports were added.

import { state } from './state.js';
import { escapeHtml, applyGameUI, applyLayout, actionsBar, editBtn, doneBtn } from './helpers.js';
import { renderCategory, renderFlair, enterEdit, exitEdit, loadListings } from './index.js';

// ---------- Signed-out demo: the REAL binder view on an in-memory binder ----------
const DEMO_CARDS = {
  optcg: ['OP16-052','OP16-054','OP16-055','ST30-014','OP11-061','OP16-026','OP16-045','OP16-048','OP16-032','OP16-042','OP15-032','OP16-056'],
  // Pokémon = a "chase" binder of Greninja grails.
  pokemon: ['det1-9','me4-22','me4-100','me4-116','me4-122','sm10-107','sm10-200','sm10-222','sm6-120','sm6-133','sv6-106','sv6-214'],
};
const DEMO_TYPES = ['trade','sell','combo','trade','trade','sell','trade','combo','trade','sell','trade','trade'];

export async function startBinderDemo() {
  state.currentBinderId = '__demo__';
  state.ownerUserId = state.viewerUserId = '__demo__';
  state.isOwner = true; state.isCollab = false; state.canEdit = true;
  state.binderCategory = (state.demoCat === 'pokemon' || state.demoCat === 'cyberpunk') ? state.demoCat : 'optcg';
  const isChase = state.binderCategory === 'pokemon';   // the Pokémon binder is a "chase" (wishlist) binder
  state.binderFlair = isChase ? 'wishlist' : 'trade';
  applyGameUI(state.binderCategory);

  const name = isChase ? 'Chase Binder'
             : state.binderCategory === 'cyberpunk' ? 'Cyberpunk Binder' : 'One Piece Binder';
  document.getElementById('binderTitle').innerHTML =
    `<span class="binder-name-group"><em id="binderNameView">${escapeHtml(name)}</em></span>`;
  document.title = name + ' | Pawpaw Ko';
  renderCategory(state.binderCategory);
  renderFlair(state.binderFlair);
  if (isChase) { const fp = document.getElementById('binderFlair'); if (fp) fp.textContent = 'Chase'; }
  applyLayout('4x3');
  document.getElementById('binderMeta').innerHTML = '';

  const codes = DEMO_CARDS[state.binderCategory] || DEMO_CARDS.optcg;
  const { data: cards } = await window.sb.from('cards')
    .select('card_code, name, image_url, image_url_lg, color, type, cost, attribute, rarity, series, release_order, supertype, subtypes, types, hp, ram')
    .eq('game', state.binderCategory).in('card_code', codes);
  const byCode = {}; (cards || []).forEach(c => { byCode[c.card_code] = c; });
  state.allListings = codes.filter(c => byCode[c]).map((code, i) => ({
    id: 'demo-' + (++state.demoSeq), card_code: code, quantity: (i % 3) + 1,
    listing_type: DEMO_TYPES[i % DEMO_TYPES.length], notes: null,
    sort_order: i, created_at: new Date().toISOString(), cards: byCode[code],
  }));

  // Edit / Done live beside the name (moved into the title row); their placement
  // stays fixed regardless of the editable, length-capped binder name.
  const titleRow = document.querySelector('.binder-title-row');
  if (titleRow && actionsBar) titleRow.appendChild(actionsBar);
  actionsBar.style.display = '';
  editBtn.addEventListener('click', enterEdit);
  doneBtn.addEventListener('click', exitEdit);

  // Editable binder name — capped so it can't wrap or shift the Edit button. Demo-only, not saved.
  const nameEl = document.getElementById('binderNameView');
  if (nameEl) {
    const LIMIT = 22;
    nameEl.setAttribute('contenteditable', 'true');
    nameEl.setAttribute('spellcheck', 'false');
    nameEl.setAttribute('title', 'Click to rename');
    nameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); } });
    nameEl.addEventListener('input', () => {
      const t = nameEl.textContent || '';
      if (t.length > LIMIT) {
        nameEl.textContent = t.slice(0, LIMIT);
        const r = document.createRange(); r.selectNodeContents(nameEl); r.collapse(false);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(r);
      }
    });
  }

  // Report height to the parent carousel so it can size this iframe to fit.
  // Debounced + retried: the parent scales & reveals the iframe on the first
  // real height, so a missed early post (listener race) can't strand it
  // unscaled; debouncing + the ignore-sub-2px guard stop the scale from
  // jittering as card art streams in over the network.
  try {
    let lastH = 0, timer = null;
    const post = () => {
      const h = Math.max(300, document.documentElement.scrollHeight);
      // Ignore sub-8px churn — cards reserve their space so the real height is
      // stable; small deltas are just the iframe autosize feedback loop.
      if (Math.abs(h - lastH) < 8) return;
      lastH = h;
      try { parent.postMessage({ type: 'pk-binder-demo-height', cat: state.binderCategory, height: h }, '*'); } catch (e) {}
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(post, 80); };
    new ResizeObserver(schedule).observe(document.body);
    window.addEventListener('load', schedule);
    // Prompt posts (after the grid renders) so the parent scales + reveals fast.
    [50, 150, 400, 900, 1600].forEach(d => setTimeout(post, d));
  } catch (e) {}

  loadListings(true, true);
}
