-- ============================================================
-- DECKS migration — One Piece deck building (v1, optcg only)
-- Idempotent: safe to re-run. Apply in the Supabase SQL editor.
-- ============================================================
-- Rules implemented (verified against the official rule manual):
--   * 1 Leader + exactly 50 deck cards (CHARACTER / EVENT / STAGE).
--   * Every deck card must share at least one color with the leader.
--   * Max 4 copies per card NUMBER (alt arts like OP12-041_p1 count
--     together with their base card — decks store BASE codes only).
--   * Exceptions: cards whose text grants "you may have any number of
--     this card in your deck" (data-driven via deck_rule_exceptions;
--     also used for bans: max_copies = 0).
--   * Banned pairs/groups: listed cards cannot coexist in one deck
--     (deck_banned_groups, max_together members allowed per group).
--     The deck's LEADER counts as a group member (e.g. OP11-040).
--   * Bans apply to leaders too (max_copies = 0 blocks leading with it).
--   * Standard rotation (eff. 2026-04-01): Block 1 is out of Standard;
--     decks.format = 'standard' (default) | 'eternal'. Exemptions are
--     data-driven (rotation_exempt_cards: SPR "manga" numbers, Block 4
--     numbers, reprinted numbers). Bans/pairs apply to BOTH formats.
--   * One deck per leader per account (unique index).
--   * Non-exempt users limited to profiles.deck_limit decks (default 5;
--     NULL = unlimited).

-- ---------- helpers ----------

create or replace function public.card_base_code(p_code text)
returns text language sql immutable as $$
  select split_part(p_code, '_', 1)
$$;

create or replace function public.colors_overlap(a text, b text)
returns boolean language sql immutable as $$
  select string_to_array(coalesce(a, ''), '/') && string_to_array(coalesce(b, ''), '/')
$$;

-- ---------- tables ----------

create table if not exists public.decks (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users on delete cascade,
  game              text not null default 'optcg' check (game in ('optcg')),
  leader_card_code  text not null,
  name              text not null,
  is_public         boolean not null default false,
  listing_type      text check (listing_type in ('trade','sell','borrow')),
  created_at        timestamptz default now(),
  updated_at        timestamptz default now(),
  foreign key (game, leader_card_code) references public.cards (game, card_code)
);

create unique index if not exists one_deck_per_leader
  on public.decks (user_id, game, leader_card_code);
create index if not exists decks_user_idx on public.decks (user_id);

create table if not exists public.deck_cards (
  deck_id    uuid not null references public.decks (id) on delete cascade,
  card_code  text not null,            -- always a BASE code (no _p suffix)
  quantity   int  not null check (quantity between 1 and 50),
  owned      int  not null default 0 check (owned >= 0),
  primary key (deck_id, card_code),
  check (owned <= quantity)
);

-- Per-card copy-limit overrides. max_copies: NULL = any number allowed,
-- 0 = banned, other = that cap. Maintenance: when new sets import, find
-- new "any number" cards with
--   select card_code, name from cards where game='optcg'
--    and effect_text ilike '%any number of this card in your deck%'
--    and card_code = card_base_code(card_code);
create table if not exists public.deck_rule_exceptions (
  game       text not null,
  card_code  text not null,            -- base code
  max_copies int,
  note       text,
  primary key (game, card_code)
);

insert into public.deck_rule_exceptions (game, card_code, max_copies, note) values
  ('optcg', 'OP01-075', null, 'Pacifista — any number allowed (card text)'),
  ('optcg', 'OP08-072', null, 'Biscuit Warrior — any number allowed (card text)'),
  ('optcg', 'OP16-042', null, 'Prisoner of Impel Down — any number allowed (card text)'),
  ('optcg', 'OP06-047', 0,    'Charlotte Pudding — BANNED (official list, eff. 2026-04-01)'),
  ('optcg', 'OP03-040', 0,    'Nami (Leader) — BANNED (official list, eff. 2026-04-10)'),
  ('optcg', 'OP06-086', 0,    'Gecko Moria — BANNED (official list, eff. 2026-04-10)'),
  ('optcg', 'ST10-001', 0,    'Trafalgar Law (Leader) — BANNED (official list, eff. 2026-04-10)'),
  ('optcg', 'OP06-116', 0,    'Reject — BANNED (official list, eff. 2026-04-10)')
