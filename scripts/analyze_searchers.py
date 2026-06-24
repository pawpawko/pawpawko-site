#!/usr/bin/env python3
"""
One-shot: classify the One Piece searcher pool from prod and size the
manual-override tail before committing to the stats feature. Read-only default.

    python scripts/analyze_searchers.py             # report only (dry run)
    python scripts/analyze_searchers.py --dump review.txt   # + dump review/tail list
    python scripts/analyze_searchers.py --write     # backfill cards.search_meta in prod
                                                     # (needs scripts/.env service key
                                                     #  + migration applied first)

Read path uses the public anon key (cards is world-readable); --write needs the
service-role key from scripts/.env. Parser lives in search_meta.py.
"""
import os
import sys
from collections import Counter
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
from search_meta import classify, load_overrides, search_meta_for  # noqa: E402

load_dotenv(ROOT / "scripts" / ".env")

URL = (os.environ.get("SUPABASE_URL") or "https://cligjmfhxvazjarbvexp.supabase.co").rstrip("/")
ANON = os.environ.get("SUPABASE_ANON_KEY", "sb_publishable_MbXa-DQ33D9VSMHhHho0Xg_kZ65QHtt")
SERVICE = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

# Only One Piece sets use this grammar; skip the rest of the (shared) cards table.
OP_PREFIXES = ("OP", "ST", "EB", "PRB", "P-")


def is_op(code):
    return code.split("-")[0].rstrip("0123456789") in ("OP", "ST", "EB", "PRB") or code.startswith("P-")


def fetch_all():
    headers = {"apikey": ANON, "Authorization": f"Bearer {ANON}"}
    rows, step, off = [], 1000, 0
    while True:
        r = requests.get(
            f"{URL}/rest/v1/cards", headers=headers,
            params={"select": "card_code,name,type,effect_text", "order": "card_code",
                    "limit": step, "offset": off},
            timeout=90,
        )
        r.raise_for_status()
        batch = r.json()
        rows += batch
        if len(batch) < step:
            return rows
        off += step


def feature_tags(meta):
    tags = set()
    if meta.get("union"):
        tags.add("union")
    if meta.get("gated"):
        tags.add("gated")
    for f in meta.get("filters", []):
        if f.get("traits"):
            tags.add("trait")
        if f.get("names"):
            tags.add("name")
        if f.get("exclude_names"):
            tags.add("name-exclude")
        if f.get("category"):
            tags.add("category")
        if f.get("colors"):
            tags.add("color")
        if f.get("cost"):
            tags.add("cost")
        if f.get("power"):
            tags.add("power")
        if not f:
            tags.add("EMPTY-filter")
    return tags


def main():
    args = sys.argv[1:]
    do_write = "--write" in args
    dump_path = None
    if "--dump" in args:
        i = args.index("--dump")
        dump_path = args[i + 1] if i + 1 < len(args) else "searcher_review.txt"

    print(f"Fetching cards from {URL} ...")
    rows = [c for c in fetch_all() if is_op(c["card_code"])]
    print(f"  {len(rows)} One Piece cards (of the shared cards table)\n")

    buckets = Counter()
    look_dist = Counter()
    feat = Counter()
    review_list, tail_list = [], []
    bases_searcher = set()
    to_write = []

    for c in rows:
        code, eff = c["card_code"], c.get("effect_text")
        bucket, meta = classify(eff, code)
        buckets[bucket] += 1
        if meta:
            base = code.split("_")[0]
            bases_searcher.add(base)
            look_dist[meta.get("look")] += 1
            for t in feature_tags(meta):
                feat[t] += 1
            to_write.append((code, meta))
            if bucket == "review":
                review_list.append(c)
        elif bucket == "unparsed":
            tail_list.append(c)

    total = len(rows)
    searchers = buckets["auto"] + buckets["review"] + buckets["manual"]
    print("== CLASSIFICATION (rows incl. parallels) ==")
    print(f"  not a searcher        : {buckets['none']:>5}")
    print(f"  auto (clean parse)    : {buckets['auto']:>5}")
    print(f"  review (manual tail)  : {buckets['review']:>5}")
    print(f"  manual override       : {buckets['manual']:>5}")
    print(f"  unparsed candidates   : {buckets['unparsed']:>5}  (look searcher-ish, clause didn't match)")
    print(f"  ----")
    print(f"  searchers total       : {searchers:>5}  ({len(bases_searcher)} unique base cards, parallels merged)")
    print(f"  manual-tail to curate : {buckets['review'] + buckets['unparsed']:>5}  (review + unparsed)\n")

    print("== DIG DEPTH (look at N) ==")
    for n in sorted(look_dist, key=lambda x: (x is None, x)):
        print(f"  look {n}: {look_dist[n]}")
    print()

    print("== FILTER FEATURES (rows can have several) ==")
    for t, n in feat.most_common():
        print(f"  {t:<14}: {n}")
    print()

    if dump_path:
        with open(dump_path, "w", encoding="utf-8") as fh:
            fh.write("=== REVIEW (parsed but low-confidence — verify / override) ===\n")
            for c in review_list:
                fh.write(f"{c['card_code']}\t{c.get('name')}\n    {(c.get('effect_text') or '').strip()}\n\n")
            fh.write("\n=== UNPARSED CANDIDATES (searcher-ish, no template match) ===\n")
            for c in tail_list:
                fh.write(f"{c['card_code']}\t{c.get('name')}\n    {(c.get('effect_text') or '').strip()}\n\n")
        print(f"Wrote {len(review_list)} review + {len(tail_list)} unparsed to {dump_path}\n")

    if do_write:
        if not SERVICE:
            sys.exit("--write needs SUPABASE_SERVICE_ROLE_KEY in scripts/.env")
        print(f"Writing search_meta for {len(to_write)} searchers ...")
        headers = {"apikey": SERVICE, "Authorization": f"Bearer {SERVICE}",
                   "Content-Type": "application/json",
                   "Prefer": "resolution=merge-duplicates,return=minimal"}
        payload = [{"card_code": code, "search_meta": meta} for code, meta in to_write]
        for j in range(0, len(payload), 200):
            r = requests.post(f"{URL}/rest/v1/cards", headers=headers, json=payload[j:j + 200], timeout=90)
            if r.status_code not in (200, 201, 204):
                sys.exit(f"  ! write failed {r.status_code}: {r.text[:300]}")
        print("  done. (non-searchers left as null; re-run after editing overrides to refresh)")
    else:
        print("Dry run — no writes. Use --write to backfill cards.search_meta (after applying the migration).")


if __name__ == "__main__":
    main()
