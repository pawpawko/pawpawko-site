#!/usr/bin/env python3
"""
Import Cyberpunk TCG card data into Supabase — ONE ROW PER PRINTING.

Source: netdeck.gg's public JSON API (cyberpunktcg.com is a skin over netdeck).
  - GET https://api.netdeck.gg/api/cards/cyberpunk?limit=&offset=  -> {items,total}
      Enumerates the ~65 unique cards (card-level metadata; printings empty here).
  - GET https://api.netdeck.gg/api/cards/cyberpunk/<slug>          -> full card
      Card-level metadata PLUS a `printings[]` array. Each printing has its own
      set, collector_number, rarity, artist and a FRESHLY-SIGNED image_url
      (the SSR HTML's signed CloudFront URLs expire ~30h and 403 — the API
      re-signs on demand, so we use it directly).

We store every printing as its own row (Beta + Retail print runs + a/b alt-arts
+ promos = ~181 rows) so each is independently listable/tradeable, matching a
collection/trade app. Printings of the same card share `name`, so the UI groups
by (game, name). Card art is mirrored to R2 under `cyberpunk/`, namespaced away
from optcg (bucket root) and pokemon (`pokemon/`).

  card_code = cb-<slug>-<collector>   e.g. cb-v-streetkid-005a   (β -> b)
  game      = cyberpunk
  number    = printing collector_number (keeps the β for display)
  set_id    = printing set code   series = printing set name

Schema: scripts/cyberpunk_migration.sql (game-check widened + ram/is_eddiable/
keywords/artist/legality cols). The importer probes for those columns and
degrades gracefully if absent.

Deck rules captured separately in scripts/cyberpunk_rules.md +
scripts/cyberpunk_deck_rules.json (for the future deck-builder).

Run from project root:
    python scripts/import_cyberpunk_cards.py            # incremental (new printings only)
    python scripts/import_cyberpunk_cards.py --full     # re-download + re-upsert all
    python scripts/import_cyberpunk_cards.py --dry-run   # parse + print, no R2/DB writes
    python scripts/import_cyberpunk_cards.py v-streetkid  # single card (all its printings)
"""
import io
import os
import re
import sys
import json
import time
from pathlib import Path

import boto3
import requests
from botocore.config import Config
from botocore.exceptions import ClientError
from dotenv import load_dotenv
from PIL import Image

try:
    sys.stdout.reconfigure(line_buffering=True)
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / "scripts" / ".env")

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY  = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

API_BASE = "https://api.netdeck.gg/api/cards/cyberpunk"
GAME     = "cyberpunk"
PAGE     = 60

R2_PUBLIC_BASE = os.environ["R2_PUBLIC_BASE"].rstrip("/")
R2_ENDPOINT    = os.environ["R2_ENDPOINT"].rstrip("/")
R2_KEY         = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET      = os.environ["R2_SECRET_ACCESS_KEY"]
R2_BUCKET      = os.environ["R2_BUCKET"]

R2_PREFIX    = "cyberpunk"
TILE_WIDTH   = 400
LG_WIDTH     = 734
WEBP_QUALITY = 82

# All current sets are the single launch wave (+ a PRM01 promo); one release_order
# is fine (ties break by card_code). Add entries to lock cross-wave ordering later.
SET_ORDER = {}
DEFAULT_ORDER = 1

# Collector numbers are unique per SET, not per card (e.g. a card reprinted in two
# starter decks is #001 in both), so the card_code needs a set token. The token
# also encodes the Beta vs Retail print run, so the collector's 'β' is dropped.
# Unknown future sets fall back to their sanitized full code (uglier but unique).
SET_ABBREV = {
    "welcometonightcityretail":        "wnc",
    "welcometonightcitybeta":          "wncb",
    "theheistretailstarterdeck":       "th",
    "theheistbetastarterdeck":         "thb",
    "embracingpowerretailstarterdeck": "ep",
    "embracingpowerbetastarterdeck":   "epb",
    "boxtoppersretail":                "bt",
    "boxtoppersbeta":                  "btb",
    "prm01":                           "prm01",
}