on conflict (game, card_code) do nothing;

-- 2026-04-01 unbans: Jinbe / Moby Dick / Kingdom Come trio is fully legal
-- again (was modeled here as banned group 4 before the correction).
delete from public.deck_banned_groups where group_id = 4;

-- Banned groups: a deck may contain at most max_together DISTINCT member
-- cards of the same group (official "cards that cannot be used in the
-- same deck" list, eff. 2026-04/05).
create table if not exists public.deck_banned_groups (
  group_id     int  not null,
  game         text not null,
  card_code    text not null,          -- base code
  max_together int  not null default 1,
  note         text,
  primary key (group_id, game, card_code)
);

insert into public.deck_banned_groups (group_id, game, card_code, max_together, note) values
  (1, 'optcg', 'EB04-058', 1, 'Borsalino — cannot share a deck with I Re-Quasar Helllp!!'),
  (1, 'optcg', 'OP07-115', 1, 'I Re-Quasar Helllp!! — cannot share a deck with Borsalino'),
  (2, 'optcg', 'OP11-040', 1, 'Monkey.D.Luffy (Leader) — cannot share a deck with Charlotte Katakuri'),
  (2, 'optcg', 'OP11-067', 1, 'Charlotte Katakuri — cannot share a deck with Monkey.D.Luffy (Leader)'),
  (3, 'optcg', 'OP11-040', 1, 'Monkey.D.Luffy (Leader) — cannot share a deck with Charlotte Linlin'),
  (3, 'optcg', 'OP08-069', 1, 'Charlotte Linlin — cannot share a deck with Monkey.D.Luffy (Leader)')
on conflict (group_id, game, card_code) do nothing;

-- ---------- Standard rotation (eff. 2026-04-01) ----------
-- Block 1 left Standard Regulation; decks.format picks the regulation:
--   'standard' (default) = rotation enforced; 'eternal' (Extra Regulation)
--   = every printing legal. Bans + banned pairs apply to BOTH formats.
-- A card NUMBER stays Standard-legal despite a rotated prefix when it has
-- a Super Parallel Rare ("manga") version, carries Block Number 4, or got
-- reprinted in a later block — all data-driven via rotation_exempt_cards.
-- Maintenance: when new sets release, add reprinted block-1 numbers here.

create table if not exists public.rotated_sets (
  game        text not null,
  set_prefix  text not null,            -- card_code prefix before the dash
  note        text,
  primary key (game, set_prefix)
);

insert into public.rotated_sets (game, set_prefix, note)
select 'optcg', p, 'Block 1 — out of Standard 2026-04-01'
from unnest(array['OP01','OP02','OP03','OP04','ST01','ST02','ST03','ST04','ST05','ST06','ST07','ST08','ST09']) p
on conflict (game, set_prefix) do nothing;

create table if not exists public.rotation_exempt_cards (
  game       text not null,
  card_code  text not null,             -- base code
  note       text,
  primary key (game, card_code)
);

insert into public.rotation_exempt_cards (game, card_code, note) values
  -- Super Parallel Rare ("manga") numbers — never rotate (official list)
  ('optcg', 'EB01-006', 'SPR — Tony Tony Chopper'),
  ('optcg', 'EB02-061', 'SPR — Monkey D. Luffy'),
  ('optcg', 'EB03-061', 'SPR — Uta'),
  ('optcg', 'EB04-044', 'SPR — Koby'),
  ('optcg', 'OP01-016', 'SPR — Nami'),
  ('optcg', 'OP01-120', 'SPR — Shanks'),
  ('optcg', 'OP02-013', 'SPR — Portgaz D. Ace'),
  ('optcg', 'OP03-122', 'SPR — Sniper King'),
  ('optcg', 'OP04-083', 'SPR — Sabo'),
  ('optcg', 'OP05-069', 'SPR — Trafalgar Law'),
  ('optcg', 'OP05-074', 'SPR — Eustass Kid'),
  ('optcg', 'OP05-119', 'SPR — Monkey D. Luffy'),
  ('optcg', 'OP06-118', 'SPR — Roronoa Zolo'),
  ('optcg', 'OP06-119', 'SPR — Sanji'),
  ('optcg', 'OP07-051', 'SPR — Boa Hancock'),
  ('optcg', 'OP08-118', 'SPR — Silvers Rayleigh'),
  ('optcg', 'OP09-004', 'SPR — Shanks'),
  ('optcg', 'OP09-051', 'SPR — Buggy'),
  ('optcg', 'OP09-093', 'SPR — Marshall D. Teech'),
  ('optcg', 'OP09-118', 'SPR — Gold D. Roger'),
  ('optcg', 'OP09-119', 'SPR — Monkey D. Luffy'),
  ('optcg', 'OP10-119', 'SPR — Trafalgar Law'),
  ('optcg', 'OP11-118', 'SPR — Monkey D. Luffy'),
  ('optcg', 'OP12-118', 'SPR — Jewelry Bonney'),
  ('optcg', 'OP13-118', 'SPR — Monkey.D.Luffy'),
  ('optcg', 'OP13-119', 'SPR — Portgas.D.Ace'),
  ('optcg', 'OP13-120', 'SPR — Sabo'),
  ('optcg', 'OP14-119', 'SPR — Dracule Mihawk'),
  ('optcg', 'OP15-118', 'SPR — Enel'),
  ('optcg', 'OP16-063', 'SPR — Kuzan'),
  ('optcg', 'OP16-065', 'SPR — Sakazuki'),
  ('optcg', 'OP16-073', 'SPR — Borsalino'),
  -- Block Number 4 cards — legal through 2029-03-31 (official list)
  ('optcg', 'OP01-039', 'Block 4 — Killer'),
  ('optcg', 'OP01-055', 'Block 4 — You Can Be My Samurai!!'),
  ('optcg', 'OP02-005', 'Block 4 — Curly Dadan'),
  ('optcg', 'OP02-068', 'Block 4 — Gum-Gum Rain'),
  ('optcg', 'OP03-008', 'Block 4 — Buggy'),
  ('optcg', 'OP03-044', 'Block 4 — Kaya'),
  ('optcg', 'OP03-048', 'Block 4 — Nojiko'),
  ('optcg', 'OP03-072', 'Block 4 — Gum-Gum Jet Gatling'),
  ('optcg', 'OP03-097', 'Block 4 — Six King Pistol'),
  ('optcg', 'OP04-016', 'Block 4 — Bad Manners Kick Course'),
  ('optcg', 'OP04-077', 'Block 4 — Ideo'),
  ('optcg', 'OP04-096', 'Block 4 — Corrida Coliseum'),
  ('optcg', 'ST01-011', 'Block 4 — Brook'),
  ('optcg', 'ST02-007', 'Block 4 — Jewelry Bonney'),
  ('optcg', 'ST06-008', 'Block 4 — Hina')
on conflict (game, card_code) do nothing;

create or replace function public.standard_legal(p_game text, p_code text)
returns boolean language sql stable as $$
  select not exists (
           select 1 from public.rotated_sets
            where game = p_game and set_prefix = split_part(p_code, '-', 1))
      or exists (
           select 1 from public.rotation_exempt_cards
            where game = p_game and card_code = public.card_base_code(p_code))
$$;

alter table public.decks add column if not exists format text not null default 'standard'
  check (format in ('standard','eternal'));

-- Deck cap per account (NULL = unlimited). Kold is exempt — run once:
--   update public.profiles set deck_limit = null where display_name = 'Kold';
alter table public.profiles add column if not exists deck_limit int default 5;

-- Wishlist provenance: which deck a wishlist listing was pushed from.
alter table public.listings add column if not exists deck_id uuid references public.decks (id) on delete set null;
create index if not exists listings_deck_idx on public.listings (deck_id) where deck_id is not null;

-- ---------- triggers ----------

-- Leader must be a real LEADER card of the deck's game; base codes only;
-- leader can't change once the deck has cards (color base would shift).
create or replace function public.decks_validate_leader()
returns trigger language plpgsql as $$
declare v_type text; v_name text;
begin
  new.leader_card_code := public.card_base_code(new.leader_card_code);
  select type, name into v_type, v_name from public.cards
   where game = new.game and card_code = new.leader_card_code;
  if v_type is null then
    raise exception 'leader card % not found', new.leader_card_code;
  elsif v_type <> 'LEADER' then
    raise exception 'card % is not a Leader card', new.leader_card_code;
  end if;
  if exists (select 1 from public.deck_rule_exceptions
              where game = new.game and card_code = new.leader_card_code
                and max_copies = 0) then
    raise exception '% is banned from deck construction', v_name;
  end if;
  if new.format = 'standard'
     and not public.standard_legal(new.game, new.leader_card_code) then
    raise exception '% rotated out of Standard; switch the deck to Eternal to use it', v_name;
  end if;
  if tg_op = 'UPDATE' and new.leader_card_code <> old.leader_card_code
     and exists (select 1 from public.deck_cards where deck_id = new.id) then
    raise exception 'cannot change leader while the deck has cards';
  end if;
  if tg_op = 'UPDATE' and new.format = 'standard' and old.format = 'eternal'
     and exists (select 1 from public.deck_cards
                  where deck_id = new.id
                    and not public.standard_legal(new.game, card_code)) then
    raise exception 'deck contains cards that rotated out of Standard; remove them first';
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists decks_validate_leader on public.decks;
create trigger decks_validate_leader
  before insert or update on public.decks
  for each row execute function public.decks_validate_leader();

-- Enforce profiles.deck_limit on create (NULL = unlimited).
create or replace function public.decks_enforce_limit()
returns trigger language plpgsql as $$
declare v_limit int; v_count int;
begin
  select deck_limit into v_limit from public.profiles where user_id = new.user_id;
  if v_limit is not null then
    select count(*) into v_count from public.decks where user_id = new.user_id;
    if v_count >= v_limit then
      raise exception 'deck limit reached (% decks max)', v_limit;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists decks_enforce_limit on public.decks;
create trigger decks_enforce_limit
  before insert on public.decks
  for each row execute function public.decks_enforce_limit();

-- Deck-card gatekeeper: base-code normalize, card must exist + be a
-- non-Leader of the deck's game, share a color with the leader, respect
-- copy limits (incl. exceptions/bans) and banned groups.
create or replace function public.deck_cards_validate()
returns trigger language plpgsql as $$
declare
  v_deck   public.decks%rowtype;
  v_card   public.cards%rowtype;
  v_leader_color text;
  v_cap    int;
  v_has_exception boolean;
  v_group  record;
begin
  new.card_code := public.card_base_code(new.card_code);

  select * into v_deck from public.decks where id = new.deck_id;
  if not found then raise exception 'deck not found'; end if;

  select * into v_card from public.cards
   where game = v_deck.game and card_code = new.card_code;
  if not found then raise exception 'card % not found', new.card_code; end if;
  if v_card.type = 'LEADER' then
    raise exception 'Leader cards cannot be added to the deck';
  end if;

  select color into v_leader_color from public.cards
   where game = v_deck.game and card_code = v_deck.leader_card_code;
  if not public.colors_overlap(v_card.color, v_leader_color) then
    raise exception '% (%) does not match your leader''s colors (%)',
      v_card.name, v_card.color, v_leader_color;
  end if;

  if v_deck.format = 'standard'
     and not public.standard_legal(v_deck.game, new.card_code) then
    raise exception '% rotated out of Standard; switch the deck to Eternal to use it', v_card.name;
  end if;

  select true, max_copies into v_has_exception, v_cap
    from public.deck_rule_exceptions
   where game = v_deck.game and card_code = new.card_code;
  if not coalesce(v_has_exception, false) then
    v_cap := 4;                                   -- standard rule
  end if;                                          -- exception NULL = unlimited
  if v_cap is not null then
    if v_cap = 0 then
      raise exception '% is banned from deck construction', v_card.name;
    elsif new.quantity > v_cap then
      raise exception 'max % cop% of % per deck', v_cap,
        case when v_cap = 1 then 'y' else 'ies' end, v_card.name;
    end if;
  end if;

  -- The deck's LEADER counts as a group member too (official pairs like
  -- OP11-040 Luffy ban cards against the deck *led* by him).
  for v_group in
    select g.group_id, g.max_together
      from public.deck_banned_groups g
     where g.game = v_deck.game and g.card_code = new.card_code
  loop
    if (select count(distinct dc.card_code)
          from public.deck_cards dc
          join public.deck_banned_groups g2
            on g2.game = v_deck.game and g2.card_code = dc.card_code
           and g2.group_id = v_group.group_id
         where dc.deck_id = new.deck_id
           and dc.card_code <> new.card_code)
       + (case when exists (select 1 from public.deck_banned_groups gl
                where gl.game = v_deck.game and gl.group_id = v_group.group_id
                  and gl.card_code = v_deck.leader_card_code) then 1 else 0 end)
       + 1 > v_group.max_together then
      raise exception '% cannot be used in the same deck with the other listed card(s) (official banned pair)', v_card.name;
    end if;
  end loop;

  return new;
