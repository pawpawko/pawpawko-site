#!/usr/bin/env node
// ============================================================================
// RLS regression probe — pawpawko-site
// ============================================================================
// Probes the PRODUCTION Supabase project with (a) the anon key and (b) the
// persistent e2e test account, asserting that Row Level Security still holds.
// RLS is this site's primary security boundary, so run this after EVERY
// migration that touches policies, and let the weekly CI run catch drift.
//
// History this guards against: in June 2026 the `decks_select` policy was
// changed to rely solely on a STABLE SECURITY DEFINER membership function;
// during `INSERT ... RETURNING` (what supabase-js `.insert().select()` emits)
// the returning row failed the SELECT policy -> 42501 -> deck creation was
// dead for ALL users for two weeks, silently. Assertion 5 replays that exact
// request shape.
//
// Usage:
//   npm run rls-probe
// Credentials: TEST_EMAIL / TEST_PASSWORD from the environment, or from the
// untracked .env.e2e.local at the repo root (same creds as the GitHub Actions
// secrets). Secrets are never printed.
//
// Safety: creates only minimal rows, all named `rls-probe-<ts>`; pre-cleans
// leftovers from crashed runs; verifies zero leftovers at the end. NEVER
// touches the auth user itself.
//
// Style note: no `import` statements on purpose — the repo's eslint flat
// config parses scripts/**/*.mjs as classic scripts, so we stay parseable in
// both modes via process.getBuiltinModule (Node >= 22.3).
// ============================================================================
/* global process */

const { readFileSync } = process.getBuiltinModule('node:fs');
const { dirname, join } = process.getBuiltinModule('node:path');

const repoRoot = join(dirname(process.argv[1]), '..');

// ---------- config (single source of truth: js/config.js) ----------
const configSrc = readFileSync(join(repoRoot, 'js', 'config.js'), 'utf8');
const SUPABASE_URL = configSrc.match(/SUPABASE_URL:\s*'([^']+)'/)?.[1];
const ANON_KEY = configSrc.match(/SUPABASE_ANON_KEY:\s*'([^']+)'/)?.[1];
if (!SUPABASE_URL || !ANON_KEY) {
  console.error('Could not parse SUPABASE_URL / SUPABASE_ANON_KEY from js/config.js');
  process.exit(2);
}

// ---------- credentials (env first, .env.e2e.local fallback; never printed) ----------
if (!process.env.TEST_EMAIL || !process.env.TEST_PASSWORD) {
  try {
    process.loadEnvFile(join(repoRoot, '.env.e2e.local'));
  } catch {
    /* file absent (e.g. CI) — env vars must be set instead */
  }
}
const TEST_EMAIL = process.env.TEST_EMAIL;
const TEST_PASSWORD = process.env.TEST_PASSWORD;
if (!TEST_EMAIL || !TEST_PASSWORD) {
  console.error('TEST_EMAIL / TEST_PASSWORD not set (env or .env.e2e.local). Aborting.');
  process.exit(2);
}

const TS = Date.now();
const PROBE_PREFIX = 'rls-probe-';
const probeName = (suffix) => `${PROBE_PREFIX}${TS}${suffix ? `-${suffix}` : ''}`;

