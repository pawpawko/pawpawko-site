# Cyberpunk TCG — Rules Reference

> Scraped 2026-06-26 from <https://cyberpunktcg.com/gameplay-guide> (the official
> "How to Play"). Captured for the future Pawpawko deck-builder. The
> deck-construction constraints in machine-readable form live in
> [`cyberpunk_deck_rules.json`](./cyberpunk_deck_rules.json). If a card's text
> conflicts with this guide, the card text wins.
>
> Game by WeirdCo × CD PROJEKT RED. Design/rules: Richard Zapp, Chris Solis,
> David McDarby, Casey Campbell, Madeline Anthony. Status: Kickstarter / pre-retail.

## Overview

You're the leader of a crew competing against your Rival to become a Night City
Legend. To play you need a set of six dice (d4, d6, d8, d10, d12, d20) and a deck
of Cyberpunk TCG cards. Send Units into the field, equip them with Gear, and
deploy Programs to control the majority of Night City's **Gigs** (dice).

## Win / Lose conditions

- **Win:** If a player has **at least 7 Gig dice** in their Gig area at the
  **start of their turn**, they win.
- **Overtime:** Begins after the last player's **7th turn**. Sudden death — as
  soon as a player has a *majority* of Gig dice, they win instantly.
- **Deck out (lose):** If you must draw a card with an empty deck, your Rival
  immediately wins.

## Playmat areas

- **Fixer area** — all your Gig dice start here. At the start of your turn, after
  drawing, choose one die (any except the d20, which is always last), roll it,
  and move it to your Gig area.
- **Gig area** — Gigs you control (incl. ones stolen from your Rival). 7 at the
  start of your turn = win. **Street Cred** = the sum of your Gig dice face values.
- **Field** — where you play Units; they attack rival Units or the rival Gig area.
- **Eddies area** — currency (€$). Starts empty; sell cards from hand to make
  Eddies (1 €$ each, max once per turn). Spend Eddies to pay card costs.
- **Legends area** — your **3 Legends**, face-down in random order. Once per turn
  you may **Call a Legend** (spend 1 €$) to flip one face-up at random. Legends
  (face-up or down) may also each be spent as 1 €$.
- **Deck** and **Trash** — draw from the top of the deck; discarded/defeated/
  trashed cards go face-up to the trash.

## Card types (label, top-right corner)

- **Legend** — deck centerpieces providing unique effects. 3 per deck, start
  face-down in random order. Call once per turn. Can be spent as 1 €$ each.
- **Unit** — crew members that fight rival Units and steal Gigs. Pay cost, place
  ready in the field. Can't attack the turn they're played (enter with **Lag**).
- **Program** — instantaneous effect: pay cost, resolve, move to trash.
- **Gear** — equip to a friendly Unit or Legend for ongoing effects; follows the
  card it's attached to when that card moves.

## Card markup

- **Timing triggers** (convex highlight) — *when* an effect happens, e.g.
  "when you play this card", "when this Unit attacks", "when this Unit is defeated",
  "when you flip this Legend face-up via Call a Legend". In our data these appear
  in `effect_text` as `{Play}`, `{Call}`, `{Attack}`, etc.
- **Keywords** (concave highlight) — standardized effects, e.g.
  **Go Solo** (pay this Legend's cost to play it as a ready Unit that can attack
  this turn; removed from game if it leaves the field), **Quick** (activate as a
  reaction when a rival Unit attacks), **Blocker** (spend to redirect an attack
  to this Unit).

## Turn structure

**Setup:** shuffle deck + randomize 3 Legends face-down. Both players roll d20
(reroll ties); higher chooses who goes first. The first player spends their 2
leftmost Legends and doesn't ready them on turn 1. Draw 6 (one mulligan allowed).

**Start phase (in order):** Ready all spent cards → Draw 1 → Gain a Gig (take a
die from the fixer area, roll, add to Gig area; d20 always last).

**Main phase (any order, any number of times):**
- **Sell for Eddie** (once/turn) — sell a card with a Sell tag; worth 1 €$.
- **Play** — spend Eddies (or Legends as 1 €$ each) equal to a card's cost.
  Units enter with **Lag** (can't attack / self-spend) until end of turn.
- **Call a Legend** (once/turn) — spend 1 €$ to flip a Legend face-up at random.
- **Attack** — spend the attacking Unit; target a spent rival Unit (fight) or the
  rival Gig area (steal).

**Attacking:** spend attacker → declare target → Rival may react (Call a Legend /
Quick effects / **Blocker** redirect). Then:
- **Fight** (vs a spent Unit): compare power; higher power wins, ties defeat both.
- **Steal** (vs rival Gig area): take 1 Gig die, +1 per 10 power (power 1+ → 1
  Gig, 10+ → 2, 20+ → 3, …; power 0 steals nothing). Ready Units can't be
  attacked; only reaction Units (Quick/Blocker) can protect Gigs.

## Deck building & RAM  ← (the rules the deck-builder enforces)

1. Use **exactly 3 Legend cards** with **unique names**.
2. Include **no fewer than 40 and no more than 50 cards** (not counting Legends).
3. Use **no more than 3 copies** of the same card.
4. Cards must stay within the **RAM limit** set by your Legends.

**RAM rule (per color):** Each Legend has a colored border and a RAM limit. A
deck's RAM cap *for a given color* is the cumulative RAM of the Legends of that
color. A card may be included only if its RAM value ≤ the cap for the card's
color. Each Legend's RAM counts only toward its own color, so multi-color decks
need Legends covering each color used.

> Example: Goro Takemura: Hands Unclean (2 Green RAM) + Saburo Arasaka: Stubborn
> Patriarch (2 Green RAM) + Yorinobu Arasaka: Embracing Destruction (2 Red RAM)
> → deck may include Green cards up to 4 RAM and Red cards up to 2 RAM (no Blue/
> Yellow).

## Glossary (selected)

- **Spend / Ready** — turn a card sideways (spent) / upright (ready). Only ready
  Units attack; ready Units can't be attacked.
- **Eddies (€$)** — currency; each face-down card in the Eddies area = 1 Eddie.
- **Cost** — top-left number; Eddies (or Legends as 1 €$) to play the card.
- **Sell** — once/turn, sell a card with a Sell tag for 1 €$.
- **Gigs / Street Cred** — Gig dice you control / the sum of their face values.
- **Lag** — Units can't attack or self-spend the turn they enter.
- **Power** — bottom-right number; compared in fights; +1 stolen Gig per 10 power.
- **Bottom-deck / Trash (keyword)** — put cards on the bottom of your deck / put
  the top N cards of your deck into the trash.