end $$;

drop trigger if exists deck_cards_validate on public.deck_cards;
create trigger deck_cards_validate
  before insert or update on public.deck_cards
  for each row execute function public.deck_cards_validate();

-- Editing a public deck's cards auto-unpublishes it (it may no longer be
-- valid/fully owned); also touches decks.updated_at.
create or replace function public.deck_cards_touch_deck()
returns trigger language plpgsql as $$
declare v_id uuid;
begin
  v_id := coalesce(new.deck_id, old.deck_id);
  update public.decks
     set updated_at = now(),
         is_public = false,
         listing_type = null
   where id = v_id and is_public;
  update public.decks set updated_at = now()
   where id = v_id and not is_public;
  return coalesce(new, old);
end $$;

drop trigger if exists deck_cards_touch_deck on public.deck_cards;
create trigger deck_cards_touch_deck
  after insert or update or delete on public.deck_cards
  for each row execute function public.deck_cards_touch_deck();

-- ---------- validity + publish + wishlist RPCs ----------

-- Full rule check. Returns jsonb:
-- { valid, problems[], total_cards, owned_cards, missing_cards, owned_complete }
create or replace function public.deck_validity(p_deck_id uuid)
returns jsonb language plpgsql stable as $$
declare
  v_deck public.decks%rowtype;
  v_leader_color text;
  v_problems text[] := '{}';
  v_total int; v_owned int; v_missing int;
  r record;
