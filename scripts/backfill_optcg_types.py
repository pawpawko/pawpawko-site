"""One-shot: backfill cards.types for OPTCG from the official cardlist.

The importer scraped the trait line ("Type" on the card: FILM, Mink, Music,
East Blue, ...) all along but discarded it before upserting. This walks every
series page, parses the traits, and PATCHes types onto existing rows —
grouped by identical trait sets so each group is one request. PATCH (not
upsert) because cards.name is NOT NULL: a partial upsert payload fails the
not-null check before ON CONFLICT can merge. Idempotent; safe to re-run.
Future imports carry types automatically (import_cards.py emits them since
2026-06-12).

Run:  python scripts/backfill_optcg_types.py
"""

import sys
import time

from import_cards import (
    SOURCE, SB, SUPABASE_URL,
    fetch_series_list, parse_cards, sb_session, session,
)


def main() -> None:
    print("=== Backfill cards.types (optcg traits) ===")
    series = fetch_series_list()
    print(f"  {len(series)} series")
    total = 0
    for i, (sid, label) in enumerate(series, 1):
        try:
            r = session.get(SOURCE, params={"series": sid}, timeout=120)
            r.raise_for_status()
            r.encoding = "utf-8"
            cards = [c for c in parse_cards(r.text) if c.get("types")]
            groups: dict[tuple, list[str]] = {}
            for c in cards:
                groups.setdefault(tuple(c["types"]), []).append(c["card_code"])
            n = 0
            for types, codes in groups.items():
                for j in range(0, len(codes), 200):
                    chunk = codes[j:j + 200]
                    quoted = ",".join(f'"{c}"' for c in chunk)
                    resp = sb_session.patch(
                        f"{SUPABASE_URL}/rest/v1/cards",
                        headers={**SB, "Content-Type": "application/json",
                                 "Prefer": "return=minimal"},
                        params={"game": "eq.optcg", "card_code": f"in.({quoted})"},
                        json={"types": list(types)},
                        timeout=60,
                    )
                    if resp.status_code not in (200, 204):
                        print(f"  ! patch failed: {resp.status_code} {resp.text[:300]}")
                        sys.exit(1)
                    n += len(chunk)
            total += n
            print(f"  [{i}/{len(series)}] {label[:60]} — {n} cards patched", flush=True)
        except Exception as e:
            print(f"  ! series {sid} failed: {e}", flush=True)
        time.sleep(0.3)
    print(f"=== Done. {total} card patches applied ===")


if __name__ == "__main__":
    main()
