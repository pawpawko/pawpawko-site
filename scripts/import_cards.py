#!/usr/bin/env python3
"""
Import One Piece TCG card data into Supabase.

Card images are downloaded from en.onepiece-cardgame.com, transcoded
to WebP, uploaded to Cloudflare R2, and image_url is set to the R2
public URL. (Hotlinking the official CDN does not work in browsers
because their Cross-Origin-Resource-Policy is same-site.)

Already-uploaded objects in R2 are not re-downloaded.

Run from project root:
    python scripts/import_cards.py

Or to import a single series only (for testing):
    python scripts/import_cards.py 569115
"""
import io
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin

import boto3
import requests
from botocore.config import Config
from botocore.exceptions import ClientError
from bs4 import BeautifulSoup
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
SOURCE       = "https://en.onepiece-cardgame.com/cardlist/"

R2_PUBLIC_BASE = os.environ["R2_PUBLIC_BASE"].rstrip("/")
R2_ENDPOINT    = os.environ["R2_ENDPOINT"].rstrip("/")
R2_KEY         = os.environ["R2_ACCESS_KEY_ID"]
R2_SECRET      = os.environ["R2_SECRET_ACCESS_KEY"]
R2_BUCKET      = os.environ["R2_BUCKET"]

TILE_WIDTH   = 400
LG_WIDTH     = 734
WEBP_QUALITY = 82

session = requests.Session()
session.headers.update({"User-Agent": "Mozilla/5.0 PawpawKoImporter/1.0"})

img_session = requests.Session()
img_session.headers.update({
    "User-Agent": "Mozilla/5.0 PawpawKoImporter/1.0",
    "Referer": SOURCE,
})

s3 = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_KEY,
    aws_secret_access_key=R2_SECRET,
    config=Config(signature_version="s3v4", region_name="auto", s3={"addressing_style": "path"}),
)


def r2_object_exists(key: str) -> bool:
    try:
        s3.head_object(Bucket=R2_BUCKET, Key=key)
        return True
    except ClientError:
        return False


def transcode_to_webp(png_bytes: bytes, target_width: int) -> bytes:
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
    tile_key = f"{card_code}.webp"
    lg_key   = f"{card_code}-lg.webp"
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
        png = r.content
        if need_tile:
            _put_r2(tile_key, transcode_to_webp(png, TILE_WIDTH))
        if need_lg:
            _put_r2(lg_key,   transcode_to_webp(png, LG_WIDTH))
        return tile_url, lg_url
    except Exception as e:
        print(f"    ! R2 upload failed for {card_code}: {e}")
        return None, None

sb_session = requests.Session()
sb_session.headers.update({"User-Agent": "pawpawko-importer/1.0 (server)"})

SB = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
}

RELEASE_ORDER = {
    'OP16':31,'ST30':31,
    'OP15':30,'OP14':29,'EB04':28,'PRB02':28,'ST29':28,
    'OP13':27,'ST28':27,'ST27':26,'ST26':25,
    'EB03':24,'OP12':24,'ST25':24,'ST24':23,'ST23':22,'OP11':21,
    'EB02':20,'ST22':20,'ST21':19,'OP10':18,'ST20':18,'ST19':17,
    'PRB01':16,'ST18':16,'OP09':15,'ST17':15,'ST16':14,
    'EB01':13,'ST15':13,'OP08':12,'ST14':12,'ST13':11,
    'OP07':10,'ST12':10,'ST11':9,'OP06':8,'ST10':7,
    'OP05':6,'ST09':6,'OP04':5,'ST08':5,'ST07':5,'ST06':4,
    'OP03':3,'ST05':3,'OP02':2,'ST04':2,
    'OP01':1,'ST03':1,'ST02':1,'ST01':1,
}

# A numbered set in a known family, e.g. OP16-001 -> "OP16", PRB02-001 -> "PRB02".
# Promo / other-product codes (e.g. "P-001") don't match and keep release_order 0.
_SET_PREFIX_RE = re.compile(r"^(OP|ST|EB|PRB)\d{2,}$")

# Set prefixes seen this run that weren't in RELEASE_ORDER (reported at the end).
_UNKNOWN_SET_PREFIXES: set[str] = set()