begin
  select * into v_deck from public.decks where id = p_deck_id;
  if not found then return jsonb_build_object('valid', false, 'problems', array['deck not found']); end if;

  select color into v_leader_color from public.cards
   where game = v_deck.game and card_code = v_deck.leader_card_code;

  if exists (select 1 from public.deck_rule_exceptions
              where game = v_deck.game and card_code = v_deck.leader_card_code
                and max_copies = 0) then
    v_problems := v_problems || format('leader %s is banned', v_deck.leader_card_code);
  end if;
  if v_deck.format = 'standard'
     and not public.standard_legal(v_deck.game, v_deck.leader_card_code) then
    v_problems := v_problems || format('leader %s rotated out of Standard', v_deck.leader_card_code);
  end if;

  select coalesce(sum(quantity), 0),
         coalesce(sum(least(owned, quantity)), 0)
    into v_total, v_owned
    from public.deck_cards where deck_id = p_deck_id;
  v_missing := v_total - v_owned;

  if v_total <> 50 then
    v_problems := v_problems || format('deck has %s/50 cards', v_total);
  end if;

  for r in
    select dc.card_code, dc.quantity, c.name, c.color, c.type
      from public.deck_cards dc
      join public.cards c on c.game = v_deck.game and c.card_code = dc.card_code
     where dc.deck_id = p_deck_id
  loop
    if r.type = 'LEADER' then
      v_problems := v_problems || format('%s is a Leader card', r.name);
    end if;
    if not public.colors_overlap(r.color, v_leader_color) then
      v_problems := v_problems || format('%s (%s) does not match leader colors (%s)', r.name, r.color, v_leader_color);
    end if;
    if exists (select 1 from public.deck_rule_exceptions
                where game = v_deck.game and card_code = r.card_code
                  and max_copies = 0) then
      v_problems := v_problems || format('%s is banned', r.name);
    elsif r.quantity > coalesce(
         (select coalesce(max_copies, 999) from public.deck_rule_exceptions
           where game = v_deck.game and card_code = r.card_code), 4) then
      v_problems := v_problems || format('too many copies of %s', r.name);
    end if;
    if v_deck.format = 'standard'
       and not public.standard_legal(v_deck.game, r.card_code) then
      v_problems := v_problems || format('%s rotated out of Standard', r.name);
    end if;
  end loop;

  -- Banned groups: the deck's LEADER counts as a member alongside deck cards.
  for r in
    select g.group_id, g.max_together, count(distinct m.card_code) as n,
           string_agg(distinct c.name, ' + ') as names
      from public.deck_banned_groups g
      join (select card_code from public.deck_cards where deck_id = p_deck_id
            union
            select v_deck.leader_card_code) m on m.card_code = g.card_code
      join public.cards c on c.game = v_deck.game and c.card_code = m.card_code
     where g.game = v_deck.game
     group by g.group_id, g.max_together
    having count(distinct m.card_code) > g.max_together
  loop
    v_problems := v_problems || format('banned combination: %s', r.names);
  end loop;

  return jsonb_build_object(
    'valid', cardinality(v_problems) = 0,
    'problems', to_jsonb(v_problems),
    'total_cards', v_total,
    'owned_cards', v_owned,
    'missing_cards', v_missing,
    'owned_complete', v_missing = 0 and v_total > 0
  );
