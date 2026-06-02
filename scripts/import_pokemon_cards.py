#!/usr/bin/env python3
"""
Import Pokémon TCG card data into Supabase.

Mirrors scripts/import_cards.py (the OPTCG importer):
    - Pulls card metadata from pokemontcg.io's v2 REST API (free tier).
    - Downloads each card image, transcodes to WebP, uploads to R2.
    - Upserts rows into public.cards with game='pokemon'.

R2 keys are namespaced under `pokemon/` so OPTCG images at the bucket
root are untouched. Existing R2 objects are not re-uploaded.

Set POKEMONTCG_API_KEY in scripts/.env (free key from
https://dev.pokemontcg.io/). The unauthenticated rate limit is too tight
for a 17k-card import.

Run from project root:
    python scripts/import_pokemon_cards.py

Or to import a single set only (good for spot checks):
    python scripts/import_pokemon_cards.py sv1
"""
import io
import os
import sys
import time
from datetime import datetime
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

POKEMONTCG_KEY = os.environ.get("POKEMONTCG_API_KEY", "").strip()
POKEMONTCG_BASE = "https://api.pokemontcg.io/v2"

R2_PUBLIC_BASE = os.environ["R2_PUBLIC_BASE"].rstrip("/")
R2_ENDPOINT    = os.environ["R2_ENDPOINT"].rstrip("/")
R2_KEY         = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET      = os.environ["R2_SECRET_ACCESS_KEY"]
R2_BUCKET      = os.environ["R2_BUCKET"]

# Namespace Pokémon images under pokemon/ so the OPTCG bucket root
# (used by the OPTCG importer) stays exactly as it was.
R2_PREFIX    = "pokemon"
TILE_WIDTH   = 400
LG_WIDTH     = 734
WEBP_QUALITY = 82
PAGE_SIZE    = 250   # pokemontcg.io max

api_session = requests.Session()
api_session.headers.update({"User-Agent": "PawpawKoImporter/1.0 (pokemon)"})
if POKEMONTCG_KEY:
    api_session.headers["X-Api-Key"] = POKEMONTCG_KEY

img_session = requests.Session()
img_session.headers.update({"User-Agent": "PawpawKoImporter/1.0 (pokemon)"})

s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_KEY,
    aws_secret_access_key=R2_SECRET,
    config=Config(signature_version="s3v4", region_name="auto", s3={"addressing_style": "path"}),
)

sb_session = requests.Session()
sb_session.headers.update({"User-Agent": "pawpawko-importer/1.0 (server)"})
SB_HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
}


def r2_object_exists(key: str) -> bool:
    try:
        s3.head_object(Bucket=R2_BUCKET, Key=key)
        return True
    except ClientError:
        return False


def transcode_to_webp(src_bytes: bytes, target_width: int) -> bytes:
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


def _put_r2(key: str, body: bytes) -> None:
    s3.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=body,
        ContentType="image/webp",
        CacheControl="public, max-age=31536000, immutable",
    )


def ensure_in_r2(card_code: str, src_url: str):
    """Return (tile_url, lg_url) for this card. Upload missing variants. (None, None) on failure."""
    tile_key = f"{R2_PREFIX}/{card_code}.webp"
    lg_key   = f"{R2_PREFIX}/{card_code}-lg.webp"
    tile_url = f"{R2_PUBLIC_BASE}/{tile_key}"
    lg_url   = f"{R2_PUBLIC_BASE}/{lg_key}"
    need_tile = not r2_object_exists(tile_key)
    need_lg   = not r2_object_exists(lg_key)
    if not need_tile and not need_lg:
        return tile_url, lg_url
    try:
        r = img_session.get(src_url, timeout=30)
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


def fetch_sets() -> list[dict]:
    """All Pokémon TCG sets, sorted oldest → newest by release date."""
    r = api_session.get(f"{POKEMONTCG_BASE}/sets", params={"pageSize": 250}, timeout=60)
    r.raise_for_status()
    data = r.json().get("data", [])
    # releaseDate is "YYYY/MM/DD"; sort lexicographically works on that format.
    return sorted(data, key=lambda s: s.get("releaseDate") or "")


def fetch_cards_for_set(set_id: str) -> list[dict]:
    """Paginated card fetch for one set."""
    out: list[dict] = []
    page = 1
    while True:
        r = api_session.get(
            f"{POKEMONTCG_BASE}/cards",
            params={"q": f"set.id:{set_id}", "page": page, "pageSize": PAGE_SIZE},
            timeout=60,
        )
        r.raise_for_status()
        body = r.json()
        batch = body.get("data", [])
        out.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        page += 1
        time.sleep(0.1)
    return out


def to_db_row(card: dict, release_order: int) -> dict:
    """Map a pokemontcg.io card payload to our public.cards row shape."""
    set_obj = card.get("set") or {}
    images  = card.get("images") or {}
    img_lg  = images.get("large") or images.get("small")  # source for both transcodes

    # Weakness / resistance: pokemontcg.io returns arrays of {type, value};
    # flatten to a single human-readable string for the simple display layer.
    def join_pairs(pairs):
        if not pairs:
            return None
        return ", ".join(f"{p.get('type','')} {p.get('value','')}".strip() for p in pairs)

    return {
        "game":         "pokemon",
        "card_code":    card.get("id"),
        "name":         card.get("name"),
        "series":       set_obj.get("name"),
        "set_id":       set_obj.get("id"),
        "number":       card.get("number"),
        "supertype":    card.get("supertype"),
        "subtypes":     card.get("subtypes") or None,
        "types":        card.get("types") or None,
        "hp":           int(card["hp"]) if str(card.get("hp") or "").isdigit() else None,
        "retreat_cost": len(card.get("retreatCost") or []) or None,
        "weakness":     join_pairs(card.get("weaknesses")),
        "resistance":   join_pairs(card.get("resistances")),
        "evolves_from": card.get("evolvesFrom"),
        "attacks":      card.get("attacks") or None,
        "rarity":       card.get("rarity"),
        "image_url":    None,         # filled in after R2 upload
        "image_url_lg": None,
        "release_order": release_order,
        # OPTCG-only columns left null
        "color": None, "type": None, "cost": None, "power": None,
        "counter": None, "attribute": None, "trigger_text": None,
        "effect_text": None,
        "_src_url": img_lg,
    }