def set_token(set_code):
    if not set_code:
        return "x"
    return SET_ABBREV.get(set_code) or re.sub(r"[^a-z0-9]", "", set_code.lower())

web = requests.Session()
web.headers.update({"User-Agent": "Mozilla/5.0 PawpawKoImporter/1.0 (cyberpunk)",
                    "Accept": "application/json"})

s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_KEY,
    aws_secret_access_key=R2_SECRET,
    config=Config(signature_version="s3v4", region_name="auto", s3={"addressing_style": "path"}),
)

sb_session = requests.Session()
sb_session.headers.update({"User-Agent": "pawpawko-importer/1.0 (server)"})
SB = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}

EXTRA_COLS = ["ram", "is_eddiable", "keywords", "artist", "legality"]
INCLUDE_EXTRA = {c: True for c in EXTRA_COLS}


# --------------------------------------------------------------------------- #
#  Source (netdeck JSON API)
# --------------------------------------------------------------------------- #
def list_slugs():
    """All unique cyberpunk card slugs, paginating the list endpoint."""
    slugs, offset, total = [], 0, None
    while True:
        r = web.get(API_BASE, params={"limit": PAGE, "offset": offset}, timeout=60)
        r.raise_for_status()
        d = r.json()
        items = d.get("items", [])
        total = d.get("total")
        slugs += [it["slug"] for it in items if it.get("slug")]
        offset += len(items)
        if not items or (total is not None and offset >= total):
            break
    return slugs, total


def fetch_card_detail(slug):
    r = web.get(f"{API_BASE}/{slug}", timeout=60)
    r.raise_for_status()
    return r.json()


def norm_collector(num):
    """Normalize a collector number into a card_code-safe token. The Beta 'β'
    prefix is stripped (the set token already encodes Beta vs Retail), lowercased,
    non-alphanumerics removed. '005a'->'005a', 'β005a'->'005a'."""
    if not num:
        return ""
    s = num.replace("β", "").replace("Β", "").lower()
    return re.sub(r"[^a-z0-9]", "", s)


def printing_rows(card):
    """Yield one DB row per printing of a card."""
    slug = card.get("slug")
    base = {
        "name":        card.get("display_name") or card.get("name"),
        "color":       card.get("color"),
        "type":        card.get("card_type"),
        "cost":        card.get("cost"),
        "power":       card.get("power"),
        "ram":         card.get("ram"),
        "effect_text": card.get("rules_text"),
        "types":       card.get("classifications") or None,
        "keywords":    card.get("keywords") or None,
        "is_eddiable": card.get("is_eddiable"),
        "legality":    card.get("legality"),
    }
    rows = []
    printings = card.get("printings") or []
    for p in printings:
        collector = p.get("collector_number") or p.get("print_number")
        set_obj  = p.get("set") or {}
        set_code = set_obj.get("code")
        token = norm_collector(collector) or (p.get("id") or "")[:8]
        rows.append({
            "game":          GAME,
            "card_code":     f"cb-{slug}-{set_token(set_code)}-{token}",
            "series":        set_obj.get("name"),
            "set_id":        set_code,
            "number":        collector,
            "rarity":        p.get("rarity") or card.get("rarity"),
            "artist":        p.get("artist") or card.get("artist"),
            "release_order": SET_ORDER.get(set_code, DEFAULT_ORDER),
            "image_url":     None,
            "image_url_lg":  None,
            "_src_url":      p.get("image_url"),   # already freshly signed by the API
            **base,
        })
    return rows


