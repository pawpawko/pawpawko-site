// Shared binders: co-owner (couples) management + the best-effort realtime
// listings subscription that live-syncs co-editors. Moved verbatim from the
// old js/binder-view.js; only export keywords and the imports were added.

import { state } from './state.js';
import { escapeHtml } from './helpers.js';
import { loadListings } from './index.js';

// ---- Shared binders: manage co-owners (couples) ----
export function setupCollab() {
  const el = document.getElementById('binderCollab');
  if (!el) return;
  if (!state.canEdit) { el.style.display = 'none'; return; }
  // Only trade binders support a co-editing partner — wishlist/flex/lgs can't
  // be shared. (Collaborators only ever exist on trade binders, so the
  // collaborator-view branch below is unaffected.)
  if (state.isOwner && state.binderFlair !== 'trade') { el.style.display = 'none'; return; }
  el.style.display = '';

  const refresh = async () => {
    const { data: collabs } = await window.sb
      .rpc('binder_collaborators_list', { p_binder_id: state.currentBinderId });
    if (state.isOwner) {
      const list = collabs || [];
      const chips = list.map(c =>
        `<span class="collab-chip">${escapeHtml(c.display_name || 'partner')}<button class="collab-remove" data-uid="${c.user_id}" title="Remove" aria-label="Remove">×</button></span>`).join('');
      // One partner per binder — only offer "Add" when there isn't one yet.
      const addBtn = list.length === 0
        ? `<button class="btn small" id="collabAddBtn">+ Add partner</button>` : '';
      el.innerHTML = `
        <div class="collab-row">
          <span class="collab-label">Share with</span>
          ${chips}
          ${addBtn}
        </div>
        <p class="auth-error" id="collabError"></p>`;
      const addEl = el.querySelector('#collabAddBtn');
      if (addEl) addEl.addEventListener('click', addCollab);
      el.querySelectorAll('.collab-remove').forEach(b =>
        b.addEventListener('click', () => removeCollab(b.dataset.uid)));
    } else {
      // Collaborator view — read-only note that this is a shared binder.
      el.innerHTML = `<div class="collab-row"><span class="collab-label">Shared binder</span> <span class="collab-none">you're a co-editor</span></div>`;
    }
  };

  const addCollab = async () => {
    const errEl = document.getElementById('collabError');
    if (errEl) { errEl.textContent = ''; errEl.style.color = ''; }
    const name = prompt("Enter your partner's display name to share this binder with them:");
    if (!name || !name.trim()) return;
    const { error } = await window.sb.rpc('share_binder', { p_binder_id: state.currentBinderId, p_display_name: name.trim() });
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    await refresh();
    const e2 = document.getElementById('collabError');
    if (e2) { e2.style.color = '#7ec96a'; e2.textContent = `Invite sent to ${name.trim()} — they'll get a notification to accept.`; }
  };
  const removeCollab = async (uid) => {
    if (!confirm('Remove this person from the binder?')) return;
    const { error } = await window.sb.rpc('unshare_binder', { p_binder_id: state.currentBinderId, p_user_id: uid });
    const errEl = document.getElementById('collabError');
    if (error) { if (errEl) errEl.textContent = error.message; return; }
    refresh();
  };

  refresh();
}

// Live-sync: when a co-editor changes a card, refresh this view. Best-effort —
// requires Realtime to be enabled for public.listings in Supabase; if it's
// off, both can still edit and see changes on manual refresh.
let realtimeChannel = null;
export function subscribeBinderRealtime() {
  if (!window.sb || !window.sb.channel || !state.currentBinderId) return;
  if (realtimeChannel) { try { window.sb.removeChannel(realtimeChannel); } catch (e) {} realtimeChannel = null; }
  realtimeChannel = window.sb
    .channel('binder-' + state.currentBinderId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'listings', filter: 'binder_id=eq.' + state.currentBinderId },
      () => {
        if (state.aestheticsMode) return; // don't yank the grid out from under a drag
        state.pendingKeepPage = state.currentPage;
        loadListings(state.canEdit, state.lastIsLoggedIn);
      })
    .subscribe();
}
