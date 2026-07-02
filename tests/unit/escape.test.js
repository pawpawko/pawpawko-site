import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../../js/escape.js';
// Side-effect import: defines window.PK, whose escapeHtml/escapeAttr must
// delegate to js/escape.js. Runs its config check (warns: not configured).
import '../../js/supabase-client.js';

describe('escapeHtml', () => {
  it('escapes all five HTML-special characters', () => {
    expect(escapeHtml('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('escapes a realistic injection attempt', () => {
    expect(escapeHtml('<script>alert("x&y")</script>')).toBe(
      '&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;'
    );
  });

  it('leaves safe text untouched', () => {
    expect(escapeHtml('Monkey D. Luffy — OP01-001')).toBe('Monkey D. Luffy — OP01-001');
  });

  it('returns the empty string for null and undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('stringifies numbers (including 0)', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(0)).toBe('0');
  });

  it('is attached to window for the browser scripts', () => {
    expect(window.escapeHtml('<')).toBe('&lt;');
  });

  it('backs PK.escapeHtml and PK.escapeAttr (call sites alias these)', () => {
    expect(window.PK.escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
    expect(window.PK.escapeAttr('"quoted" & \'single\'')).toBe(
      '&quot;quoted&quot; &amp; &#39;single&#39;'
    );
  });
});