// ---------- tiny REST client ----------
async function rest(path, { method = 'GET', token = null, body, prefer } = {}) {
  const headers = {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token ?? ANON_KEY}`,
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON body */
  }
  return { status: res.status, ok: res.ok, json, text };
}

const rpc = (name, args, opts = {}) =>
  rest(`/rest/v1/rpc/${name}`, { method: 'POST', body: args, ...opts });

// ---------- result tracking ----------
let failures = 0;
function pass(name, detail = '') {
  console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`);
}
function fail(name, detail = '') {
  failures += 1;
  console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`);
}
function skip(name, reason) {
  console.log(`SKIP  ${name}  (${reason})`);
}
// Redact anything that could be sensitive from response bodies we echo.
const brief = (r) =>
  `status=${r.status} body=${(r.text || '').slice(0, 200).replace(/\s+/g, ' ')}`;

// ============================================================================
async function main() {
  console.log(`rls-probe against ${SUPABASE_URL} — run id ${TS}`);

  // ---------- sign in test user up front (uid needed for several checks) ----
  const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  const authJson = await auth.json().catch(() => null);
  if (!auth.ok || !authJson?.access_token || !authJson?.user?.id) {
    console.error(`Sign-in as test user failed (status=${auth.status}). Aborting.`);
    process.exit(2);
  }
  const token = authJson.access_token;
  const uid = authJson.user.id;

  // ---------- pre-clean leftovers from crashed runs --------------------------
  for (const table of ['decks', 'binders']) {
    const del = await rest(
      `/rest/v1/${table}?user_id=eq.${uid}&name=like.${PROBE_PREFIX}*`,
      { method: 'DELETE', token, prefer: 'return=representation' }
    );
    const n = Array.isArray(del.json) ? del.json.length : 0;
    if (n > 0) console.log(`pre-clean: removed ${n} leftover ${PROBE_PREFIX}* row(s) from ${table}`);
  }

  // ==========================================================================
  // ANON assertions (anon key only, no user token)
  // ==========================================================================

  // 1. Raw listings select as anon -> zero rows or denied
  {
    const r = await rest('/rest/v1/listings?select=id&limit=5');
    if (r.ok && Array.isArray(r.json) && r.json.length === 0) {
      pass('1 anon: listings select returns zero rows');
    } else if (!r.ok) {
      pass('1 anon: listings select denied', `status=${r.status}`);
    } else {
      fail('1 anon: listings select leaked rows', brief(r));
    }
  }

  // 2. Raw notifications select as anon -> zero rows or denied
  {
    const r = await rest('/rest/v1/notifications?select=id&limit=5');
    if (r.ok && Array.isArray(r.json) && r.json.length === 0) {
      pass('2 anon: notifications select returns zero rows');
    } else if (!r.ok) {
      pass('2 anon: notifications select denied', `status=${r.status}`);
    } else {
      fail('2 anon: notifications select leaked rows', brief(r));
    }
  }

  // 3. get_binder_public works for a public binder discovered via search_binders
  {
    const search = await rpc('search_binders', {});
    if (!search.ok || !Array.isArray(search.json)) {
      fail('3 anon: search_binders RPC callable', brief(search));
    } else if (search.json.length === 0) {
      skip('3 anon: get_binder_public', 'search_binders returned no public binders');
    } else {
      const binderId = search.json[0].binder_id;
      const r = await rpc('get_binder_public', { p_binder_id: binderId });
      if (r.ok && Array.isArray(r.json) && r.json.length >= 1 && r.json[0].id === binderId) {
        pass('3 anon: get_binder_public returns the public binder');
      } else {
        fail('3 anon: get_binder_public failed for a public binder', brief(r));
      }
    }
  }

  // 4. Writing to binders as anon is denied (even when spoofing a real user_id)
  {
    const r = await rest('/rest/v1/binders', {
      method: 'POST',
      body: { user_id: uid, name: probeName('anon'), category: 'optcg' },
      prefer: 'return=representation',
    });
    if (!r.ok) {
      pass('4 anon: binders insert denied', `status=${r.status}`);
    } else {
      fail('4 anon: binders insert SUCCEEDED — RLS hole', brief(r));
      // best-effort cleanup with the authed user
      const created = Array.isArray(r.json) ? r.json[0]?.id : null;
      if (created) await rest(`/rest/v1/binders?id=eq.${created}`, { method: 'DELETE', token });
    }
  }

  // ==========================================================================
  // TEST USER assertions
  // ==========================================================================

  // Pick a real optcg LEADER card that isn't construction-banned.
  let leaderCode = null;
  {
    const [leaders, banned] = await Promise.all([
      rest('/rest/v1/cards?game=eq.optcg&type=eq.LEADER&select=card_code&order=card_code&limit=25', { token }),
      rest('/rest/v1/deck_rule_exceptions?game=eq.optcg&max_copies=eq.0&select=card_code', { token }),
    ]);
    const bannedSet = new Set((banned.json ?? []).map((b) => b.card_code));
    leaderCode = (leaders.json ?? []).map((c) => c.card_code).find((c) => !bannedSet.has(c)) ?? null;
  }

  // 5. THE OUTAGE PATH: decks INSERT ... RETURNING (insert().select('id')) succeeds
  {
    if (!leaderCode) {
      fail('5 user: decks insert-returning', 'could not find an optcg LEADER card in cards');
    } else {
      const r = await rest('/rest/v1/decks?select=id', {
        method: 'POST',
        token,
        body: {
          user_id: uid,
          game: 'optcg',
          leader_card_code: leaderCode,
          name: probeName('deck'),
          format: 'eternal', // sidestep Standard-rotation churn; RLS path is identical
        },
        prefer: 'return=representation',
      });
      const deckId = Array.isArray(r.json) ? r.json[0]?.id : null;
      if (r.status === 201 && deckId) {
        pass('5 user: decks INSERT...RETURNING succeeds (June-outage path)', `leader=${leaderCode}`);
        const del = await rest(`/rest/v1/decks?id=eq.${deckId}`, {
          method: 'DELETE',
          token,
          prefer: 'return=representation',
        });
        if (!(del.ok && Array.isArray(del.json) && del.json.length === 1)) {
          fail('5 user: probe deck cleanup delete', brief(del));
        }
      } else {
        fail('5 user: decks INSERT...RETURNING FAILED — the June outage is back', brief(r));
      }
    }
  }

  // 6. binders insert-returning; own-binder listing insert-returning;
  //    foreign-binder listing insert denied; delete cascades listings.
  {
    const cardCode = leaderCode ?? 'OP01-001';
    const b = await rest('/rest/v1/binders?select=id', {
      method: 'POST',
      token,
      body: { user_id: uid, name: probeName('binder'), category: 'optcg' },
      prefer: 'return=representation',
    });
    const binderId = Array.isArray(b.json) ? b.json[0]?.id : null;
    if (!(b.status === 201 && binderId)) {
      fail('6 user: binders INSERT...RETURNING', brief(b));
    } else {
      pass('6a user: binders INSERT...RETURNING succeeds');

      const l = await rest('/rest/v1/listings?select=id', {
        method: 'POST',
        token,
        body: { binder_id: binderId, card_code: cardCode, quantity: 1, listing_type: 'trade' },
        prefer: 'return=representation',
      });
      if (l.status === 201 && Array.isArray(l.json) && l.json[0]?.id) {
        pass('6b user: listings insert into own binder succeeds');
      } else {
        fail('6b user: listings insert into own binder', brief(l));
      }

      // a binder we do NOT own (authenticated users can read all binders)
      const foreign = await rest(`/rest/v1/binders?select=id&user_id=neq.${uid}&limit=1`, { token });
      const foreignBinderId = Array.isArray(foreign.json) ? foreign.json[0]?.id : null;
      if (!foreignBinderId) {
        skip('6c user: listings insert into foreign binder denied', 'no foreign binder found in prod');
      } else {
        const lf = await rest('/rest/v1/listings?select=id', {
          method: 'POST',
          token,
          body: { binder_id: foreignBinderId, card_code: cardCode, quantity: 1, listing_type: 'trade' },
          prefer: 'return=representation',
        });
        if (!lf.ok) {
          pass('6c user: listings insert into foreign binder denied', `status=${lf.status}`);
        } else {
          fail('6c user: listings insert into FOREIGN binder SUCCEEDED — RLS hole', brief(lf));
          const leaked = Array.isArray(lf.json) ? lf.json[0]?.id : null;
          if (leaked) await rest(`/rest/v1/listings?id=eq.${leaked}`, { method: 'DELETE', token });
        }
      }

      // delete own binder; listings must cascade
      const delB = await rest(`/rest/v1/binders?id=eq.${binderId}`, {
        method: 'DELETE',
        token,
        prefer: 'return=representation',
      });
      const orphans = await rest(`/rest/v1/listings?select=id&binder_id=eq.${binderId}`, { token });
      if (
        delB.ok &&
        Array.isArray(delB.json) &&
        delB.json.length === 1 &&
        Array.isArray(orphans.json) &&
        orphans.json.length === 0
      ) {
        pass('6d user: binder delete cascades its listings');
      } else {
        fail('6d user: binder delete / listings cascade', `${brief(delB)}; orphans=${orphans.json?.length}`);
      }
    }
  }

  // 7. profiles: own-row update succeeds; foreign-row update affects 0 rows.
  //    Both updates are value no-ops (set city to its current value) so even a
  //    broken policy cannot corrupt real data.
  {
    const own = await rest(`/rest/v1/profiles?select=user_id,city&user_id=eq.${uid}`, { token });
    const ownCity = own.json?.[0]?.city;
    if (!ownCity) {
      fail('7 user: read own profile', brief(own));
    } else {
      const u = await rest(`/rest/v1/profiles?user_id=eq.${uid}`, {
        method: 'PATCH',
        token,
        body: { city: ownCity },
        prefer: 'return=representation',
      });
      if (u.ok && Array.isArray(u.json) && u.json.length === 1) {
        pass('7a user: own profile update succeeds');
      } else {
        fail('7a user: own profile update', brief(u));
      }
    }

    const other = await rest(`/rest/v1/profiles?select=user_id,city&user_id=neq.${uid}&limit=1`, { token });
    const foreignUid = other.json?.[0]?.user_id;
    const foreignCity = other.json?.[0]?.city;
    if (!foreignUid) {
      skip('7b user: foreign profile update affects 0 rows', 'no foreign profile found in prod');
    } else {
      const u = await rest(`/rest/v1/profiles?user_id=eq.${foreignUid}`, {
        method: 'PATCH',
        token,
        body: { city: foreignCity }, // no-op value on purpose
        prefer: 'return=representation',
      });
      if (u.ok && Array.isArray(u.json) && u.json.length === 0) {
        pass('7b user: foreign profile update affects 0 rows');
      } else if (!u.ok) {
        pass('7b user: foreign profile update denied', `status=${u.status}`);
      } else {
        fail('7b user: foreign profile update AFFECTED ROWS — RLS hole', brief(u));
      }
    }
  }

  // 8. notifications select returns only own rows (0 rows is fine)
  {
    const r = await rest('/rest/v1/notifications?select=user_id&limit=1000', { token });
    if (!r.ok || !Array.isArray(r.json)) {
      fail('8 user: notifications select', brief(r));
    } else {
      const foreign = r.json.filter((n) => n.user_id !== uid);
      if (foreign.length === 0) {
        pass('8 user: notifications contain no foreign rows', `${r.json.length} own row(s)`);
      } else {
        fail('8 user: notifications LEAKED foreign rows', `${foreign.length} foreign of ${r.json.length}`);
      }
    }
  }

  // ---------- final cleanup + leftover audit --------------------------------
  {
    for (const table of ['decks', 'binders']) {
      await rest(`/rest/v1/${table}?user_id=eq.${uid}&name=like.${PROBE_PREFIX}*`, {
        method: 'DELETE',
        token,
      });
    }
    const [decksLeft, bindersLeft] = await Promise.all([
      rest(`/rest/v1/decks?select=id&user_id=eq.${uid}&name=like.${PROBE_PREFIX}*`, { token }),
      rest(`/rest/v1/binders?select=id&user_id=eq.${uid}&name=like.${PROBE_PREFIX}*`, { token }),
    ]);
    const leftovers = (decksLeft.json?.length ?? 0) + (bindersLeft.json?.length ?? 0);
    if (leftovers === 0) {
      pass('9 cleanup: zero rls-probe-* leftovers remain');
    } else {
      fail('9 cleanup: rls-probe-* leftovers remain', `count=${leftovers}`);
    }
  }

  console.log(failures === 0 ? '\nrls-probe: ALL GREEN' : `\nrls-probe: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('rls-probe crashed:', err?.message ?? err);
  process.exit(2);
});
