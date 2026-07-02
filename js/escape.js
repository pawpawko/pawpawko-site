// ============================================
// Pawpaw Ko — HTML output escaper
// ============================================
// Single source of truth for escaping user data into HTML. Lives in its own
// dependency-free file (loaded right before supabase-client.js) so unit tests
// can import it without booting the Supabase client. Page modules keep using
// PK.escapeHtml / PK.escapeAttr, which delegate to window.escapeHtml.

(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s ?? '').replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
    );
  }

  if (typeof window !== 'undefined') window.escapeHtml = escapeHtml;
  if (typeof module !== 'undefined' && module.exports) module.exports = { escapeHtml };
})();