def release_order_for(card_code: str) -> int:
    for prefix, val in RELEASE_ORDER.items():
        if card_code.startswith(prefix):
            return val
    # A freshly released set won't be in the hard-coded map yet. New sets are
    # always the newest, so assign the newest order rather than 0 (which would
    # silently sort them as the oldest). Tracked + reported so the exact
    # cross-family wave ordering can be codified in RELEASE_ORDER afterward.
    prefix = card_code.split("-")[0]
    if _SET_PREFIX_RE.match(prefix):
        _UNKNOWN_SET_PREFIXES.add(prefix)
        return max(RELEASE_ORDER.values()) + 1
    return 0  # promos / non-set products


def fetch_series_list() -> list[tuple[str, str]]:
    r = session.get(SOURCE, timeout=30)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    sel = soup.find("select", {"name": "series"}) or soup.find("select", id="series")
    options = sel.find_all("option") if sel else soup.select("select option")
    out: list[tuple[str, str]] = []
    seen = set()
    for opt in options:
        v = (opt.get("value") or "").strip()
        if v.isdigit() and v not in seen:
            seen.add(v)
            label = re.sub(r"\s+", " ", opt.get_text(" ", strip=True))
            out.append((v, label))
    return out


def first_int(text: str | None):
    if not text:
        return None
    m = re.search(r"-?\d+", text)
    return int(m.group()) if m else None


def parse_cards(html: str) -> list[dict]:
    soup = BeautifulSoup(html, "html.parser")
    cards: list[dict] = []
    for dl in soup.select("dl.modalCol"):
        code = (dl.get("id") or "").strip()
        if not code:
            continue

        info_spans = [s.get_text(strip=True) for s in dl.select(".infoCol span")]
        rarity = info_spans[1] if len(info_spans) > 1 else None
        ctype  = info_spans[2] if len(info_spans) > 2 else None

        name_el = dl.select_one(".cardName")
        name = name_el.get_text(strip=True) if name_el else None

        cost_el = dl.select_one(".cost")
        cost = first_int(cost_el.get_text() if cost_el else None)

        power_el = dl.select_one(".power")
        power = first_int(power_el.get_text() if power_el else None)

        counter_el = dl.select_one(".counter")
        counter = first_int(counter_el.get_text() if counter_el else None)

        attribute = None
        attr_img = dl.select_one(".attribute img")
        if attr_img and attr_img.has_attr("alt"):
            attribute = attr_img["alt"].strip() or None

        color = None
        color_el = dl.select_one(".color")
        if color_el:
            color = re.sub(r"^Color", "", color_el.get_text(" ", strip=True)).strip() or None

        feature = None
        feature_el = dl.select_one(".feature")
        if feature_el:
            feature = re.sub(r"^Type", "", feature_el.get_text(" ", strip=True)).strip() or None

        effect = None
        text_el = dl.select_one(".text")
        if text_el:
            for br in text_el.find_all("br"):
                br.replace_with("\n")
            txt = text_el.get_text("\n", strip=True)
            txt = re.sub(r"^Effect\s*", "", txt).strip()
            effect = txt or None

        trigger_text = None
        if effect and "[Trigger]" in effect:
            m = re.search(r"\[Trigger\]\s*(.*)", effect, re.DOTALL)
            if m:
                trigger_text = m.group(1).strip()

        getinfo_el = dl.select_one(".getInfo")
        series_label = None
        if getinfo_el:
            series_label = re.sub(r"^Card Set\(s\)", "", getinfo_el.get_text(" ", strip=True)).strip() or None

        # Hotlink straight to the official site's CDN — no upload, no storage cost.
        img = dl.select_one("img.lazy") or dl.select_one("img")
        image_url = None
        if img:
            ds = img.get("data-src") or img.get("src")
            if ds and "dummy.gif" not in ds:
                ds = ds.split("?")[0]
                image_url = urljoin(SOURCE, ds)

        cards.append({
            "card_code": code,
            "name": name,
            "series": series_label,
            "color": color,
            "type": ctype,
            "cost": cost,
            "power": power,
            "counter": counter,
            "attribute": attribute,
            "trigger_text": trigger_text,
            "rarity": rarity,
            "effect_text": effect,
            "image_url": image_url,
            "image_url_lg": None,
            "_src_url": image_url,
            "release_order": release_order_for(code),
            # Card traits ("Type" line on the card: FILM, Mink, Music, ...) go
            # into the shared types text[] column; multi-trait cards are
            # slash-separated on the source ("FILM/Music").
            "types": [t.strip() for t in feature.split("/") if t.strip()] if feature else None,
        })
    return cards