def to_rows_all(cards):
    """Flatten all cards -> printing rows, asserting card_code uniqueness."""
    rows, seen = [], {}
    for card in cards:
        for row in printing_rows(card):
            code = row["card_code"]
            if code in seen:
                raise SystemExit(
                    f"! card_code collision: {code} (cards {seen[code]} & {card.get('slug')}). "
                    "Collector numbers expected unique per card — investigate.")
            seen[code] = card.get("slug")
            rows.append(row)
    return rows


# --------------------------------------------------------------------------- #
#  R2 image mirroring
# --------------------------------------------------------------------------- #
def r2_object_exists(key):
    try:
        s3.head_object(Bucket=R2_BUCKET, Key=key)
        return True
    except ClientError:
        return False


def transcode_to_webp(src_bytes, target_width):
    img = Image.open(io.BytesIO(src_bytes))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    w, h = img.size
    if w > target_width:
        new_h = int(h * target_width / w)
        img = img.resize((target_width, new_h), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue()


def _put_r2(key, body):
    s3.put_object(Bucket=R2_BUCKET, Key=key, Body=body, ContentType="image/webp",
                  CacheControl="public, max-age=31536000, immutable")


def ensure_in_r2(card_code, src_url):
    """Return (tile_url, lg_url); upload any missing variants. (None, None) on failure."""
    tile_key = f"{R2_PREFIX}/{card_code}.webp"
    lg_key   = f"{R2_PREFIX}/{card_code}-lg.webp"
    tile_url = f"{R2_PUBLIC_BASE}/{tile_key}"
    lg_url   = f"{R2_PUBLIC_BASE}/{lg_key}"
    need_tile = not r2_object_exists(tile_key)
    need_lg   = not r2_object_exists(lg_key)
    if not need_tile and not need_lg:
        return tile_url, lg_url
    if not src_url:
        return None, None
    try:
        r = web.get(src_url, timeout=30)
        if r.status_code != 200 or not r.content:
            return None, None
        src = r.content
        if need_tile:
            _put_r2(tile_key, transcode_to_webp(src, TILE_WIDTH))
        if need_lg:
            _put_r2(lg_key,   transcode_to_webp(src, LG_WIDTH))
        return tile_url, lg_url
    except Exception as e:
        print(f"    ! R2 upload failed for {card_code}: {e}")
        return None, None


# --------------------------------------------------------------------------- #
#  Supabase
# --------------------------------------------------------------------------- #
def cards_has_column(col):
    r = sb_session.get(f"{SUPABASE_URL}/rest/v1/cards", headers=SB,
                       params={"select": col, "limit": 1}, timeout=30)
    return r.status_code == 200


def existing_card_codes(codes):
    found = set()
    for j in range(0, len(codes), 200):
        chunk = codes[j:j + 200]
        quoted = ",".join(f'"{c}"' for c in chunk)
        r = sb_session.get(f"{SUPABASE_URL}/rest/v1/cards", headers=SB,
                           params={"select": "card_code", "game": f"eq.{GAME}",
                                   "card_code": f"in.({quoted})"}, timeout=60)
        if r.status_code == 200:
            found.update(row["card_code"] for row in r.json())
        else:
            print(f"  ! existence check failed: {r.status_code} {r.text[:200]}")
            sys.exit(1)
    return found


def upsert_cards(rows):
    if not rows:
        return
    drop = {c for c, present in INCLUDE_EXTRA.items() if not present}
    payload = [{k: v for k, v in r.items() if not k.startswith("_") and k not in drop}
               for r in rows]
    r = sb_session.post(
        f"{SUPABASE_URL}/rest/v1/cards",
        headers={**SB, "Content-Type": "application/json",
                 "Prefer": "resolution=merge-duplicates,return=minimal"},
        json=payload, timeout=60,
    )
    if r.status_code not in (200, 201, 204):
        print(f"  ! upsert failed: {r.status_code} {r.text[:400]}")
        sys.exit(1)


# --------------------------------------------------------------------------- #
#  Main
# --------------------------------------------------------------------------- #
def main():
    print("=== Pawpaw Ko Cyberpunk TCG card import (R2 mode, per-printing) ===")
    args = sys.argv[1:]
    full     = "--full" in args
    dry_run  = "--dry-run" in args
    new_only = not full
    positional = [a for a in args if not a.startswith("--")]
    only_slug = positional[0] if positional else None

    for col in EXTRA_COLS:
        INCLUDE_EXTRA[col] = cards_has_column(col)
    missing = [c for c in EXTRA_COLS if not INCLUDE_EXTRA[c]]
    if missing:
        print(f"    (! cards missing {', '.join(missing)} — apply "
              f"scripts/cyberpunk_migration.sql to capture them; skipping for now)")
    if dry_run:
        print("    (--dry-run: no R2 uploads, no DB writes)")
    elif new_only:
        print("    (incremental: skipping printings already in the database; --full re-imports all)")
    else:
        print("    (--full: re-importing every printing)")

    if only_slug:
        print(f"[1] Single-card mode (slug={only_slug})")
        slugs = [only_slug]
    else:
        print("[1] Enumerating cards from the API...")
        slugs, total = list_slugs()
        print(f"  {len(slugs)} unique cards (API total={total})")

    print("[2] Fetching each card's detail (with printings)...")
    cards = []
    for i, slug in enumerate(slugs, 1):
        try:
            card = fetch_card_detail(slug)
            npr = len(card.get("printings") or [])
            print(f"  [{i}/{len(slugs)}] {slug:46} {npr} printings", flush=True)
            cards.append(card)
        except Exception as e:
            print(f"  [{i}/{len(slugs)}] {slug}: ! failed: {e}", flush=True)
        time.sleep(0.12)

    rows = to_rows_all(cards)
    print(f"  -> {len(rows)} printing rows across {len(cards)} cards")

    if new_only and not dry_run:
        have = existing_card_codes([r["card_code"] for r in rows])
        before = len(rows)
        rows = [r for r in rows if r["card_code"] not in have]
        print(f"  incremental: {before - len(rows)} already in DB, {len(rows)} new")
        if not rows:
            print("=== Nothing new to import. ===")
            return

    if dry_run:
        print("[3] (dry-run) printing rows:")
        for r in rows:
            print("  " + json.dumps({k: v for k, v in r.items() if not k.startswith("_")},
                                     ensure_ascii=False), flush=True)
        print(f"=== Dry run complete ({len(rows)} rows, no writes). ===")
        return

    print("[3] Mirroring images to R2...")
    uploaded = reused = missing_img = 0
    for n, row in enumerate(rows, 1):
        code = row["card_code"]
        tile_key = f"{R2_PREFIX}/{code}.webp"
        lg_key   = f"{R2_PREFIX}/{code}-lg.webp"
        if r2_object_exists(tile_key) and r2_object_exists(lg_key):
            row["image_url"]    = f"{R2_PUBLIC_BASE}/{tile_key}"
            row["image_url_lg"] = f"{R2_PUBLIC_BASE}/{lg_key}"
            reused += 1
            continue
        t_url, l_url = ensure_in_r2(code, row.get("_src_url"))
        if t_url:
            row["image_url"], row["image_url_lg"] = t_url, l_url
            uploaded += 1
        else:
            missing_img += 1
            print(f"    ! no image for {code}")
        if n % 25 == 0:
            print(f"    ...{n}/{len(rows)} (up {uploaded}, reuse {reused})", flush=True)
    print(f"  R2: {uploaded} uploaded, {reused} already present, {missing_img} missing")

    print(f"[4] Upserting {len(rows)} rows...")
    for j in range(0, len(rows), 200):
        upsert_cards(rows[j:j + 200])
    print(f"=== Done. {len(rows)} printing rows upserted; R2: {uploaded} uploaded, "
          f"{reused} present; {missing_img} had no image. ===")


if __name__ == "__main__":
    main()
