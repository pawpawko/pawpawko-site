-- ============================================================
-- Cyberpunk TCG deck support
-- ============================================================
-- Adds Cyberpunk decks alongside the existing One Piece deck system.
-- Cyberpunk deck-construction rules (see scripts/cyberpunk_deck_rules.json):
--   * exactly 3 Legends (cards.type = 'Legend'), all different names, kept in
--     their own area and NOT counted toward the main-deck size;
--   * main deck 40-50 cards (Legends excluded);
--   * at most 3 copies of any one card_code;
--   * per-color RAM cap: a non-Legend card's `ram` must be <= the sum of the
--     RAM of the Legends that share its color (cap 0 = that color is unusable).
--
-- Design (per product decision): a SEPARATE public.deck_legends table holds the
-- 3 Legends; the existing decks/deck_cards tables are reused for everything
-- else. The shared OPTCG trigger/validity functions are re-created here with a
-- cyberpunk early-branch ONLY — the One Piece code paths below each branch are
-- byte-for-byte the versions from decks_migration.sql, so OPTCG behavior is
-- unchanged. Idempotent; apply in the Supabase SQL editor.

-- ---------- 1. allow cyberpunk decks ----------
-- decks.game had check (game in ('optcg')); widen it. Drop whatever the check
-- is named (inline checks get an auto name) then re-add.
do $$
declare r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.decks'::regclass
       and c.contype = 'c'
       and pg_get_constraintdef(c.oid) ilike '%game%'
  loop
    execute format('alter table public.decks drop constraint %I', r.conname);
  end loop;
  alter table public.decks
    add constraint decks_game_check check (game in ('optcg', 'cyberpunk'));
end $$;

-- one_deck_per_leader is a One Piece rule (one deck per Leader). Cyberpunk has
-- no single leader, so scope the unique index to OPTCG; cyberpunk users may
-- keep several decks.
drop index if exists public.one_deck_per_leader;
create unique index if not exists one_deck_per_leader
  on public.decks (user_id, game, leader_card_code)
  where game = 'optcg';

-- ---------- 2. deck_legends table ----------
-- Note: card_code has NO FK to public.cards — cards is keyed on the composite
-- (game, card_code), and deck_cards likewise carries no cards FK. Existence +
-- "is a cyberpunk Legend" are enforced by deck_legends_validate() below.
create table if not exists public.deck_legends (
  deck_id    uuid not null references public.decks (id) on delete cascade,
  card_code  text not null,
  owned      int  not null default 0 check (owned between 0 and 1),
  primary key (deck_id, card_code)
);
create index if not exists deck_legends_deck_idx on public.deck_legends (deck_id);

-- Gatekeeper: cyberpunk Legend cards only, at most 3 per deck, all different
-- names.
create or replace function public.deck_legends_validate()
returns trigger language plpgsql as $$
declare v_deck public.decks%rowtype; v_card public.cards%rowtype; v_n int;
begin
  new.card_code := public.card_base_code(new.card_code);
  select * into v_deck from public.decks where id = new.deck_id;
  if not found then raise exception 'deck not found'; end if;
  if v_deck.game <> 'cyberpunk' then
    raise exception 'Legends are only for Cyberpunk decks';
  end if;
  select * into v_card from public.cards
   where game = 'cyberpunk' and card_code = new.card_code;
  if not found then raise exception 'card % not found', new.card_code; end if;
  if v_card.type <> 'Legend' then
    raise exception '% is not a Legend card', v_card.name;
  end if;
  select count(*) into v_n from public.deck_legends dl
   where dl.deck_id = new.deck_id and dl.card_code <> new.card_code;
  if v_n >= 3 then
    raise exception 'a deck may have at most 3 Legends';
  end if;
  if exists (select 1 from public.deck_legends dl
               join public.cards c on c.card_code = dl.card_code
              where dl.deck_id = new.deck_id and dl.card_code <> new.card_code
                and c.name = v_card.name) then
    raise exception 'the 3 Legends must be different cards (% already chosen)', v_card.name;
  end if;
  return new;
end $$;

