import { state } from './state.js';
import { $, esc } from './helpers.js';
import { reloadDeckCards } from './index.js';

// ---- Shared decks: live co-edit via Realtime. A partner's deck-card
// change refreshes this editor instantly. Events are ignored while a LOCAL
// edit burst is in flight (dcPending > 0) — queueDeckWrite's settle already
// re-reads the authoritative state — so live sync never clobbers optimistic
// edits mid-burst. Requires public.deck_cards in the Realtime publication
// (scripts/realtime_migration.sql). ----
let deckCardsChannel = null;
let deckReloadTimer = null;
export function subscribeDeckCardsRealtime() {
  if (!window.sb || !window.sb.channel || !state.deck) return;
  unsubscribeDeckCards();
  const myId = state.deck.id;
  deckCardsChannel = window.sb
    .channel('deckcards-' + myId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'deck_cards', filter: 'deck_id=eq.' + myId },
      () => {
        if (state.dcPending > 0) return;             // local burst in flight; settle reconciles
        if (!state.deck || state.deck.id !== myId) return; // switched decks
        clearTimeout(deckReloadTimer);
        deckReloadTimer = setTimeout(() => {
          if (state.dcPending === 0 && state.deck && state.deck.id === myId) reloadDeckCards();
        }, 300);
      })
    .subscribe();
}
export function unsubscribeDeckCards() {
  if (deckReloadTimer) { clearTimeout(deckReloadTimer); deckReloadTimer = null; }
  if (deckCardsChannel) { try { window.sb.removeChannel(deckCardsChannel); } catch (e) {} deckCardsChannel = null; }
}

// ---- Shared decks: invite/manage the partner (couples) ----
// A deck can only be shared with the partner you co-own a trade binder with
// for this game; share_deck targets them automatically (no name to type).
export function setupDeckCollab() {
  const el = $('edCollab');
  if (!el) return;
  el.style.display = '';

  const refresh = async () => {
    if (!state.isDeckOwner) {
      el.innerHTML = `<div class="collab-row"><span class="collab-label">Shared deck</span> <span class="collab-none">you're a co-editor</span></div>`;
      return;
    }
    // Accepted collaborator(s) take priority; otherwise surface a still-pending
    // invite so the owner sees who they invited in place of the "+ Add" button.
    const [{ data: collabs }, { data: pending }] = await Promise.all([
      window.sb.rpc('deck_collaborators_list', { p_deck_id: state.deck.id }),
      window.sb.rpc('deck_pending_invite', { p_deck_id: state.deck.id }),
    ]);
    const list = collabs || [];
    const invite = (pending && pending[0]) || null;

    let body;
    if (list.length) {
      // One partner per deck — an accepted co-editor; offer removal only.
      body = list.map(c =>
        `<span class="collab-chip">${esc(c.display_name || 'partner')}<button class="collab-remove" data-uid="${c.user_id}" title="Remove" aria-label="Remove">×</button></span>`).join('');
    } else if (invite) {
      // Shared, awaiting acceptance — show the invited partner's name with a ×
      // to rescind the pending invite.
      body = `<span class="collab-chip">${esc(invite.display_name || 'partner')} <span style="opacity:.65;font-size:.82em;font-style:italic;">pending</span><button class="collab-remove" data-rescind="1" title="Cancel invite" aria-label="Cancel invite">×</button></span>`;
    } else {
      body = `<button class="btn small" id="deckShareBtn" type="button">+ Add partner</button>`;
    }
    el.innerHTML = `
      <div class="collab-row">
        <span class="collab-label">Share with</span>
        ${body}
      </div>
      <p class="auth-error" id="deckCollabError"></p>`;
    const addEl = $('deckShareBtn');
    if (addEl) addEl.addEventListener('click', shareDeck);
    el.querySelectorAll('.collab-remove').forEach(b =>
      b.addEventListener('click', () => b.dataset.rescind ? rescindInvite() : unshareDeck(b.dataset.uid)));
  };

  const shareDeck = async () => {
    const errEl = $('deckCollabError');
    if (errEl) { errEl.textContent = ''; errEl.style.color = ''; }
    // Prefill the box with your trade-binder partner for this game — the only
    // account a deck can be shared with. Editable; OK confirms. Empty when no
    // trade binder is shared yet (share_deck then raises a helpful error).
    let suggested = '';
    const { data: tp } = await window.sb.rpc('deck_trade_partner', { p_deck_id: state.deck.id });
    if (tp && tp[0]) suggested = tp[0].display_name || '';
    const name = prompt("Share this deck with your trade-binder partner. They'll get a notification to accept.", suggested);
    if (name === null || !name.trim()) return;
    const { error } = await window.sb.rpc('share_deck', { p_deck_id: state.deck.id, p_display_name: name.trim() });
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    await refresh();
    const e2 = $('deckCollabError');
    if (e2) { e2.style.color = '#7ec96a'; e2.textContent = `Invite sent to ${name.trim()} — they'll get a notification to accept.`; }
  };
  const rescindInvite = async () => {
    if (!confirm('Cancel the pending invite?')) return;
    const { error } = await window.sb.rpc('rescind_deck_invite', { p_deck_id: state.deck.id });
    const errEl = $('deckCollabError');
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    refresh();
  };
  const unshareDeck = async (uid) => {
    if (!confirm('Remove your partner from this deck?')) return;
    const { error } = await window.sb.rpc('unshare_deck', { p_deck_id: state.deck.id, p_user_id: uid });
    const errEl = $('deckCollabError');
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    refresh();
  };

  refresh();
}