end $$;

-- Publish gate: deck must be rule-valid AND fully owned.
create or replace function public.publish_deck(p_deck_id uuid, p_listing_type text)
returns void language plpgsql as $$
declare v jsonb;
begin
  if not exists (select 1 from public.decks where id = p_deck_id and user_id = auth.uid()) then
    raise exception 'not your deck';
  end if;
  if p_listing_type not in ('trade','sell','borrow') then
    raise exception 'listing type must be trade, sell, or borrow';
  end if;
  v := public.deck_validity(p_deck_id);
  if not (v->>'valid')::boolean then
    raise exception 'deck is not valid: %', (select string_agg(x, '; ') from jsonb_array_elements_text(v->'problems') x);
  end if;
  if not (v->>'owned_complete')::boolean then
    raise exception 'you must own every card in the deck to list it (% missing)', v->>'missing_cards';
  end if;
  update public.decks set is_public = true, listing_type = p_listing_type, updated_at = now()
   where id = p_deck_id;
end $$;

create or replace function public.unpublish_deck(p_deck_id uuid)
returns void language plpgsql as $$
begin
  update public.decks set is_public = false, listing_type = null, updated_at = now()
   where id = p_deck_id and user_id = auth.uid();
end $$;

-- Push every missing copy to the user's wishlist binder for that game
-- (created if absent). One listings row per card (app invariant):
-- existing rows get deck_id + quantity bumped to the missing count.
-- Returns the number of cards pushed.
create or replace function public.push_deck_missing_to_wishlist(p_deck_id uuid)
returns int language plpgsql as $$
declare
  v_deck public.decks%rowtype;
  v_binder uuid;
  v_n int := 0;
  r record;
