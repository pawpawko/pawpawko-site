import { state } from './state.js';
import { GAME, $, esc } from './helpers.js';

// ---------------- cost to finish (missing-card prices) ----------------
// Sums each still-needed copy (quantity − owned) at its cached cheapest
// single price (cards.price_usd, kept fresh by scripts/update_prices.py).
// Mirrors the manual price breakdown: dearest cards on top, grand total.

export function closePrices() { $('pcOverlay').style.display = 'none'; }

export async function openPrices(mode) {
  const isDeck = mode === 'deck';
  $('pcTitle').textContent = isDeck ? 'Cost of Deck' : 'Cost to Finish';
  $('pcOverlay').style.display = '';
  $('pcTotal').textContent = '';
  $('pcFoot').textContent = '';
  $('pcBody').innerHTML = '<p class="text-muted-line">Pricing…</p>';

  // Deck = leader + every card at full quantity; Finish = only the copies you're short.
  const items = isDeck
    ? [{ code: state.deck.leader_card_code, need: 1 }, ...state.deckCards.map(r => ({ code: r.card_code, need: r.quantity }))]
    : state.deckCards.map(r => ({ code: r.card_code, need: r.quantity - r.owned })).filter(x => x.need > 0);
  if (!items.length) {
    $('pcBody').innerHTML = '<p class="text-muted-line">Nothing missing — every card in this deck is owned. 🎉</p>';
    return;
  }

  // Pull fresh prices for just these codes (deck-sized, so cheap).
  const codes = items.map(x => x.code);
  const priceMap = {};
  let queryErr = null;
  for (let i = 0; i < codes.length; i += 100) {
    const { data, error } = await window.sb
      .from('cards').select('card_code,name,rarity,image_url,price_usd,price_updated_at')
      .eq('game', GAME).in('card_code', codes.slice(i, i + 100));
    if (error) { queryErr = error; break; }
    (data || []).forEach(c => { priceMap[c.card_code] = c; });
  }
  if (queryErr) {
    $('pcBody').innerHTML =
      `<p class="auth-error">Couldn't load prices: ${esc(queryErr.message)}</p>` +
      `<p class="text-muted-line">First run? Apply <code>scripts/card_prices_migration.sql</code>, then <code>python scripts/update_prices.py</code>.</p>`;
    return;
  }

  let total = 0, unpriced = 0, lastUpdated = null;
  const rows = items.map(x => {
    const c = priceMap[x.code] || {};
    const info = state.cardInfo[x.code] || {};
    const price = (c.price_usd != null) ? Number(c.price_usd) : null;
    if (price == null) unpriced++; else total += price * x.need;
    if (c.price_updated_at && (!lastUpdated || c.price_updated_at > lastUpdated)) lastUpdated = c.price_updated_at;
    return { code: x.code, name: c.name || info.name || x.code, rarity: c.rarity || '',
             img: c.image_url || info.image_url || '', need: x.need, price,
             line: price == null ? null : price * x.need };
  }).sort((a, b) => (b.line ?? -1) - (a.line ?? -1)); // dearest first (cost drivers on top)

  const fmt = (n) => '$' + n.toFixed(2);
  const qtyLabel = isDeck ? 'Qty' : 'Need';
  $('pcBody').innerHTML = `
    <table class="pc-table">
      <thead><tr><th>Card</th><th class="num">${qtyLabel}</th><th class="num">Each</th><th class="num">Line</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr${r.price == null ? ' class="pc-unpriced"' : ''}>
            <td><div class="pc-name">
              ${r.img ? `<img src="${esc(r.img)}" alt="" loading="lazy">` : ''}
              <span>${esc(r.name)}${r.rarity ? ` <span class="pc-code">${esc(r.rarity)}</span>` : ''}<br>
              <span class="pc-code">${esc(r.code)}</span></span>
            </div></td>
            <td class="num">×${r.need}</td>
            <td class="num">${r.price == null ? '—' : fmt(r.price)}</td>
            <td class="num">${r.line == null ? '—' : fmt(r.line)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const copies = rows.reduce((s, r) => s + r.need, 0);
  $('pcTotal').innerHTML = `Total ≈ <strong>${fmt(total)}</strong> ` +
    `<span class="text-muted-line" style="font-size:.8rem;">for ${copies} card${copies === 1 ? '' : 's'}</span>`;

  if (total === 0 && unpriced === rows.length) {
    $('pcFoot').textContent = 'No prices loaded yet — run python scripts/update_prices.py to populate them.';
  } else {
    const parts = ['Cheapest single · TCGplayer via Limitless'];
    if (lastUpdated) parts.push('updated ' + new Date(lastUpdated).toLocaleDateString());
    if (unpriced) parts.push(`${unpriced} card${unpriced === 1 ? '' : 's'} not priced yet`);
    $('pcFoot').textContent = parts.join(' · ');
  }
}