drop trigger if exists deck_legends_validate on public.deck_legends;
create trigger deck_legends_validate
  before insert or update on public.deck_legends
  for each row execute function public.deck_legends_validate();

-- Editing legends unpublishes the deck + touches updated_at, same as editing
-- cards. deck_cards_touch_deck() only reads new/old.deck_id, so it works here.
drop trigger if exists deck_legends_touch_deck on public.deck_legends;
create trigger deck_legends_touch_deck
  after insert or update or delete on public.deck_legends
  for each row execute function public.deck_cards_touch_deck();

-- RLS mirrors deck_cards (members read/co-edit; is_deck_member from
-- shared_decks_migration).
alter table public.deck_legends enable row level security;
drop policy if exists "deck_legends_select" on public.deck_legends;
create policy "deck_legends_select" on public.deck_legends for select
  using (exists (select 1 from public.decks d
                  where d.id = deck_id
                    and (d.is_public or public.is_deck_member(d.id, auth.uid()))));
drop policy if exists "deck_legends_write" on public.deck_legends;
create policy "deck_legends_write" on public.deck_legends for all
  using (public.is_deck_member(deck_id, auth.uid()))
  with check (public.is_deck_member(deck_id, auth.uid()));

-- ---------- 2b. FIX: restore deck creation (both games) ----------
-- Diagnosis (2026-07-01): a valid owner can INSERT a binder but not a deck
-- (42501 "new row violates row-level security policy"), and no decks have been
-- created in prod since 2026-06-14 — deck creation is broken for everyone. The
-- committed policy is a plain owner check; a self-referential / is_deck_member
-- WITH CHECK can't see the not-yet-inserted row and rejects every insert.
-- Re-assert the correct owner-only insert policy (idempotent; matches
-- decks_migration.sql). deck_cards/deck_legends writes stay member-based via
-- is_deck_member, which is fine there (those rows reference an existing deck).
drop policy if exists "decks_insert" on public.decks;
create policy "decks_insert" on public.decks for insert
  with check (auth.uid() = user_id);

-- The REAL blocker: decks_select's USING was only is_deck_member(id,
-- auth.uid()). That helper is STABLE SECURITY DEFINER and re-queries decks, so
-- during `insert ... returning` (what the client's .insert().select('id')
-- does) it uses the statement snapshot and can't see the just-inserted row —
-- the RETURNING row is rejected with 42501, breaking deck creation for every
-- user since shared_decks_migration. Add a DIRECT owner disjunct so RETURNING
-- checks the new row's own user_id column. Existing-row reads are unchanged
-- (owners were already members; collaborators/public still covered).
drop policy if exists "decks_select" on public.decks;
create policy "decks_select" on public.decks for select
  using (is_public or user_id = auth.uid() or public.is_deck_member(id, auth.uid()));

-- ---------- 3. leader validation: cyberpunk branch ----------
-- Cyberpunk decks store one of their Legends in leader_card_code to satisfy
-- NOT NULL + the (game, leader_card_code) FK; the 3 real Legends live in
-- deck_legends. Below the branch is the unchanged OPTCG leader validation.
create or replace function public.decks_validate_leader()
returns trigger language plpgsql as $$
declare v_type text; v_name text;
begin
  if new.game = 'cyberpunk' then
    new.leader_card_code := public.card_base_code(new.leader_card_code);
    select type, name into v_type, v_name from public.cards
     where game = new.game and card_code = new.leader_card_code;
    if v_type is null then
      raise exception 'legend card % not found', new.leader_card_code;
    elsif v_type <> 'Legend' then
      raise exception 'card % is not a Legend card', new.leader_card_code;
    end if;
    new.updated_at := now();
    return new;
  end if;

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

-- ---------- 4. deck-card gatekeeper: cyberpunk branch ----------
-- Cyberpunk main-deck cards: base-code + must exist + must NOT be a Legend +
-- hard cap 3 copies. The per-color RAM cap and 40-50 size are validated softly
-- in cyberpunk_deck_validity (they depend on the separately-edited Legends, so
-- hard-blocking on insert would deadlock editing order). Below the branch is
-- the unchanged OPTCG gatekeeper.
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

  if v_deck.game = 'cyberpunk' then
    if v_card.type = 'Legend' then
      raise exception 'Legends go in the Legends area, not the main deck';
    end if;
    if new.quantity > 3 then
      raise exception 'max 3 copies of % per deck', v_card.name;
    end if;
    return new;
  end if;

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