def existing_card_codes(codes: list[str]) -> set[str]:
    """Return the subset of `codes` already present in the cards table."""
    found: set[str] = set()
    for j in range(0, len(codes), 200):
        chunk = codes[j:j+200]
        quoted = ",".join(f'"{c}"' for c in chunk)
        r = sb_session.get(
            f"{SUPABASE_URL}/rest/v1/cards",
            headers=SB,
            params={"select": "card_code", "card_code": f"in.({quoted})"},
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
    payload = [{k: v for k, v in r.items() if k not in ("feature", "_src_url")} for r in rows]
    r = sb_session.post(
        f"{SUPABASE_URL}/rest/v1/cards",
        headers={
            **SB,
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
        json=payload,
        timeout=60,
    )
    if r.status_code not in (200, 201, 204):
        print(f"  ! upsert failed: {r.status_code} {r.text[:400]}")
        sys.exit(1)


def main() -> None:
    print("=== Pawpaw Ko card import (R2 mode) ===")

    args = sys.argv[1:]
    # Incremental by default: only process cards not already in the DB.
    # Pass --full to re-download/re-upsert everything (e.g. errata refresh).
    # --new-only is still accepted as an explicit no-op alias.
    full = "--full" in args
    new_only = not full
    positional = [a for a in args if not a.startswith("--")]
    only = positional[0] if positional else None
    if new_only:
        print("    (incremental: skipping cards already in the database; pass --full to re-import all)")
    else:
        print("    (--full: re-importing every card)")
    if only:
        print(f"[1] Single-series mode (series={only})")
        series = [(only, f"series {only}")]
    else:
        print("[1] Fetching series list...")
        series = fetch_series_list()
        print(f"  Found {len(series)} series")

    total = 0
    missing_img = 0

    print("[2] Importing each series...")
    for i, (sid, label) in enumerate(series, 1):
        print(f"  [{i}/{len(series)}] {label[:80]}  (id={sid})")
        try:
            r = session.get(SOURCE, params={"series": sid}, timeout=120)
            r.raise_for_status()
            r.encoding = "utf-8"
            cards = parse_cards(r.text)
            print(f"    parsed {len(cards)} card entries", flush=True)

            if new_only:
                have = existing_card_codes([c["card_code"] for c in cards])
                cards = [c for c in cards if c["card_code"] not in have]
                if not cards:
                    print("    no new cards, skipping series", flush=True)
                    continue
                print(f"    {len(cards)} new cards to import", flush=True)

            uploaded = reused = 0
            for c in cards:
                src_url = c.get("_src_url")
                if not src_url:
                    missing_img += 1
                    c["image_url"] = None
                    continue
                tile_key = f"{c['card_code']}.webp"
                lg_key   = f"{c['card_code']}-lg.webp"
                if r2_object_exists(tile_key) and r2_object_exists(lg_key):
                    c["image_url"]    = f"{R2_PUBLIC_BASE}/{tile_key}"
                    c["image_url_lg"] = f"{R2_PUBLIC_BASE}/{lg_key}"
                    reused += 1
                else:
                    tile_url, lg_url = ensure_in_r2(c["card_code"], src_url)
                    if tile_url:
                        c["image_url"]    = tile_url
                        c["image_url_lg"] = lg_url
                        uploaded += 1
                    else:
                        c["image_url"]    = None
                        c["image_url_lg"] = None
                        missing_img += 1
            print(f"    R2: {uploaded} uploaded, {reused} already present", flush=True)

            for j in range(0, len(cards), 200):
                upsert_cards(cards[j:j+200])
            total += len(cards)
            print(f"    upserted {len(cards)} rows", flush=True)
        except Exception as e:
            print(f"    ! series {sid} failed: {e}", flush=True)
        time.sleep(0.3)

    print(f"=== Done. {total} rows upserted; {missing_img} cards had no image URL ===")

    if _UNKNOWN_SET_PREFIXES:
        assigned = max(RELEASE_ORDER.values()) + 1
        print(
            "  ! NEW SET(S) not in RELEASE_ORDER: "
            + ", ".join(sorted(_UNKNOWN_SET_PREFIXES))
            + f" — auto-assigned release_order={assigned} (newest). "
            "Add them to the RELEASE_ORDER dict in scripts/import_cards.py to "
            "lock their exact cross-family ordering, then re-run that series "
            "with --full to re-upsert."
        )


if __name__ == "__main__":
    main()
