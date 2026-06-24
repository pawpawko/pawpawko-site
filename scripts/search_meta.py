#!/usr/bin/env python3
"""
One Piece TCG "searcher" detection + predicate extraction.

There is NO searcher label in the card metadata — the official cardlist scrape
(see import_cards.py) stores only free-text `effect_text` — so we parse the text.
The dominant OPTCG search is a probabilistic DIG:

    [On Play] Look at N cards from the top of your deck; reveal up to 1 <FILTER>
    and add it to your hand. Then, place the rest at the bottom of your deck ...

`search_meta_for(card_code, effect_text)` returns a structured predicate (or None)
that a client can turn into a hit rate (hypergeometric over the deck):

    {
      "kind": "dig", "look": 5, "take": 1,
      "filters": [ {category, traits[], colors[], names[], exclude_names[],
                    cost{op,val|min,max}, power{op,val}} , ... ],
      "union": false,            # >1 filter entry => OR'd ("... or up to 1 ...")
      "gated": false,            # search only fires under a board condition
      "trigger": ["On Play"],
      "template": "dig_reveal_add",
      "confidence": "auto"|"review",   # "review" = couldn't fully pin (manual tail)
      "source": "auto"|"manual"
    }

Filter semantics (how a client evaluates "does deck card C qualify?"):
  - Within one entry, the identity lists names/traits/colors are OR-matched — C
    qualifies on ANY of them (e.g. "[Sanji] or {Big Mom Pirates}" -> names+traits).
  - category / cost / power are AND constraints; exclude_names removes matches
    (the searcher's "other than [X]", plus usually itself).
  - Multiple entries in `filters` are OR'd (the explicit "... or up to 1 ..." form).
`confidence:"review"` flags the manual-override tail — most commonly a color/
attribute condition the scraper dropped (the official site renders those as icons).

Used by import_cards.py (per-card on import) and analyze_searchers.py (sizing).
Manual fixes live in scripts/search_meta_overrides.json ({card_code: meta}).
"""
import json
import os
import re

COLOR_WORDS = ("red", "green", "blue", "purple", "black", "yellow")
_COLOR_RE = re.compile(r"\b(" + "|".join(COLOR_WORDS) + r")\b", re.I)

# Look at N from top ... reveal <body> and add (it|them|up to K ...) to your hand.
# Non-greedy body stops at the trailing "add ... to your hand"; the union form
# ("... or up to 1 ...") is captured whole and split later.
_DIG_RE = re.compile(
    r"look at\s+(?:up to\s+)?(\d+)\s+cards?\s+from the top of your deck\s*[;:,.]?\s*"
    # connector before "add" may be " and add", ", add", or "; add" (word order varies)
    r"reveal\s+(?P<body>.*?)\s*[,;]?\s*(?:and\s+)?add\s+(?:it|them|up to \d+[^.]*?)\s+to your hand",
    re.IGNORECASE | re.DOTALL,
)

_TRIGGER_RE = re.compile(
    r"\[(On Play|Activate: Main|Trigger|When Attacking|On Your Opponent's Attack|"
    r"On K\.O\.|End of Your Turn|Your Turn|DON!![^\]]*)\]",
    re.I,
)

_OVR_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "search_meta_overrides.json")


def _norm(t):
    return re.sub(r"\s+", " ", t or "").strip()


def is_search_candidate(effect_text):
    """Loose pre-filter: looks like a top-of-deck searcher (used for sizing the tail)."""
    t = _norm(effect_text).lower()
    return "from the top of your deck" in t and "to your hand" in t


def _parse_cost(s):
    m = re.search(r"cost of (\d+) to (\d+)", s)
    if m:
        return {"op": "range", "min": int(m[1]), "max": int(m[2])}
    m = re.search(r"cost of (\d+) or more", s)
    if m:
        return {"op": ">=", "val": int(m[1])}
    m = re.search(r"cost of (\d+) or less", s)
    if m:
        return {"op": "<=", "val": int(m[1])}
    m = re.search(r"cost of (\d+)\b", s)
    if m:
        return {"op": "==", "val": int(m[1])}
    return None


def _parse_power(s):
    m = re.search(r"(\d+) power or less", s)
    if m:
        return {"op": "<=", "val": int(m[1])}
    m = re.search(r"(\d+) power or more", s)
    if m:
        return {"op": ">=", "val": int(m[1])}
    return None


