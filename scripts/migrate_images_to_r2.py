#!/usr/bin/env python3
"""
Download card images from en.onepiece-cardgame.com, compress to WebP,
upload to Cloudflare R2, and update cards.image_url in Supabase to
point at the R2 public URL.

Idempotent: skips cards already pointing at R2_PUBLIC_BASE.

Run:
    python scripts/migrate_images_to_r2.py
    python scripts/migrate_images_to_r2.py --limit 5   # smoke test
"""
import argparse
import io
import os
import sys
import time
from pathlib import Path

import boto3
import requests
from botocore.config import Config
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

R2_PUBLIC_BASE = os.environ["R2_PUBLIC_BASE"].rstrip("/")
R2_ENDPOINT    = os.environ["R2_ENDPOINT"].rstrip("/")
R2_KEY         = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET      = os.environ["R2_SECRET_ACCESS_KEY"]
R2_BUCKET      = os.environ["R2_BUCKET"]

TILE_WIDTH = 400
LG_WIDTH   = 734        # near-source; no upscaling — capped at min(orig, LG_WIDTH)
WEBP_QUALITY = 82

SB = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
sb = requests.Session()
sb.headers.update(SB)

src = requests.Session()
src.headers.update({
    "User-Agent": "Mozilla/5.0 PawpawKoMigrator/1.0",
    "Referer": "https://en.onepiece-cardgame.com/cardlist/",
})

s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_KEY,
    aws_secret_access_key=R2_SECRET,
    config=Config(signature_version="s3v4", region_name="auto", s3={"addressing_style": "path"}),
)


def fetch_cards_to_migrate(limit=None, force=False, src_url=None):
    """Return cards needing migration, paginated across PostgREST's 1000-row cap.

    Default: cards whose image_url does NOT already point at R2.
    --force: every card (re-derives the source URL from card_code).
    """
    url = f"{SUPABASE_URL}/rest/v1/cards"
    PAGE = 1000
    out = []
    offset = 0
    while True:
        params = {
            "select": "card_code,image_url",
            "order": "card_code.asc",
            "limit": str(PAGE),
            "offset": str(offset),
        }
        if not force:
            params["image_url"] = f"not.like.{R2_PUBLIC_BASE}*"
        r = sb.get(url, params=params, timeout=60)
        r.raise_for_status()
        rows = r.json()
        if not rows:
            break
        out.extend(rows)
        offset += len(rows)
        if len(rows) < PAGE:
            break
        if limit and len(out) >= limit:
            out = out[:limit]
            break
    if force and src_url:
        for row in out:
            row["image_url"] = f"{src_url}/{row['card_code']}.png"
    return [c for c in out if c.get("image_url")]


def transcode(png_bytes: bytes, target_width: int) -> bytes:
    img = Image.open(io.BytesIO(png_bytes))
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")
    w, h = img.size
    if w > target_width:
        new_h = int(h * target_width / w)
        img = img.resize((target_width, new_h), Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue()


def upload_to_r2(key: str, webp_bytes: bytes) -> None:
    s3.put_object(
        Bucket=R2_BUCKET,
        Key=key,
        Body=webp_bytes,
        ContentType="image/webp",
        CacheControl="public, max-age=31536000, immutable",
    )


def update_supabase_urls(card_code: str, tile_url: str, lg_url: str) -> None:
    r = sb.patch(
        f"{SUPABASE_URL}/rest/v1/cards",
        params={"card_code": f"eq.{card_code}"},
        headers={**SB, "Content-Type": "application/json", "Prefer": "return=minimal"},
        json={"image_url": tile_url, "image_url_lg": lg_url},
        timeout=30,
    )
    if r.status_code not in (200, 204):
        raise RuntimeError(f"supabase patch failed: {r.status_code} {r.text[:200]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--force", action="store_true",
                    help="re-upload every card, overwriting any existing R2 object")
    args = ap.parse_args()

    print(f"=== R2 image migration (bucket={R2_BUCKET}, "
          f"tile={TILE_WIDTH}px, lg={LG_WIDTH}px"
          f"{', FORCE' if args.force else ''}) ===")
    src_base = "https://en.onepiece-cardgame.com/images/cardlist/card"
    cards = fetch_cards_to_migrate(limit=args.limit, force=args.force, src_url=src_base)
    print(f"[1] {len(cards)} card(s) need migration")
    if not cards:
        print("Nothing to do.")
        return

    ok = skipped = failed = 0
    bytes_in = bytes_out = 0
    t0 = time.time()

    for i, c in enumerate(cards, 1):
        code = c["card_code"]
        src_url = c["image_url"]
        tile_key = f"{code}.webp"
        lg_key   = f"{code}-lg.webp"
        tile_url = f"{R2_PUBLIC_BASE}/{tile_key}"
        lg_url   = f"{R2_PUBLIC_BASE}/{lg_key}"
        try:
            r = src.get(src_url, timeout=30)
            if r.status_code != 200 or not r.content:
                print(f"  [{i}/{len(cards)}] {code}: download {r.status_code} -- skip")
                skipped += 1
                continue
            png = r.content
            tile_webp = transcode(png, TILE_WIDTH)
            lg_webp   = transcode(png, LG_WIDTH)
            upload_to_r2(tile_key, tile_webp)
            upload_to_r2(lg_key, lg_webp)
            update_supabase_urls(code, tile_url, lg_url)
            bytes_in  += len(png)
            bytes_out += len(tile_webp) + len(lg_webp)
            ok += 1
            if i % 25 == 0 or i == len(cards):
                elapsed = time.time() - t0
                print(f"  [{i}/{len(cards)}] {code} ok | "
                      f"{ok} done, {skipped} skip, {failed} fail | "
                      f"{bytes_in/1e6:.1f}MB->{bytes_out/1e6:.1f}MB | "
                      f"{elapsed:.0f}s")
        except Exception as e:
            print(f"  [{i}/{len(cards)}] {code}: ERROR {e}")
            failed += 1
        time.sleep(0.05)

    print(f"=== Done. ok={ok} skipped={skipped} failed={failed} | "
          f"{bytes_in/1e6:.1f}MB downloaded -> {bytes_out/1e6:.1f}MB in R2 ===")


if __name__ == "__main__":
    main()
