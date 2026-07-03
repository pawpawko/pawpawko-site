#!/usr/bin/env node
// stamp-partials.mjs — keep the shared HTML chunks identical across pages.
//
// Source of truth: partials/<name>.html. Every root *.html page marks each
// shared region with a marker pair:
//
//   <!-- partial:nav -->
//   ...region content...
//   <!-- /partial:nav -->
//
// `node tools/stamp-partials.mjs`          rewrites every marker region from
//                                          its partial file (in place).
// `node tools/stamp-partials.mjs --check`  writes nothing; exits 1 listing
//                                          any page whose region differs from
//                                          the partial (CI guard).
//
// Why this exists: the shared head/nav/script chunks used to be hand-copied
// across all pages, which invited bulk edits — one of those mojibake'd every
// page on 2026-06-15 (UTF-8 read as ANSI). This tool is the only sanctioned
// way to edit a shared region: edit partials/<name>.html, run `npm run
// partials`. It reads and writes UTF-8 explicitly (never PowerShell text
// cmdlets) and never touches bytes outside the marker pairs.
//
// CSP NOTE: the inline scripts inside head-shared are hash-pinned in
// _headers. Their bytes must stay exactly as pinned — see the regen recipe
// in _headers before editing them.
//
// Line endings: partial content is normalized to each page's own EOL style,
// so a CRLF working tree (Windows, autocrlf=true) and an LF checkout (CI)
// both round-trip byte-identically.
//
// Style note: no `import` statements on purpose — the repo's eslint flat
// config parses tools/**/*.mjs as classic scripts, so we stay parseable in
// both modes via process.getBuiltinModule (Node >= 22.3), same as
// check-constant-drift.mjs.
/* global process */

const fs = process.getBuiltinModule('node:fs');
const path = process.getBuiltinModule('node:path');

const ROOT = path.resolve(path.dirname(process.argv[1]), '..');
const PARTIALS_DIR = path.join(ROOT, 'partials');
const CHECK = process.argv.includes('--check');

// Pages allowed to omit some/all partials (none today). Add a filename here
// only for a genuinely standalone page, so a forgotten marker still fails.
const EXEMPT = new Set();

const OPEN = /<!-- partial:([a-z0-9-]+) -->/g;

function fail(msg) {
  console.error('stamp-partials: ' + msg);
  process.exitCode = 2;
}

const partials = {};
if (fs.existsSync(PARTIALS_DIR)) {
  for (const f of fs.readdirSync(PARTIALS_DIR).filter((f) => f.endsWith('.html'))) {
    partials[path.basename(f, '.html')] = fs.readFileSync(path.join(PARTIALS_DIR, f), 'utf8');
  }
}

const pages = fs
  .readdirSync(ROOT)
  .filter((f) => f.endsWith('.html'))
  .sort();

const outOfSync = []; // {page, regions:[...]} for --check reporting
let stamped = 0;

for (const page of pages) {
  const file = path.join(ROOT, page);
  const src = fs.readFileSync(file, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const seen = new Set();
  const diffRegions = [];
  let out = '';
  let pos = 0;

  OPEN.lastIndex = 0;
  for (let m; (m = OPEN.exec(src));) {
    const name = m[1];
    const partial = partials[name];
    if (partial === undefined) {
      fail(`${page}: marker "partial:${name}" has no partials/${name}.html`);
      continue;
    }
    if (seen.has(name)) {
      fail(`${page}: duplicate marker "partial:${name}"`);
      continue;
    }
    seen.add(name);

    // Region content spans from just after the opening marker's newline to
    // the start of the closing marker's line (its indentation included).
    const afterOpen = src.indexOf('\n', m.index);
    const close = src.indexOf(`<!-- /partial:${name} -->`, m.index);
    if (afterOpen === -1 || close === -1 || close < afterOpen) {
      fail(`${page}: marker "partial:${name}" is not closed`);
      continue;
    }
    const closeLineStart = src.lastIndexOf('\n', close) + 1;

    // Partial file -> region bytes: page's EOL style, exactly one trailing EOL.
    const body = partial.replace(/\r?\n/g, eol).replace(/(?:\r?\n)*$/, eol);

    out += src.slice(pos, afterOpen + 1) + body;
    pos = closeLineStart;
    if (src.slice(afterOpen + 1, closeLineStart) !== body) diffRegions.push(name);
    OPEN.lastIndex = close;
  }
  out += src.slice(pos);

  const missing = Object.keys(partials).filter((n) => !seen.has(n));
  if (missing.length && !EXEMPT.has(page)) {
    fail(
      `${page}: missing marker(s) for: ${missing.join(', ')} (add the page to EXEMPT if intentional)`
    );
  }

  if (diffRegions.length) {
    if (CHECK) {
      outOfSync.push({ page, regions: diffRegions });
    } else {
      fs.writeFileSync(file, out, 'utf8');
      stamped++;
      console.log(`stamped ${page}: ${diffRegions.join(', ')}`);
    }
  }
}

if (CHECK) {
  if (outOfSync.length) {
    console.error('stamp-partials --check: regions out of sync with partials/*.html:');
    for (const { page, regions } of outOfSync) {
      console.error(`  ${page}: ${regions.join(', ')}`);
    }
    console.error('Run `npm run partials` to restamp (edit partials/, never the copies).');
    process.exitCode = 1;
  } else if (process.exitCode === undefined) {
    console.log(
      `stamp-partials --check: ${pages.length} page(s) in sync with ${Object.keys(partials).length} partial(s).`
    );
  }
} else if (stamped === 0 && process.exitCode === undefined) {
  console.log(`stamp-partials: ${pages.length} page(s) already in sync — nothing to write.`);
}