begin
  select * into v_deck from public.decks where id = p_deck_id and user_id = auth.uid();
  if not found then raise exception 'not your deck'; end if;

  select id into v_binder from public.binders
   where user_id = auth.uid() and category = v_deck.game and flair = 'wishlist'
   limit 1;
  if v_binder is null then
    insert into public.binders (user_id, name, category, flair)
    values (auth.uid(), 'Wishlist', v_deck.game, 'wishlist')
    returning id into v_binder;
  end if;

  for r in
    select card_code, quantity - owned as missing
      from public.deck_cards
     where deck_id = p_deck_id and owned < quantity
  loop
    if exists (select 1 from public.listings where binder_id = v_binder and card_code = r.card_code) then
      update public.listings
         set deck_id = p_deck_id, quantity = greatest(quantity, r.missing)
       where binder_id = v_binder and card_code = r.card_code;
    else
      insert into public.listings (binder_id, card_code, quantity, listing_type, deck_id)
      values (v_binder, r.card_code, r.missing, 'trade', p_deck_id);
    end if;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ---------- RLS ----------

alter table public.decks enable row level security;
alter table public.deck_cards enable row level security;
alter table public.deck_rule_exceptions enable row level security;
alter table public.deck_banned_groups enable row level security;

drop policy if exists "decks_select" on public.decks;
create policy "decks_select" on public.decks for select
  using (is_public or auth.uid() = user_id);
