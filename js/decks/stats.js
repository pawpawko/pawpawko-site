import { state } from './state.js';
import { $, esc } from './helpers.js';

// ---------------- deck stats (over the 50; excludes leader + bench) ----------------
// Searcher detection — faithful port of scripts/search_meta.py (the canonical
// parser). Lives here because the editor already has each card's effect_text
// client-side; once cards.search_meta is populated server-side, prefer reading
// that and delete this. Real OPTCG wording is "look at N cards FROM THE TOP of
// your deck … reveal up to 1 <filter> … add it to your hand" — the old
// /look at the top N cards of your deck/ matched zero cards.
const SEARCH_COLORS = ['red', 'green', 'blue', 'purple', 'black', 'yellow'];
const SEARCH_CLAUSE_RE = /look at (?:up to )?(\d+) cards? from the top of your deck[;:,. ]*reveal\s+(.*?)\s*[,;]?\s*(?:and\s+)?add\s+(?:it|them|up to \d+[^.]*?)\s+to your hand/i;
// A card HAS a [Trigger] keyword (vs. merely referencing one — searchers and
// recursion say "… a card with a [Trigger]" / "… and a [Trigger] …"). Strip
// those reference phrases first, then look for a remaining [Trigger] keyword.
function hasTrigger(effect) {
  return /\[Trigger\]/i.test(String(effect || '').replace(/(?:with|and)\s+an?\s+\[Trigger\]/gi, ''));
}
function parseSearcherSub(s) {
  s = s.replace(/\s+/g, ' ').trim();
  const f = {};
  const excl = [...s.matchAll(/other than \[([^\]]+)\]/gi)].map(x => x[1]);
  const rest = s.replace(/other than \[[^\]]+\]/gi, ' ');
  // "[Trigger]" is a keyword (e.g. "a card with a [Trigger]"), not a card name —
  // matched against each candidate's effect text in cardMatchesSub.
  const allNames = [...rest.matchAll(/\[([^\]]+)\]/g)].map(x => x[1]);
  const trigger = allNames.some(n => /^trigger$/i.test(n));
  const names = allNames.filter(n => !/^trigger$/i.test(n));
  const traits = [...s.matchAll(/\{([^}]+)\}/g)].map(x => x[1])
    .concat([...s.matchAll(/type including "([^"]+)"/gi)].map(x => x[1]));
  const colors = [...new Set([...s.matchAll(new RegExp('\\b(' + SEARCH_COLORS.join('|') + ')\\b', 'gi'))].map(x => x[1].toLowerCase()))];
  const masked = s.replace(/\{[^}]*\}|\[[^\]]*\]/g, ' '); // don't read trait/name words as the category
  let category = null;
  for (const [w, code] of [['Character', 'CHARACTER'], ['Event', 'EVENT'], ['Stage', 'STAGE'], ['Leader', 'LEADER']]) {
    if (new RegExp('\\b' + w + '\\b', 'i').test(masked)) { category = code; break; }
  }
  let cost = null, mm;
  if ((mm = s.match(/cost of (\d+) to (\d+)/i))) cost = { op: 'range', min: +mm[1], max: +mm[2] };
  else if ((mm = s.match(/cost of (\d+) or more/i))) cost = { op: '>=', val: +mm[1] };
  else if ((mm = s.match(/cost of (\d+) or less/i))) cost = { op: '<=', val: +mm[1] };
  else if ((mm = s.match(/cost of (\d+)\b/i))) cost = { op: '==', val: +mm[1] };
  if (category) f.category = category;
  if (traits.length) f.traits = traits;
  if (colors.length) f.colors = colors;
  if (trigger) f.trigger = true;
  if (names.length) f.names = names;
  if (excl.length) f.exclude = excl;
  if (cost) f.cost = cost;
  return f;
}
// -> { look, take, filters:[ {category,traits,colors,names,exclude,cost} ], gated } | null.
// Within a filter, names/traits/colors are OR-matched; category/cost AND'd;
// multiple filters are OR'd (the "… or up to 1 …" form).
function parseSearcher(effect) {
  if (!effect) return null;
  const eff = effect.replace(/\s+/g, ' ').trim();
  const m = eff.match(SEARCH_CLAUSE_RE);
  if (!m) return null;
  const look = parseInt(m[1], 10);
  const body = m[2];
  const takeM = body.match(/up to (\d+)/i);
  const take = takeM ? parseInt(takeM[1], 10) : 1;
  const core = body.replace(/^\s*up to \d+\s+/i, '');
  const filters = core.split(/\s+or up to \d+\s+/i).map(parseSearcherSub);
  // Capture the gating condition ("If your Leader … , look at …") so the
  // stats panel can test it against the deck's actual leader.
  const gateM = eff.match(/\bif ((?:your|you)\b.*?)(?=,?\s*look at (?:up to )?\d+ cards? from the top)/i);
  const gate = gateM ? gateM[1].trim() : null;
  return { look, take, filters, gated: !!gate, gate };
}
// Evaluate a searcher's gate against the deck's leader. Returns one of:
//   always | fires (leader satisfies it) | dead (leader can't) | situational
//   (board-state we can't know from the list). `why` is a short label.
function evalSearcherGate(gate, L) {
  if (!gate) return { status: 'always' };
  let m;
  if ((m = gate.match(/leader is \[([^\]]+)\]/i)))
    return { status: L && L.name === m[1] ? 'fires' : 'dead', why: `Leader = ${m[1]}` };
  if ((m = gate.match(/leader has the \{([^}]+)\} type/i)))
    return { status: L && Array.isArray(L.types) && L.types.includes(m[1]) ? 'fires' : 'dead', why: `Leader is {${m[1]}}` };
  if ((m = gate.match(/leader has the <([^>]+)> attribute/i)))
    return { status: L && (L.attribute || '').toLowerCase() === m[1].toLowerCase() ? 'fires' : 'dead', why: `Leader is <${m[1]}>` };
  if (/leader is multicolored/i.test(gate))
    return { status: L && /\//.test(L.color || '') ? 'fires' : 'dead', why: 'multicolored Leader' };
  if ((m = gate.match(/leader is (red|green|blue|purple|black|yellow)\b/i)))
    return { status: L && (L.color || '').toLowerCase().includes(m[1].toLowerCase()) ? 'fires' : 'dead', why: `${m[1]} Leader` };
  return { status: 'situational', why: gate };
}
function cardMatchesSub(ci, f) {
  const id = [];
  if (f.names) id.push(f.names.includes(ci.name));
  if (f.traits) id.push(Array.isArray(ci.types) && ci.types.some(t => f.traits.includes(t)));
  if (f.colors) { const cc = (ci.color || '').toLowerCase(); id.push(f.colors.some(col => cc.includes(col))); }
  if (f.trigger) id.push(hasTrigger(ci.effect_text));
  if (id.length && !id.some(Boolean)) return false;       // identity constraints are OR'd
  if (f.category && ci.type !== f.category) return false;
  if (f.cost) {
    const v = ci.cost; if (v == null) return false;
    if (f.cost.op === 'range' && (v < f.cost.min || v > f.cost.max)) return false;
    if (f.cost.op === '>=' && !(v >= f.cost.val)) return false;
    if (f.cost.op === '<=' && !(v <= f.cost.val)) return false;
    if (f.cost.op === '==' && v !== f.cost.val) return false;
  }
  if (f.exclude && f.exclude.includes(ci.name)) return false;
  return true;
}
function searcherTargetLabel(filters) {
  return filters.map(f => {
    const p = [];
    if (f.names) p.push(f.names.map(n => '[' + n + ']').join('/'));
    if (f.traits) p.push(f.traits.map(t => '{' + t + '}').join('/'));
    if (f.colors) p.push(f.colors.join('/'));
    if (f.trigger) p.push('[Trigger]');
    if (f.category) p.push(f.category[0] + f.category.slice(1).toLowerCase());
    if (f.cost) p.push('cost ' + (f.cost.op === 'range' ? `${f.cost.min}-${f.cost.max}` : f.cost.op === '==' ? f.cost.val : f.cost.op + f.cost.val));
    return p.join(' ') || 'any card';
  }).join(' or ');
}
export function closeStats() { $('stOverlay').style.display = 'none'; }
// Hypergeometric: chance of ≥1 target in the top N of a D-card deck holding T
// targets. Computed as 1 − P(all N miss) to avoid big factorials.
function hitChance(D, T, N) {
  N = Math.min(N, D);
  if (T <= 0 || N <= 0) return 0;
  if (D - T < N) return 1;
  let pMiss = 1;
  for (let i = 0; i < N; i++) pMiss *= (D - T - i) / (D - i);
  return 1 - pMiss;
}
export function openStats() {
  if (!state.deckValid) return; // stats only meaningful on a valid 50-card legal deck (button is also disabled)
  $('stOverlay').style.display = '';
  const body = $('stBody');
  if (!state.deckCards.length) { body.innerHTML = '<p class="text-muted-line">No cards in the deck yet.</p>'; return; }

  let c2000 = 0, c1000 = 0, cNone = 0, total = 0;
  const costB = {};
  state.deckCards.forEach(r => {
    const c = state.cardInfo[r.card_code] || {};
    total += r.quantity;
    if (c.counter === 2000) c2000 += r.quantity;
    else if (c.counter === 1000) c1000 += r.quantity;
    else cNone += r.quantity;
    if (c.cost != null) costB[c.cost] = (costB[c.cost] || 0) + r.quantity;
  });

  const ct = c2000 + c1000 + cNone || 1;
  const counters = `
    <div class="st-section">
      <h4>Counters</h4>
      <div class="st-counter-bar">
        <span class="seg" style="width:${c2000 / ct * 100}%;background:#7ec96a"></span>
        <span class="seg" style="width:${c1000 / ct * 100}%;background:#e8b757"></span>
        <span class="seg" style="width:${cNone / ct * 100}%;background:#b0506a"></span>
      </div>
      <div class="st-legend">
        <span><i style="background:#7ec96a"></i>+2000 × ${c2000}</span>
        <span><i style="background:#e8b757"></i>+1000 × ${c1000}</span>
        <span><i style="background:#b0506a"></i>No counter (bricks) × ${cNone}</span>
      </div>
    </div>`;

  const costs = Object.keys(costB).map(Number);
  const maxCost = costs.length ? Math.max(...costs) : 0;
  const maxN = costs.length ? Math.max(...costs.map(k => costB[k])) : 0;
  let bars = '';
  for (let cc = 0; cc <= maxCost; cc++) {
    const n = costB[cc] || 0;
    const pct = maxN ? Math.round(n / maxN * 100) : 0;
    bars += `<div class="st-bar-row"><span class="st-bar-label">${cc}</span><div class="st-bar-track"><div class="st-bar" style="width:${pct}%"></div></div><span class="st-bar-n">${n}</span></div>`;
  }
  const costCurve = `
    <div class="st-section">
      <h4>Play-cost curve</h4>
      ${bars || '<p class="text-muted-line">No costed cards.</p>'}
    </div>`;

  const searcherRows = state.deckCards
    .map(r => ({ r, meta: parseSearcher((state.cardInfo[r.card_code] || {}).effect_text) }))
    .filter(x => x.meta)
    .map(({ r, meta }) => {
      const c = state.cardInfo[r.card_code] || {};
      // Cards this searcher can reveal (excl. its own copies — that one's gone).
      const hits = state.deckCards
        .filter(x => x.card_code !== r.card_code && meta.filters.some(f => cardMatchesSub(state.cardInfo[x.card_code] || {}, f)))
        .map(x => ({ name: (state.cardInfo[x.card_code] || {}).name || x.card_code, qty: x.quantity }))
        .sort((a, b) => b.qty - a.qty);
      const T = hits.reduce((s, h) => s + h.qty, 0);
      const fresh = hitChance(total, T, meta.look); // top-of-fresh-deck
      // Draw-accurate: a cost-C searcher resolves ~turn C, by when you've seen
      // ~5 (opening hand) + C cards; dig the remaining deck for the targets
      // expected to still be in it.
      const seen = Math.min(total - meta.look, 5 + (c.cost || 0));
      const Dleft = Math.max(meta.look, total - seen);
      const live = hitChance(Dleft, T * Dleft / total, meta.look);
      const gate = evalSearcherGate(meta.gate, state.leaderCard);
      return { r, c, meta, T, hits, fresh, live, gate };
    })
    .sort((a, b) => {
      const ad = a.gate.status === 'dead' ? 1 : 0, bd = b.gate.status === 'dead' ? 1 : 0;
      return ad - bd || b.live - a.live; // dead gates last, else most reliable first
    });

  const searcherCopies = searcherRows.reduce((s, x) => s + x.r.quantity, 0);
  const openRaw = searcherRows.length ? hitChance(total, searcherCopies, 5) : 0; // ≥1 in a single 5-card hand
  // OPTCG gives a free mulligan (redraw all 5 once), so you get two shots at it.
  const openAccess = searcherRows.length ? 1 - (1 - openRaw) * (1 - openRaw) : 0;

  let searchHtml;
  if (!searcherRows.length) {
    searchHtml = '<p class="text-muted-line">No searchers detected.</p>';
  } else {
    const hitColor = p => (p >= 75 ? '#7ec96a' : p >= 50 ? '#e8b757' : '#b0506a');
    const rows = searcherRows.map(({ r, c, meta, T, hits, fresh, live, gate }, i) => {
      const dead = gate.status === 'dead', situ = gate.status === 'situational';
      const pct = Math.round(live * 100);
      const upto = meta.take > 1 ? ` <span class="pc-code">+up to ${meta.take}</span>` : '';
      const label = searcherTargetLabel(meta.filters);
      let flag = '';
      if (dead) flag = ` <span class="pc-code" style="color:#b0506a" title="This deck's leader doesn't satisfy: ${esc(gate.why || '')}">✗ won't fire</span>`;
      else if (situ) flag = ` <span class="pc-code" style="color:#e8b757" title="Situational — only when met: ${esc(gate.why || '')}">if active</span>`;
      else if (gate.status === 'fires') flag = ` <span class="pc-code" style="color:#7ec96a" title="Your leader satisfies: ${esc(gate.why || '')}">✓ fires</span>`;
      const hitCell = dead
        ? `<td class="num" style="color:#7a7280" title="Gate not met — never searches in this deck">—</td>`
        : `<td class="num" style="color:${hitColor(pct)};font-weight:700" title="${situ ? 'when its condition is met · ' : ''}fresh-deck ${Math.round(fresh * 100)}% · modeled around turn ${c.cost || 0}">${pct}%${situ ? '*' : ''}</td>`;
      const detail = hits.length
        ? hits.map(h => `${esc(h.name)} <span class="pc-code">×${h.qty}</span>`).join(' · ')
        : 'No matching cards in this deck.';
      return `<tr class="st-srow" style="cursor:pointer"><td><span class="st-care">▸</span> ${esc(c.name || r.card_code)} <span class="pc-code">×${r.quantity}</span>${flag}</td><td class="num">top ${meta.look}${upto}</td><td class="num">${T} <span class="pc-code">${esc(label)}</span></td>${hitCell}</tr>` +
        `<tr class="st-sdetail" hidden><td colspan="4" style="padding:.2rem .6rem .7rem 1.6rem;color:var(--text-muted,#988e85);font-size:.82rem">Can hit: ${detail}</td></tr>`;
    }).join('');
    searchHtml =
      `<p class="text-muted-line">${Math.round(openAccess * 100)}% to open one in your first 5 (with mulligan)</span>.<table class="st-search"><thead><tr><th>Searcher</th><th class="num">Depth</th><th class="num">Targets</th><th class="num">Hit %</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  // Triggers — [Trigger] cards can act when they're dealt to you from your Life.
  // A leader's "cost" column is its Life value; Life cards are drawn from the 50,
  // so chance-in-life is hypergeometric (the same hitChance used for searchers).
  const trigHits = state.deckCards
    .filter(r => hasTrigger((state.cardInfo[r.card_code] || {}).effect_text))
    .map(r => ({ name: (state.cardInfo[r.card_code] || {}).name || r.card_code, qty: r.quantity }))
    .sort((a, b) => b.qty - a.qty);
  const trigCount = trigHits.reduce((s, h) => s + h.qty, 0); // qty-weighted: counts each card's copies
  const life = (state.leaderCard && (state.leaderCard.life ?? state.leaderCard.cost)) || 5;
  const trigInLife = hitChance(total, trigCount, life);
  const expTrig = total ? trigCount * life / total : 0;
  const trigColor = trigInLife >= 0.75 ? '#7ec96a' : trigInLife >= 0.5 ? '#e8b757' : '#b0506a';
  const triggers = `
    <div class="st-section">
      <h4>Triggers <span class="text-muted-line" style="font-weight:400;text-transform:none;letter-spacing:0;">— act when taken from your ${life} Life</span></h4>
      ${trigCount
        ? `<p class="text-muted-line st-trow" style="cursor:pointer"><span class="st-care">▸</span> <strong>${trigCount}</strong> <span class="pc-code">[Trigger]</span> card${trigCount === 1 ? '' : 's'} · <strong style="color:${trigColor}">${Math.round(trigInLife * 100)}%</strong> chance ≥1 starts in Life · ~${expTrig.toFixed(1)} expected in your ${life} Life <span class="pc-code">tap for the list</span></p>`
          + `<div class="st-tdetail" hidden style="padding:.1rem .6rem .7rem 1.6rem;color:var(--text-muted,#988e85);font-size:.82rem">${trigHits.map(h => `${esc(h.name)} <span class="pc-code">×${h.qty}</span>`).join(' · ')}</div>`
        : '<p class="text-muted-line">No <span class="pc-code">[Trigger]</span> cards in the deck.</p>'}
    </div>`;
  body.innerHTML = `<p class="text-muted-line">${total} card${total === 1 ? '' : 's'} in the deck${total !== 50 ? ' (not 50 yet)' : ''}.</p>` + counters + triggers + costCurve + searchHtml;

  // Expand/collapse each searcher's target breakdown.
  body.querySelectorAll('.st-srow').forEach(tr => {
    tr.addEventListener('click', () => {
      const d = tr.nextElementSibling;
      if (d && d.classList.contains('st-sdetail')) {
        d.hidden = !d.hidden;
        const car = tr.querySelector('.st-care');
        if (car) car.textContent = d.hidden ? '▸' : '▾';
      }
    });
  });
  // Expand/collapse the Triggers card list.
  const trow = body.querySelector('.st-trow');
  if (trow) trow.addEventListener('click', () => {
    const d = trow.nextElementSibling;
    if (d && d.classList.contains('st-tdetail')) {
      d.hidden = !d.hidden;
      const car = trow.querySelector('.st-care');
      if (car) car.textContent = d.hidden ? '▸' : '▾';
    }
  });
}