-- ---------- 5. validity: cyberpunk rule set ----------
create or replace function public.cyberpunk_deck_validity(p_deck_id uuid)
returns jsonb language plpgsql stable as $$
declare
  v_deck public.decks%rowtype;
  v_problems text[] := '{}';
  v_legend_count int; v_legend_names int; v_legend_owned int;
  v_total int; v_owned int; v_missing int;
  r record;
  v_cap int;
begin
  select * into v_deck from public.decks where id = p_deck_id;
  if not found then
    return jsonb_build_object('valid', false, 'problems', array['deck not found']);
  end if;

  -- Legends: exactly 3, all different names.
  select count(*), count(distinct c.name), coalesce(sum(dl.owned), 0)
    into v_legend_count, v_legend_names, v_legend_owned
    from public.deck_legends dl
    join public.cards c on c.card_code = dl.card_code
   where dl.deck_id = p_deck_id;
  if v_legend_count <> 3 then
    v_problems := v_problems || format('need exactly 3 Legends (have %s)', v_legend_count);
  elsif v_legend_names < 3 then
    v_problems := v_problems || 'the 3 Legends must be different cards';
  end if;

  -- Main deck size 40-50 (Legends excluded).
  select coalesce(sum(quantity), 0), coalesce(sum(least(owned, quantity)), 0)
    into v_total, v_owned
    from public.deck_cards where deck_id = p_deck_id;
  if v_total < 40 then
    v_problems := v_problems || format('main deck has %s cards (min 40)', v_total);
  elsif v_total > 50 then
    v_problems := v_problems || format('main deck has %s cards (max 50)', v_total);
  end if;

  -- Per non-Legend card: not a Legend, <=3 copies, legal, within RAM cap.
  for r in
    select dc.card_code, dc.quantity, c.name, c.color, c.ram, c.type, c.legality
      from public.deck_cards dc
      join public.cards c on c.card_code = dc.card_code
     where dc.deck_id = p_deck_id
  loop
    if r.type = 'Legend' then
      v_problems := v_problems || format('%s is a Legend — move it to the Legends area', r.name);
    end if;
    if r.quantity > 3 then
      v_problems := v_problems || format('too many copies of %s (max 3)', r.name);
    end if;
    if coalesce(r.legality, 'legal') <> 'legal' then
      v_problems := v_problems || format('%s is not legal for construction', r.name);
    end if;
    select coalesce(sum(cl.ram), 0) into v_cap
      from public.deck_legends dl2
      join public.cards cl on cl.card_code = dl2.card_code
     where dl2.deck_id = p_deck_id and cl.color = r.color;
    if coalesce(r.ram, 0) > v_cap then
      v_problems := v_problems || format('%s (%s, RAM %s) exceeds your %s RAM cap of %s',
        r.name, r.color, coalesce(r.ram, 0), r.color, v_cap);
    end if;
  end loop;

  -- owned/missing include the Legends so publish requires owning everything.
  v_owned := v_owned + v_legend_owned;
  v_missing := (v_total + coalesce(v_legend_count, 0)) - v_owned;

  return jsonb_build_object(
    'valid', cardinality(v_problems) = 0,
    'problems', to_jsonb(v_problems),
    'total_cards', v_total,                 -- main deck only (the 40-50 gauge)
    'owned_cards', v_owned,                 -- incl. Legends
    'missing_cards', v_missing,             -- incl. Legends
    'owned_complete', v_missing = 0 and v_total > 0,
    'legend_count', coalesce(v_legend_count, 0)
  );
end $$;

-- deck_validity dispatches to the cyberpunk rules for cyberpunk decks; the
-- One Piece body below the dispatch is unchanged.
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

  if v_deck.game = 'cyberpunk' then
    return public.cyberpunk_deck_validity(p_deck_id);
  end if;

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