def _parse_sub(s):
    """One AND-filter from a sub-clause of the reveal body."""
    s = _norm(s)
    f = {}
    excl = re.findall(r"other than \[([^\]]+)\]", s)
    rest = re.sub(r"other than \[[^\]]+\]", " ", s)  # don't read excluded names as includes
    names = re.findall(r"\[([^\]]+)\]", rest)
    traits = re.findall(r"\{([^}]+)\}", s) + re.findall(r'type including "([^"]+)"', s)
    colors = sorted({c.lower() for c in _COLOR_RE.findall(s)})
    # Category word may appear with or without "card" ("Event", "red Event",
    # "Character card"). Mask trait {..}/name [..] first so a category word
    # inside a trait or card name doesn't get mistaken for the filter category.
    masked = re.sub(r"\{[^}]*\}|\[[^\]]*\]", " ", s)
    category = None
    for word, code in (("Character", "CHARACTER"), ("Event", "EVENT"),
                       ("Stage", "STAGE"), ("Leader", "LEADER")):
        if re.search(r"\b" + word + r"\b", masked, re.I):
            category = code
            break
    cost = _parse_cost(s)
    power = _parse_power(s)
    if category:
        f["category"] = category
    if traits:
        f["traits"] = traits
    if colors:
        f["colors"] = colors
    if names:
        f["names"] = names
    if excl:
        f["exclude_names"] = excl
    if cost:
        f["cost"] = cost
    if power:
        f["power"] = power
    return f


def extract_search_meta(effect_text, card_code=None):
    """Parse a dig-searcher's predicate from effect_text, or None if not recognized."""
    if not effect_text:
        return None
    eff = _norm(effect_text)
    m = _DIG_RE.search(eff)
    if not m:
        return None
    look = int(m[1])
    body = m["body"]
    take_m = re.search(r"up to (\d+)", body)
    take = int(take_m[1]) if take_m else 1
    core = re.sub(r"^\s*up to \d+\s+", "", body)
    subs = re.split(r"\s+or up to \d+\s+", core)
    filters = [_parse_sub(s) for s in subs]

    # "review" = parser couldn't fully pin the predicate -> manual-override tail.
    review = any(not f for f in filters)
    # The scraper drops inline color/attribute ICONS, so an "attribute" condition
    # (always icon-rendered) or a tell-tale double space in the ORIGINAL text
    # (where an icon was removed; _norm has since collapsed it) = incomplete.
    if re.search(r"\battribute\b", body, re.I):
        review = True
    if re.search(r"\S {2,}\S", effect_text):
        review = True

    gated = bool(re.search(r"\bif (your|you)\b[^.]*?look at \d+ cards? from the top", eff, re.I))
    triggers = [t.strip() for t in _TRIGGER_RE.findall(eff)]

    return {
        "kind": "dig",
        "look": look,
        "take": take,
        "filters": filters,
        "union": len(filters) > 1,
        "gated": gated,
        "trigger": triggers or None,
        "template": "dig_reveal_add",
        "confidence": "review" if review else "auto",
        "source": "auto",
    }


_overrides_cache = None


def load_overrides():
    """{card_code: search_meta} hand-corrections; missing/invalid file -> {}."""
    global _overrides_cache
    if _overrides_cache is None:
        try:
            with open(_OVR_PATH, encoding="utf-8") as fh:
                _overrides_cache = json.load(fh) or {}
        except Exception:
            _overrides_cache = {}
    return _overrides_cache


def search_meta_for(card_code, effect_text, overrides=None):
    """Override-aware entry point. Manual override wins over the auto parse."""
    ov = overrides if overrides is not None else load_overrides()
    if card_code and card_code in ov:
        meta = dict(ov[card_code]) if ov[card_code] else None
        if meta:
            meta.setdefault("source", "manual")
        return meta
    return extract_search_meta(effect_text, card_code)


def classify(effect_text, card_code=None):
    """For sizing: -> ('auto'|'review'|'unparsed'|'none', meta_or_None)."""
    meta = search_meta_for(card_code, effect_text)
    if meta:
        return (meta.get("confidence", "auto") if meta.get("source") != "manual" else "manual", meta)
    if is_search_candidate(effect_text):
        return ("unparsed", None)
    return ("none", None)


if __name__ == "__main__":
    # Ad-hoc: pipe an effect string in, get the parsed meta out.
    import sys
    txt = sys.stdin.read() if not sys.stdin.isatty() else " ".join(sys.argv[1:])
    print(json.dumps(extract_search_meta(txt), indent=2, ensure_ascii=False))
