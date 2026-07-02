// ============================================
// Pawpaw Ko — Supabase client + auth helpers
// ============================================
// Loads after config.js and the @supabase/supabase-js UMD bundle.

(function () {
  const cfg = window.PAWPAWKO_CONFIG || {};
  const ready = !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && window.supabase);

  if (!ready) {
    window.sb = null;
    window.SB_READY = false;
    console.warn('[Pawpaw Ko] Supabase not configured yet. Fill in js/config.js.');
    return;
  }

  window.sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  window.SB_READY = true;
})();

// --- Auth helpers ---
window.PK = {
  // HTML/attribute output escaper — implementation lives in js/escape.js
  // (standalone so unit tests can import it; loaded right before this file).
  // Page modules alias these (e.g. `const escapeHtml = window.PK.escapeHtml`).
  // escapeAttr is a safe superset (also escapes & and ') so it's fine in
  // quoted attribute values.
  escapeHtml: (s) => window.escapeHtml(s),
  escapeAttr: (s) => window.escapeHtml(s),

  async currentUser() {
    if (!window.SB_READY) return null;
    const { data } = await window.sb.auth.getUser();
    return data?.user || null;
  },

  async signUp(email, password, displayName) {
    if (!window.SB_READY) throw new Error('Supabase not configured');
    const { data, error } = await window.sb.auth.signUp({
      email, password,
      options: { data: { display_name: displayName } }
    });
    if (error) throw error;
    return data;
  },

  async signIn(email, password) {
    if (!window.SB_READY) throw new Error('Supabase not configured');
    const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  },

  async signInWithGoogle() {
    if (!window.SB_READY) throw new Error('Supabase not configured');
    const { data, error } = await window.sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/account.html' }
    });
    if (error) throw error;
    return data;
  },

  async signInWithDiscord() {
    if (!window.SB_READY) throw new Error('Supabase not configured');
    const { data, error } = await window.sb.auth.signInWithOAuth({
      provider: 'discord',
      options: { redirectTo: window.location.origin + '/account.html' }
    });
    if (error) throw error;
    return data;
  },

  async signOut() {
    if (!window.SB_READY) return;
    await window.sb.auth.signOut();
  },

  // Render a "you must be logged in" or "config missing" notice into a target element
  notReadyMessage() {
    if (!window.SB_READY) {
      return '<div class="notice notice-warn"><strong>Trades setup pending.</strong> Supabase keys not configured yet — see <code>js/config.js</code>.</div>';
    }
    return '';
  }
};