drop policy if exists "decks_insert" on public.decks;
create policy "decks_insert" on public.decks for insert
  with check (auth.uid() = user_id);
drop policy if exists "decks_update" on public.decks;
create policy "decks_update" on public.decks for update
  using (auth.uid() = user_id);
drop policy if exists "decks_delete" on public.decks;
create policy "decks_delete" on public.decks for delete
  using (auth.uid() = user_id);

drop policy if exists "deck_cards_select" on public.deck_cards;
create policy "deck_cards_select" on public.deck_cards for select
  using (exists (select 1 from public.decks d where d.id = deck_id and (d.is_public or d.user_id = auth.uid())));
drop policy if exists "deck_cards_write" on public.deck_cards;
create policy "deck_cards_write" on public.deck_cards for all
  using (exists (select 1 from public.decks d where d.id = deck_id and d.user_id = auth.uid()))
  with check (exists (select 1 from public.decks d where d.id = deck_id and d.user_id = auth.uid()));

drop policy if exists "deck_rule_exceptions_read" on public.deck_rule_exceptions;
create policy "deck_rule_exceptions_read" on public.deck_rule_exceptions for select using (true);
drop policy if exists "deck_banned_groups_read" on public.deck_banned_groups;
create policy "deck_banned_groups_read" on public.deck_banned_groups for select using (true);

alter table public.rotated_sets enable row level security;
alter table public.rotation_exempt_cards enable row level security;
drop policy if exists "rotated_sets_read" on public.rotated_sets;
create policy "rotated_sets_read" on public.rotated_sets for select using (true);
drop policy if exists "rotation_exempt_cards_read" on public.rotation_exempt_cards;
create policy "rotation_exempt_cards_read" on public.rotation_exempt_cards for select using (true);
