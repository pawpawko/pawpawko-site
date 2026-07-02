import { state } from './state.js';
import { GAME, $, baseCode, byCostThenCode } from './helpers.js';
import { reloadDeckCards } from './index.js';

// ---------------- decklist import / export ----------------
// Format: one card per line as "NxCODE" (e.g. 4xOP16-091); the leader is
// its own 1x line. Alt-art suffixes normalize to base codes; duplicate
// lines sum.

let dlMode = 'export';

export function parseDecklist(text) {
  const rows = new Map();
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    const t = line.trim();
    if (!t) return;
    const m = t.match(/^(\d+)\s*[x×]\s*([A-Za-z0-9_-]+)$/i);
    if (!m) { errors.push(`line ${i + 1}: "${t}"`); return; }
    const code = baseCode(m[2].toUpperCase());
    rows.set(code, (rows.get(code) || 0) + Number(m[1]));
  });
  return { rows, errors };
}

export async function lookupCards(codes) {
  const out = {};
  for (let i = 0; i < codes.length; i += 100) {
    const { data } = await window.sb
      .from('cards').select('card_code,name,color,cost,type,image_url,counter,effect_text,types')
      .eq('game', GAME).in('card_code', codes.slice(i, i + 100));
    (data || []).forEach(c => { out[c.card_code] = c; });
  }
  return out;
}

export function closeDl() { $('dlOverlay').style.display = 'none'; }

export function closeMenus() {
  document.querySelectorAll('.deck-io-menu.open').forEach(m => m.classList.remove('open'));
  document.querySelectorAll('.deck-io-wrap > .btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
}
export function toggleMenu(btnId, menuId, e) {
  e.stopPropagation(); // don't let the document handler immediately re-close it
  const willOpen = !$(menuId).classList.contains('open');
  closeMenus(); // only one menu open at a time
  if (willOpen) {
    $(menuId).classList.add('open');
    $(btnId).setAttribute('aria-expanded', 'true');
  }
}

export function openExport() {
  dlMode = 'export';
  $('dlTitle').textContent = 'Export Decklist';
  $('dlHint').textContent = 'Leader first, then one line per card. Copy and share.';
  $('dlError').textContent = '';
  const sorted = state.deckCards.slice().sort(byCostThenCode);
  $('dlText').value = [`1x${state.deck.leader_card_code}`, ...sorted.map(r => `${r.quantity}x${r.card_code}`)].join('\n');
  $('dlText').readOnly = true;
  $('dlAction').textContent = 'Copy';
  $('dlOwnedWrap').style.display = 'none'; // export has no owned toggle
  $('dlOverlay').style.display = '';
}

export function openExportMissing() {
  dlMode = 'export';
  $('dlTitle').textContent = 'Export Missing Cards';
  $('dlError').textContent = '';
  // Just the copies you still need (quantity − owned); leader excluded (you own it).
  const missing = state.deckCards.filter(r => r.quantity - r.owned > 0).sort(byCostThenCode);
  if (!missing.length) {
    $('dlHint').textContent = 'Nothing missing — every card in this deck is owned. 🎉';
    $('dlText').value = '';
  } else {
    $('dlHint').textContent = 'The cards you still need (the quantity you’re short). Copy to share or shop.';
    $('dlText').value = missing.map(r => `${r.quantity - r.owned}x${r.card_code}`).join('\n');
  }
  $('dlText').readOnly = true;
  $('dlAction').textContent = 'Copy';
  $('dlOwnedWrap').style.display = 'none';
  $('dlOverlay').style.display = '';
}

export function openImportEditor() {
  dlMode = 'import';
  $('dlTitle').textContent = 'Import Decklist';
  $('dlHint').textContent = 'Replaces every card in this deck. A leader line (1xCODE) must match this deck’s leader.';
  $('dlError').textContent = '';
  $('dlText').value = '';
  $('dlText').readOnly = false;
  $('dlAction').textContent = 'Import';
  $('dlOwned').checked = false;
  $('dlOwnedWrap').style.display = 'flex';
  $('dlOverlay').style.display = '';
  $('dlText').focus();
}

export async function onDlAction() {
  if (dlMode === 'export') {
    try {
      await navigator.clipboard.writeText($('dlText').value);
      $('dlAction').textContent = 'Copied ✓';
      setTimeout(() => { $('dlAction').textContent = 'Copy'; }, 1800);
    } catch (e) {
      $('dlText').select(); // clipboard blocked: leave it selected to copy manually
    }
    return;
  }
  await doEditorImport();
}

async function doEditorImport() {
  const errEl = $('dlError');
  errEl.textContent = '';
  const { rows, errors } = parseDecklist($('dlText').value);
  if (errors.length) { errEl.textContent = 'Bad lines — ' + errors.slice(0, 3).join('; '); return; }
  if (!rows.size) { errEl.textContent = 'Nothing to import.'; return; }
  const info = await lookupCards([...rows.keys()]);
  const missing = [...rows.keys()].filter(c => !info[c]);
  if (missing.length) { errEl.textContent = 'Unknown card(s): ' + missing.join(', '); return; }
  for (const code of [...rows.keys()]) {
    if (info[code].type !== 'LEADER') continue;
    if (code !== state.deck.leader_card_code) {
      errEl.textContent = `This list is led by ${info[code].name} (${code}) — create a deck with that leader, then import there.`;
      return;
    }
    rows.delete(code); // matching leader line: implied, drop it
  }
  const markOwned = $('dlOwned').checked; // owned = quantity for every line
  $('dlAction').disabled = true;
  await window.sb.from('deck_cards').delete().eq('deck_id', state.deck.id);
  const fails = [];
  for (const [code, qty] of rows) {
    state.cardInfo[code] = info[code];
    const { error } = await window.sb.from('deck_cards')
      .insert({ deck_id: state.deck.id, card_code: code, quantity: qty, owned: markOwned ? qty : 0 });
    if (error) fails.push(`${code}: ${error.message}`);
  }
  $('dlAction').disabled = false;
  await reloadDeckCards();
  if (fails.length) {
    errEl.textContent = `${fails.length} line(s) rejected — ${fails.slice(0, 3).join('; ')}`;
  } else {
    closeDl();
  }
}
