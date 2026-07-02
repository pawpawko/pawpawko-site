#!/usr/bin/env node
// ============================================================================
// Constant drift check — pawpawko-site vs pawpawko-mobile
// ============================================================================
// The mobile app hand-mirrors a handful of web constants (listing types,
// binder categories, flair keys). Nothing enforces that mirror; this script
// does, locally. Cross-repo CI would need a PAT for the second repo, so this
// stays a local / pre-push check — run it before any release that touches
// shared constants.
//
// Compared:
//   web js/config.js LISTING_TYPES     <-> mobile LISTING_TYPES        (values + labels, in order)
//   web js/config.js BINDER_CATEGORIES <-> mobile CATEGORY_STYLES keys (values only; labels differ by design)
//   web js/binder/index.js FLAIR_LABELS <-> mobile FLAIR_STYLES keys  (keys only; labels/colors differ by design)
//
// Extraction is brittle BY DESIGN: web config.js is evaluated in node:vm with
// a stub window; the mobile binder-constants.ts and web js/binder/index.js maps
// are pulled out with targeted regexes. If a refactor moves or reshapes those
// blocks, the script exits 2 (parse failure) rather than silently passing.
//
// Exit codes: 0 = in sync, 1 = drift found, 2 = could not run (mobile repo
// missing, parse failure, ...). Treat 2 as "check did not run", never a pass.
//
// Style note: no `import` statements on purpose — the repo's eslint flat
// config parses tools/**/*.mjs as classic scripts, so we stay parseable in
// both modes via process.getBuiltinModule (Node >= 22.3).
// ============================================================================
/* global process */

const { readFileSync, existsSync } = process.getBuiltinModule('node:fs');
const { dirname, join, resolve } = process.getBuiltinModule('node:path');
const vm = process.getBuiltinModule('node:vm');

const webRoot = resolve(dirname(process.argv[1]), '..');
const mobileRoot = resolve(webRoot, '..', 'pawpawko-mobile');

function die(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(2);
}

if (!existsSync(mobileRoot)) {
  die(
    `mobile repo not found at ${mobileRoot}\n` +
      'check-constant-drift needs pawpawko-mobile checked out as a sibling of this repo. ' +
      'Refusing to half-run (exit 2 — not a pass).'
  );
}
const mobileConstantsPath = join(mobileRoot, 'src', 'lib', 'binder-constants.ts');
if (!existsSync(mobileConstantsPath)) die(`mobile constants file missing: ${mobileConstantsPath}`);

// ---------- web: js/config.js (classic script assigning window.*) ----------
const sandbox = { window: {} };
try {
  vm.createContext(sandbox);
  vm.runInContext(readFileSync(join(webRoot, 'js', 'config.js'), 'utf8'), sandbox, {
    filename: 'js/config.js',
  });
} catch (e) {
  die(`could not evaluate js/config.js: ${e.message}`);
}
const webListingTypes = sandbox.window.LISTING_TYPES;
const webCategories = sandbox.window.BINDER_CATEGORIES;
if (!Array.isArray(webListingTypes) || !webListingTypes.length)
  die('js/config.js: window.LISTING_TYPES missing or empty');
if (!Array.isArray(webCategories) || !webCategories.length)
  die('js/config.js: window.BINDER_CATEGORIES missing or empty');

// ---------- web: js/binder/index.js FLAIR_LABELS keys ----------
// js/binder/index.js owns the flair map on web. Its colors live in CSS
// (.flair-*) and its labels intentionally differ from mobile's ("Trade Binder"
// vs "Trade"), so only the KEYS are comparable. That file is a large page
// module that refactors freely — if the regex stops matching, SKIP rather
// than fail.
let webFlairKeys = null;
{
  const src = readFileSync(join(webRoot, 'js', 'binder', 'index.js'), 'utf8');
  const m = src.match(/const FLAIR_LABELS\s*=\s*\{([^}]*)\}/);
  if (m) {
    const keys = [...m[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)].map((k) => k[1]);
    if (keys.length) webFlairKeys = keys;
  }
}

// ---------- mobile: regexes over binder-constants.ts export blocks ----------
const mobileSrc = readFileSync(mobileConstantsPath, 'utf8');

function mobileBlock(name, closer) {
  const m = mobileSrc.match(new RegExp(`export const ${name}[^=]*=\\s*([\\s\\S]*?)${closer}`));
  if (!m)
    die(
      `binder-constants.ts: could not find \`export const ${name}\` — ` +
        'update the regexes in tools/check-constant-drift.mjs'
    );
  return m[1];
}

const mobileListingTypes = [
  ...mobileBlock('LISTING_TYPES', '\\]').matchAll(
    /\{\s*value:\s*'([^']*)',\s*label:\s*'([^']*)'\s*\}/g
  ),
].map((m) => ({ value: m[1], label: m[2] }));
if (!mobileListingTypes.length) die('binder-constants.ts: no LISTING_TYPES entries parsed');

function mobileObjectKeys(name) {
  const keys = [...mobileBlock(name, '\\};').matchAll(/^\s*(\w+):\s*\{/gm)].map((m) => m[1]);
  if (!keys.length) die(`binder-constants.ts: no ${name} keys parsed`);
  return keys;
}
const mobileCategoryKeys = mobileObjectKeys('CATEGORY_STYLES');
const mobileFlairKeys = mobileObjectKeys('FLAIR_STYLES');

// ---------- compare ----------
let drift = 0;
const fmtPairs = (arr) => arr.map((x) => `${x.value}='${x.label}'`).join(', ');
const fmtList = (arr) => arr.join(', ');

function check(label, webSide, mobileSide, fmt) {
  if (JSON.stringify(webSide) === JSON.stringify(mobileSide)) {
    console.log(`PASS    ${label}`);
  } else {
    drift = 1;
    console.log(`DRIFT   ${label}`);
    console.log(`          web:    ${fmt(webSide)}`);
    console.log(`          mobile: ${fmt(mobileSide)}`);
  }
}

console.log(`Constant drift check: ${webRoot}  <->  ${mobileRoot}\n`);
check(
  'LISTING_TYPES values+labels (config.js <-> binder-constants.ts)',
  webListingTypes,
  mobileListingTypes,
  fmtPairs
);
check(
  'binder category values (config.js BINDER_CATEGORIES <-> CATEGORY_STYLES keys)',
  webCategories.map((c) => c.value).sort(),
  [...mobileCategoryKeys].sort(),
  fmtList
);
if (webFlairKeys) {
  check(
    'flair keys (js/binder/index.js FLAIR_LABELS <-> FLAIR_STYLES keys)',
    [...webFlairKeys].sort(),
    [...mobileFlairKeys].sort(),
    fmtList
  );
} else {
  console.log(
    'SKIPPED flair keys — FLAIR_LABELS not found in js/binder/index.js ' +
      '(regex no longer matches; update tools/check-constant-drift.mjs)'
  );
}
console.log(
  'SKIPPED category/flair labels + colors — differ per platform by design ' +
    '(web "OPTCG"/"Trade Binder" vs mobile "One Piece"/"Trade"; web flair colors live in css/styles.css)'
);

console.log(
  drift
    ? '\nDrift found — re-mirror the constants on whichever side moved.'
    : '\nAll mirrored constants in sync.'
);
process.exit(drift);
