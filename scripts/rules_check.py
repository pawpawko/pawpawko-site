#!/usr/bin/env python3
"""
Deck-rule reconciliation — DETECT AND REPORT ONLY (writes nothing).

Run automatically at the end of scripts/import_cards.py, or standalone:
    python scripts/rules_check.py

What it does:

  1. Bandai's official ban list (en.onepiece-cardgame.com/rules/restriction/)
     vs. local bans (deck_rule_exceptions max_copies=0) and banned pairs
     (deck_banned_groups) — surfaces new/removed restrictions. This is the
     reliable, automated half.

  2. A light sanity check of rotation_exempt_cards against rotated_sets
     (active vs. dormant exemptions). Informational only.

WHY ROTATION IS NOT BLOCK-DERIVED: we capture each card's block icon from
the official card list, but that icon is the card's ORIGINAL block cohort,
NOT its current rotation block. Proven by counterexample:
  - OP04-016 card-list icon = 1, but Limitless = Block 4, Standard-legal.
  - OP05-003 card-list icon = 1, but Limitless = Block 2, Standard-legal.
Same printed "1", different real blocks (Bandai's "Block Number update"
reassigns the current block while the card list keeps the original). So a
"block 1 == rotated" rule produces false positives (it would flag all of
legal OP05). Rotation therefore stays set-based + manual exemptions, and
block_number is kept as REFERENCE DATA ONLY. Accurate per-card rotation
would require a different source (Limitless' Standard-legal flag).

To apply anything, edit scripts/decks_migration.sql and run it in Supabase.
"""
import os
import re
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv

GAME = "optcg"

CARD_CODE_RE = re.compile(r"(?:OP|ST|EB|PRB)\d{2}-\d{3}")
BAN_URL = "https://en.onepiece-cardgame.com/rules/restriction/"


def _env():
    root = Path(__file__).resolve().parent.parent
    load_dotenv(root / "scripts" / ".env")
    url = os.environ["SUPABASE_URL"].rstrip("/")
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return url, key


def _sb_get(session, url, key, table, params):
    r = session.get(
        f"{url}/rest/v1/{table}",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        params=params, timeout=60,
    )
    r.raise_for_status()
    return r.json()


def fetch_local_rules(session, url, key):
    rotated = {r["set_prefix"] for r in _sb_get(session, url, key, "rotated_sets",
              {"select": "set_prefix", "game": f"eq.{GAME}"})}
    exempt = {r["card_code"] for r in _sb_get(session, url, key, "rotation_exempt_cards",
              {"select": "card_code", "game": f"eq.{GAME}"})}
    bans = {r["card_code"] for r in _sb_get(session, url, key, "deck_rule_exceptions",
            {"select": "card_code,max_copies", "game": f"eq.{GAME}", "max_copies": "eq.0"})}
    pairs = {r["card_code"] for r in _sb_get(session, url, key, "deck_banned_groups",
             {"select": "card_code", "game": f"eq.{GAME}"})}
    return rotated, exempt, bans, pairs


def _has_block_column(session, url, key):
    r = session.get(
        f"{url}/rest/v1/cards",
        headers={"apikey": key, "Authorization": f"Bearer {key}"},
        params={"select": "block_number", "limit": "1"}, timeout=30,
    )
    return r.status_code == 200


def fetch_base_cards(session, url, key):
    """All base-print cards (card_code, name, block_number). Paginated.

    Degrades gracefully if block_number_migration.sql hasn't been applied
    yet: selects without the column and reports it as uncaptured."""
    cols = "card_code,name,block_number" if _has_block_column(session, url, key) else "card_code,name"
    out, offset = [], 0
    while True:
        rows = _sb_get(session, url, key, "cards", {
            "select": cols,
            "game": f"eq.{GAME}", "limit": "1000", "offset": str(offset),
            "order": "card_code.asc",
        })
        out.extend(rows)
        if len(rows) < 1000:
            break
        offset += 1000
    # base prints only (drop _p / _r alt-art rows)
    return [c for c in out if "_" not in c["card_code"]]