def existing_card_codes(codes: list[str]) -> set[str]:
    """Return the subset of `codes` already present in cards for game='pokemon'."""
    found: set[str] = set()
    for j in range(0, len(codes), 200):
        chunk = codes[j:j+200]
        quoted = ",".join(f'"{c}"' for c in chunk)
        r = sb_session.get(
            f"{SUPABASE_URL}/rest/v1/cards",
            headers=SB_HEADERS,
            params={"select": "card_code", "game": "eq.pokemon", "card_code": f"in.({quoted})"},
            timeout=60,
        )
        if r.status_code == 200:
            found.update(row["card_code"] for row in r.json())
        else:
            print(f"  ! existence check failed: {r.status_code} {r.text[:200]}")
            sys.exit(1)
    return found


def upsert_cards(rows: list[dict]) -> None:
    if not rows:
        return
    payload = [{k: v for k, v in r.items() if not k.startswith("_")} for r in rows]
    r = sb_session.post(
        f"{SUPABASE_URL}/rest/v1/cards",
        headers={
            **SB_HEADERS,
            "Content-Type": "application/json",
            # Composite PK (game, card_code) — supabase-py / PostgREST infer
            # the on-conflict target from the table's primary key.
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json=payload,
        timeout=60,
    )
    if r.status_code not in (200, 201, 204):
        print(f"  ! upsert failed: {r.status_code} {r.text[:400]}")
        sys.exit(1)


def main() -> None:
    print("=== Pawpaw Ko Pokémon card import (R2 mode) ===")
    if not POKEMONTCG_KEY:
        print("  ! POKEMONTCG_API_KEY is empty — proceeding with anon rate limits (slow). "
              "Grab a free key at https://dev.pokemontcg.io/ and add it to scripts/.env.")

    args = sys.argv[1:]
    # Incremental by default: only process cards not already in the DB.
    # Pass --full to re-download/re-upsert everything (e.g. errata refresh).
    full = "--full" in args
    new_only = not full
    positional = [a for a in args if not a.startswith("--")]
    only_set = positional[0] if positional else None
    if new_only:
        print("    (incremental: skipping cards already in the database; pass --full to re-import all)")
    else:
        print("    (--full: re-importing every card)")

    print("[1] Fetching set list...")
    sets = fetch_sets()
    if only_set:
        sets = [s for s in sets if s.get("id") == only_set]
        if not sets:
            print(f"  ! No set with id={only_set}")
            sys.exit(1)
    print(f"  Found {len(sets)} sets to import")

    # release_order increments per set in chronological order so the newest
    # set ends up with the highest integer (matches the OPTCG convention).
    total = 0
    missing_img = 0

    print("[2] Importing each set...")
    for i, s in enumerate(sets, 1):
        set_id    = s.get("id")
        set_name  = s.get("name") or set_id
        rel_date  = s.get("releaseDate") or "????/??/??"
        rel_order = i  # 1 = oldest, len(sets) = newest. Single-set mode → 1.

        print(f"  [{i}/{len(sets)}] {set_name}  (id={set_id}, released {rel_date}, order={rel_order})")
        try:
            raw_cards = fetch_cards_for_set(set_id)
            print(f"    fetched {len(raw_cards)} cards", flush=True)

            rows = [to_db_row(c, rel_order) for c in raw_cards]

            if new_only:
                have = existing_card_codes([r["card_code"] for r in rows])
                rows = [r for r in rows if r["card_code"] not in have]
                if not rows:
                    print("    no new cards, skipping set", flush=True)
                    continue
                print(f"    {len(rows)} new cards to import", flush=True)

            uploaded = reused = 0
            for row in rows:
                src_url = row.get("_src_url")
                code    = row["card_code"]
                if not src_url or not code:
                    missing_img += 1
                    row["image_url"]    = None
                    row["image_url_lg"] = None
                    continue
                tile_key = f"{R2_PREFIX}/{code}.webp"
                lg_key   = f"{R2_PREFIX}/{code}-lg.webp"
                if r2_object_exists(tile_key) and r2_object_exists(lg_key):
                    row["image_url"]    = f"{R2_PUBLIC_BASE}/{tile_key}"
                    row["image_url_lg"] = f"{R2_PUBLIC_BASE}/{lg_key}"
                    reused += 1
                else:
                    tile_url, lg_url = ensure_in_r2(code, src_url)
                    if tile_url:
                        row["image_url"]    = tile_url
                        row["image_url_lg"] = lg_url
                        uploaded += 1
                    else:
                        missing_img += 1
            print(f"    R2: {uploaded} uploaded, {reused} already present", flush=True)

            for j in range(0, len(rows), 200):
                upsert_cards(rows[j:j+200])
            total += len(rows)
            print(f"    upserted {len(rows)} rows", flush=True)
        except Exception as e:
            print(f"    ! set {set_id} failed: {e}", flush=True)
        time.sleep(0.2)

    print(f"=== Done. {total} rows upserted; {missing_img} cards had no image URL ===")


if __name__ == "__main__":
    main()
