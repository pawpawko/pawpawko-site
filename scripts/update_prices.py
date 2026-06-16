#!/usr/bin/env python3
"""
Update One Piece card prices in Supabase (cards.price_usd).

Source: Limitless (onepiece.limitlesstcg.com/cards/<CODE>), which surfaces
TCGplayer USD prices per print in server-rendered HTML. For each card NUMBER
we take the CHEAPEST USD price across its prints (i.e. the cheapest playable
copy you'd buy to own that card) and write it to cards.price_usd with a
price_updated_at stamp. Only BASE codes are priced (decks reference base
codes; the _p alt-art rows share the same number and aren't tracked).

Requires scripts/card_prices_migration.sql applied first (adds the columns).

Run from project root:
    python scripts/update_prices.py                  # incremental: unpriced or stale (>7d)
    python scripts/update_prices.py --full           # refetch every OP base card
    python scripts/update_prices.py OP16-032 OP16-042  # specific codes only
"""
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from dotenv import load_dotenv

try:
    sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / "scripts" / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

GAME       = "optcg"
LIMITLESS  = "https://onepiece.limitlesstcg.com/cards/"
STALE_DAYS = 7          # incremental: re-price anything older than this
THROTTLE   = 0.25       # politeness delay between Limitless fetches (seconds)

SB = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

sb_session = requests.Session()
sb_session.headers.update({"User-Agent": "pawpawko-prices/1.0 (server)"})

web_session = requests.Session()
web_session.headers.update({"User-Agent": "Mozilla/5.0 PawpawKoPrices/1.0"})

# <a class="card-price usd" ...>$2.57</a>  — one per print on the page.
PRICE_RE = re.compile(r'class="card-price usd"[^>]*>\s*\$([0-9][0-9,]*\.?[0-9]*)', re.I)
# Base codes only: skip alt-art parallels like OP12-041_p1.
ALT_RE = re.compile(r"_p\d+$", re.I)


def fetch_price(code: str):
    """Cheapest USD price across the card number's prints, or None."""
    try:
        r = web_session.get(LIMITLESS + code, timeout=30)
    except Exception as e:
        print(f"    ! {code}: fetch error {e}")
        return None
    if r.status_code != 200:
        return None
    vals = []
    for m in PRICE_RE.findall(r.text):
        try:
            vals.append(float(m.replace(",", "")))
        except ValueError:
            pass
    return min(vals) if vals else None


def fetch_all_base_codes():
    """All OPTCG base card_codes with their current price + last-updated stamp."""
    rows = []
    offset = 0
    while True:
        r = sb_session.get(
            f"{SUPABASE_URL}/rest/v1/cards",
            headers=SB,
            params={
                "select": "card_code,price_usd,price_updated_at",
                "game": f"eq.{GAME}",
                "order": "card_code",
                "limit": 1000,
                "offset": offset,
            },
            timeout=60,
        )
        if r.status_code != 200:
            print(f"  ! fetch codes failed: {r.status_code} {r.text[:200]}")
            sys.exit(1)
        batch = r.json()
        if not batch:
            break
        rows.extend(batch)
        if len(batch) < 1000:
            break
        offset += 1000
    return [row for row in rows if not ALT_RE.search(row["card_code"])]


def is_stale(row, cutoff):
    if row.get("price_usd") is None or not row.get("price_updated_at"):
        return True
    try:
        stamped = datetime.fromisoformat(row["price_updated_at"].replace("Z", "+00:00"))
    except ValueError:
        return True
    return stamped < cutoff


def write_price(code, price, now_iso):
    """UPDATE only the price columns for one card. Must be a PATCH, not a
    merge-duplicates POST: cards.name is NOT NULL, so an upsert of a partial
    row attempts an INSERT and trips the not-null constraint (ON CONFLICT
    doesn't catch NOT NULL). Same reason backfill_optcg_types.py uses PATCH."""
    r = sb_session.patch(
        f"{SUPABASE_URL}/rest/v1/cards",
        headers={**SB, "Content-Type": "application/json", "Prefer": "return=minimal"},
        params={"game": f"eq.{GAME}", "card_code": f"eq.{code}"},
        json={"price_usd": price, "price_updated_at": now_iso},
        timeout=60,
    )
    if r.status_code not in (200, 204):
        print(f"  ! {code}: write failed {r.status_code} {r.text[:200]}")
        return False
    return True


def main():
    print("=== Pawpaw Ko price update (Limitless → TCGplayer USD) ===")
    args = sys.argv[1:]
    full = "--full" in args
    codes_arg = [a.upper() for a in args if not a.startswith("--")]

    if codes_arg:
        targets = codes_arg
        print(f"[1] Specific codes: {len(targets)}")
    else:
        print("[1] Loading OPTCG base codes...")
        rows = fetch_all_base_codes()
        if full:
            targets = [row["card_code"] for row in rows]
            print(f"    --full: pricing all {len(targets)} base cards")
        else:
            cutoff = datetime.now(timezone.utc) - timedelta(days=STALE_DAYS)
            targets = [row["card_code"] for row in rows if is_stale(row, cutoff)]
            print(f"    incremental: {len(targets)} of {len(rows)} unpriced or stale (>{STALE_DAYS}d)")

    if not targets:
        print("=== Nothing to price. ===")
        return

    now_iso = datetime.now(timezone.utc).isoformat()
    priced, blank, failed = 0, 0, 0
    print("[2] Fetching prices...")
    for i, code in enumerate(targets, 1):
        price = fetch_price(code)
        if not write_price(code, price, now_iso):
            failed += 1
        elif price is None:
            blank += 1
        else:
            priced += 1
        if i % 50 == 0 or i == len(targets):
            print(f"    {i}/{len(targets)}  (priced {priced}, no-price {blank}, failed {failed})")
        time.sleep(THROTTLE)

    print(f"=== Done. {priced} priced, {blank} had no USD price (left null), {failed} write errors. ===")
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    main()