def scrape_official_bans(session):
    """Return the set of card codes listed on Bandai's restriction page."""
    r = session.get(BAN_URL, headers={"User-Agent": "Mozilla/5.0 (compatible; pawpawko-rules/1.0)"},
                    allow_redirects=True, timeout=30)
    r.raise_for_status()
    r.encoding = "utf-8"
    return {m.group(0) for m in CARD_CODE_RE.finditer(r.text)}


def reconcile_rotation(cards, exempt, rotated):
    """Block-agnostic exemption sanity check (see module docstring for why we
    do NOT derive rotation from block_number). Splits the exemption list into
    'active' (its set is rotated, so the exemption is doing work) and 'dormant'
    (set not rotated yet — forward-loaded SPR/update cards, harmless)."""
    active, dormant = [], []
    for c in cards:
        code = c["card_code"]
        if code not in exempt:
            continue
        prefix = code.split("-")[0]
        (active if prefix in rotated else dormant).append((code, c.get("name")))
    return active, dormant


def _print_rotation(cards, rotated, exempt):
    active, dormant = reconcile_rotation(cards, exempt, rotated)
    have_block = sum(1 for c in cards if c.get("block_number"))
    print("\n=== Rotation check (set-based; maintained by hand) ===")
    print(f"  rotated sets: {len(rotated)}; exemptions: {len(exempt)} "
          f"({len(active)} active in a rotated set, {len(dormant)} dormant/forward-loaded).")
    print(f"  {have_block}/{len(cards)} base cards have a printed block_number on file "
          "(REFERENCE ONLY — not used for rotation).")
    print("  NOTE: the card-list block icon is the card's ORIGINAL block, not its current "
          "rotation block (e.g. OP05-003 prints 1 but is Standard-legal Block 2), so rotation "
          "is NOT auto-derived. Maintain rotated_sets + rotation_exempt_cards by hand; the ban "
          "check below is the automated part.")
    # Flag the only genuinely actionable rotation case we CAN detect reliably:
    # an exemption whose card no longer exists in the card table (typo/removed).
    missing = sorted(exempt - {c["card_code"] for c in cards})
    if missing:
        print(f"\n  EXEMPTIONS WITH NO MATCHING CARD ({len(missing)}) — typo or removed code?:")
        for code in missing:
            print(f"    - {code}")


def _print_bans(session, bans, pairs):
    print("\n=== Official ban list check ===")
    try:
        official = scrape_official_bans(session)
    except Exception as e:  # network / page-redesign — fail soft, never block import
        print(f"  ! could not read {BAN_URL}: {e}")
        print("    Check the page manually; ban reconciliation skipped this run.")
        return
    local = bans | pairs
    print(f"  (official lists {len(official)} codes; local has "
          f"{len(bans)} bans + {len(pairs)} pair members)")
    new = sorted(official - local)
    gone = sorted(local - official)
    if new:
        print(f"\n  NOT IN YOUR RULES ({len(new)}) — on the official page, missing locally "
              "(new ban or banned pair?):")
        for code in new:
            print(f"    - {code}")
    if gone:
        print(f"\n  NOT ON OFFICIAL PAGE ({len(gone)}) — in your local rules but not currently "
              "listed (possibly unbanned / stale):")
        for code in gone:
            print(f"    - {code}")
    if not new and not gone:
        print("  Local bans/pairs match the official list.")


def run(session=None):
    """Print the full reconciliation report. Reused by import_cards.py."""
    own = session is None
    session = session or requests.Session()
    try:
        url, key = _env()
        rotated, exempt, bans, pairs = fetch_local_rules(session, url, key)
        cards = fetch_base_cards(session, url, key)
        _print_rotation(cards, rotated, exempt)
        _print_bans(session, bans, pairs)
        print("\n--> Detect-and-report only: no rules were written. "
              "Apply confirmed changes in scripts/decks_migration.sql.\n")
    finally:
        if own:
            session.close()


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    run()
