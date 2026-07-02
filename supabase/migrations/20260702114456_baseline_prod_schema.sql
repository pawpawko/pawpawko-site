


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE EXTENSION IF NOT EXISTS "cube" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "earthdistance" WITH SCHEMA "public";






CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";






CREATE EXTENSION IF NOT EXISTS "supabase_vault" WITH SCHEMA "vault";






CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";






CREATE OR REPLACE FUNCTION "public"."binder_collaborators_list"("p_binder_id" "uuid") RETURNS TABLE("user_id" "uuid", "display_name" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select c.user_id, p.display_name
  from public.binder_collaborators c
  join public.profiles p on p.user_id = c.user_id
  where c.binder_id = p_binder_id
    and public.is_binder_member(p_binder_id, auth.uid())
  order by c.created_at;
$$;


ALTER FUNCTION "public"."binder_collaborators_list"("p_binder_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."card_base_code"("p_code" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select split_part(p_code, '_', 1)
$$;


ALTER FUNCTION "public"."card_base_code"("p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."clear_presence"() RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  delete from public.user_presence where user_id = auth.uid();
$$;


ALTER FUNCTION "public"."clear_presence"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."colors_overlap"("a" "text", "b" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    AS $$
  select string_to_array(coalesce(a, ''), '/') && string_to_array(coalesce(b, ''), '/')
$$;


ALTER FUNCTION "public"."colors_overlap"("a" "text", "b" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."contains_banned_word"("p_text" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  normalized text := public.normalize_for_moderation(p_text);
begin
  if normalized = '' then return false; end if;
  return exists (
    select 1 from public.banned_words
    where word <> '' and position(word in normalized) > 0
  );
end; $$;


ALTER FUNCTION "public"."contains_banned_word"("p_text" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cyberpunk_deck_validity"("p_deck_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    AS $$
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


ALTER FUNCTION "public"."cyberpunk_deck_validity"("p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_cards_check_art_mix"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
declare
  k text;
  v jsonb;
  n int;
  total int := 0;
  over int;
begin
  if new.art_mix is null then
    new.art_mix := '{}'::jsonb;
  end if;
  if jsonb_typeof(new.art_mix) <> 'object' then
    raise exception 'art_mix must be a JSON object of print code -> copies';
  end if;

  for k, v in select * from jsonb_each(new.art_mix) loop
    if jsonb_typeof(v) <> 'number' then
      raise exception 'art_mix.% must be a number', k;
    end if;
    n := (v #>> '{}')::numeric::int;
    if n <= 0 then
      new.art_mix := new.art_mix - k;
      continue;
    end if;
    if k = new.card_code or public.card_base_code(k) <> new.card_code then
      raise exception 'art_mix key % is not an alt print of %', k, new.card_code;
    end if;
    if not exists (select 1 from public.cards c where c.card_code = k) then
      raise exception 'art_mix key % is not a known card print', k;
    end if;
    -- normalize to a clean integer value
    new.art_mix := jsonb_set(new.art_mix, array[k], to_jsonb(n));
    total := total + n;
  end loop;

  -- Clamp to quantity: shed alt assignments largest-count-first.
  while total > new.quantity loop
    select key into k
      from jsonb_each(new.art_mix) as e(key, val)
      order by (val #>> '{}')::int desc, key
      limit 1;
    exit when k is null;
    n := (new.art_mix ->> k)::int;
    over := total - new.quantity;
    if over >= n then
      new.art_mix := new.art_mix - k;
      total := total - n;
    else
      new.art_mix := jsonb_set(new.art_mix, array[k], to_jsonb(n - over));
      total := new.quantity;
    end if;
  end loop;

  return new;
end;
$$;


ALTER FUNCTION "public"."deck_cards_check_art_mix"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_cards_notify_collect"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deck       public.decks%rowtype;
  v_actor      uuid := auth.uid();
  v_actor_name text;
  v_card_name  text;
  v_delta      int;
  v_member     uuid;
begin
  v_delta := new.owned - coalesce(old.owned, 0);
  if v_delta <= 0 then return new; end if;             -- only on owned increase
  if not exists (select 1 from public.deck_collaborators where deck_id = new.deck_id) then
    return new;                                         -- not a shared deck
  end if;

  select * into v_deck from public.decks where id = new.deck_id;
  select display_name into v_actor_name from public.profiles where user_id = v_actor;
  select name into v_card_name from public.cards
   where game = v_deck.game and card_code = new.card_code;

  for v_member in
    select v_deck.user_id
     where v_deck.user_id <> coalesce(v_actor, '00000000-0000-0000-0000-000000000000'::uuid)
    union
    select user_id from public.deck_collaborators
     where deck_id = new.deck_id
       and user_id <> coalesce(v_actor, '00000000-0000-0000-0000-000000000000'::uuid)
  loop
    -- Coalesce into an existing unread collect notice (same deck+card+actor).
    update public.notifications
       set data = jsonb_set(data, '{qty}',
                            to_jsonb(coalesce((data->>'qty')::int, 0) + v_delta)),
           read = false, created_at = now()
     where user_id = v_member and type = 'deck_card_collected' and read = false
       and (data->>'deck_id')::uuid = new.deck_id
       and data->>'card_code' = new.card_code
       and (data->>'by_user')::uuid = v_actor;
    if not found then
      insert into public.notifications (user_id, type, status, data)
      values (v_member, 'deck_card_collected', 'info',
              jsonb_build_object('deck_id', new.deck_id, 'deck_name', v_deck.name,
                                 'card_code', new.card_code,
                                 'card_name', coalesce(v_card_name, new.card_code),
                                 'qty', v_delta,
                                 'by_user', v_actor, 'by_name', coalesce(v_actor_name, 'Someone')));
    end if;
  end loop;

  return new;
end $$;


ALTER FUNCTION "public"."deck_cards_notify_collect"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_cards_sync_wishlist"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_deck    public.decks%rowtype;
  v_code    text;
  v_missing int;
  v_binder  uuid;
  v_member  uuid;
begin
  select * into v_deck from public.decks where id = coalesce(new.deck_id, old.deck_id);
  if not found then return coalesce(new, old); end if;  -- deck mid-cascade-delete

  v_code := coalesce(new.card_code, old.card_code);
  v_missing := case when tg_op = 'DELETE' then 0
                    else greatest(new.quantity - new.owned, 0) end;

  for v_member in
    select v_deck.user_id
    union
    select user_id from public.deck_collaborators where deck_id = v_deck.id
  loop
    select id into v_binder from public.binders
     where user_id = v_member and category = v_deck.game and flair = 'wishlist' limit 1;

    if v_missing > 0 then
      if v_binder is null then
        insert into public.binders (user_id, name, category, flair)
        values (v_member, 'Wishlist', v_deck.game, 'wishlist') returning id into v_binder;
      end if;
      if exists (select 1 from public.listings where binder_id = v_binder and card_code = v_code) then
        update public.listings set deck_id = v_deck.id, quantity = v_missing
         where binder_id = v_binder and card_code = v_code;
      else
        insert into public.listings (binder_id, card_code, quantity, listing_type, deck_id)
        values (v_binder, v_code, v_missing, 'trade', v_deck.id);
      end if;
    elsif v_binder is not null then
      delete from public.listings
       where binder_id = v_binder and card_code = v_code and deck_id = v_deck.id;
    end if;
  end loop;

  return coalesce(new, old);
end $$;


ALTER FUNCTION "public"."deck_cards_sync_wishlist"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_cards_touch_deck"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."deck_cards_touch_deck"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_cards_validate"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."deck_cards_validate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_collaborators_list"("p_deck_id" "uuid") RETURNS TABLE("user_id" "uuid", "display_name" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select c.user_id, p.display_name
  from public.deck_collaborators c
  join public.profiles p on p.user_id = c.user_id
  where c.deck_id = p_deck_id
    and public.is_deck_member(p_deck_id, auth.uid())
  order by c.created_at;
$$;


ALTER FUNCTION "public"."deck_collaborators_list"("p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_legends_validate"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."deck_legends_validate"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_pending_invite"("p_deck_id" "uuid") RETURNS TABLE("user_id" "uuid", "display_name" "text", "notification_id" "uuid")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select n.user_id, p.display_name, n.id
  from public.notifications n
  join public.decks d on d.id = (n.data->>'deck_id')::uuid
  join public.profiles p on p.user_id = n.user_id
  where n.type = 'deck_invite' and n.status = 'pending'
    and (n.data->>'deck_id')::uuid = p_deck_id
    and d.user_id = auth.uid()                        -- only the deck owner
  limit 1;
$$;


ALTER FUNCTION "public"."deck_pending_invite"("p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_trade_partner"("p_deck_id" "uuid") RETURNS TABLE("user_id" "uuid", "display_name" "text")
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_game text; v_partner uuid;
begin
  select d.game into v_game from public.decks d
   where d.id = p_deck_id and d.user_id = auth.uid();
  if v_game is null then return; end if;             -- not found / not owner
  -- Same partner resolution share_deck uses: the other member of the shared
  -- trade binder for this game (caller as owner OR collaborator).
  select case when b.user_id = auth.uid() then c.user_id else b.user_id end
    into v_partner
    from public.binder_collaborators c
    join public.binders b on b.id = c.binder_id
   where b.flair = 'trade' and b.category = v_game
     and (b.user_id = auth.uid() or c.user_id = auth.uid())
   limit 1;
  if v_partner is null then return; end if;
  return query
    select pr.user_id, pr.display_name from public.profiles pr
     where pr.user_id = v_partner;
end $$;


ALTER FUNCTION "public"."deck_trade_partner"("p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deck_validity"("p_deck_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" STABLE
    AS $$
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


ALTER FUNCTION "public"."deck_validity"("p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decks_cleanup_wishlist"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  delete from public.listings where deck_id = old.id;
  return old;
end $$;


ALTER FUNCTION "public"."decks_cleanup_wishlist"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decks_enforce_limit"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."decks_enforce_limit"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."decks_validate_leader"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."decks_validate_leader"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."dismiss_notification"("p_notification_id" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  delete from public.notifications
   where id = p_notification_id and user_id = auth.uid();
$$;


ALTER FUNCTION "public"."dismiss_notification"("p_notification_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."display_name_acceptable"("p_name" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select not public.contains_banned_word(p_name);
$$;


ALTER FUNCTION "public"."display_name_acceptable"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."display_name_available"("p_name" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select not exists (
    select 1
    from public.profiles
    where lower(display_name) = lower(trim(p_name))
      and user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  );
$$;


ALTER FUNCTION "public"."display_name_available"("p_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_binder_listings_public"("p_binder_id" "uuid") RETURNS TABLE("id" "uuid", "card_code" "text", "quantity" integer, "listing_type" "text", "sort_order" integer, "created_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select l.id, l.card_code, l.quantity, l.listing_type, l.sort_order, l.created_at
  from public.listings l
  where l.binder_id = p_binder_id
  order by l.sort_order nulls last, l.created_at desc;
$$;


ALTER FUNCTION "public"."get_binder_listings_public"("p_binder_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_binder_public"("p_binder_id" "uuid") RETURNS TABLE("id" "uuid", "user_id" "uuid", "display_name" "text", "binder_name" "text", "binder_description" "text", "sleeve_image_url" "text", "binder_background_url" "text", "flair" "text", "category" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select b.id, b.user_id, p.display_name, b.name, b.description,
         b.sleeve_image_url, b.binder_background_url, b.flair, b.category
  from public.binders b
  join public.profiles p on p.user_id = b.user_id
  where b.id = p_binder_id;
$$;


ALTER FUNCTION "public"."get_binder_public"("p_binder_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_identity"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  begin
    if new.provider = 'discord' then
      update public.profiles
         set discord_handle = coalesce(
           new.identity_data->>'user_name',
           new.identity_data->>'preferred_username'
         )
       where user_id = new.user_id
         and discord_handle is null
         and coalesce(
           new.identity_data->>'user_name',
           new.identity_data->>'preferred_username'
         ) is not null;
    end if;
    return new;
  end; $$;


ALTER FUNCTION "public"."handle_new_identity"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  declare
    v_provider       text := new.raw_app_meta_data->>'provider';
    v_meta_name      text := new.raw_user_meta_data->>'display_name';
    v_display_name   text;
    v_discord_handle text;
  begin
    v_display_name := coalesce(
      v_meta_name,
      'user-' || substring(new.id::text from 1 for 8)
    );
    if v_provider = 'discord' then
      v_discord_handle := coalesce(
        new.raw_user_meta_data->>'user_name',
        new.raw_user_meta_data->>'preferred_username'
      );
    end if;
    insert into public.profiles (user_id, display_name, discord_handle)
    values (new.id, v_display_name, v_discord_handle);
    -- no auto-binder: binders default to flair='trade'/category='optcg',
    -- which produced an unwanted trade binder for every signup.
    return new;
  end; $$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_binder_member"("p_binder_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from public.binders b
                  where b.id = p_binder_id and b.user_id = p_uid)
      or exists (select 1 from public.binder_collaborators c
                  where c.binder_id = p_binder_id and c.user_id = p_uid);
$$;


ALTER FUNCTION "public"."is_binder_member"("p_binder_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_deck_member"("p_deck_id" "uuid", "p_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (select 1 from public.decks d
                  where d.id = p_deck_id and d.user_id = p_uid)
      or exists (select 1 from public.deck_collaborators c
                  where c.deck_id = p_deck_id and c.user_id = p_uid);
$$;


ALTER FUNCTION "public"."is_deck_member"("p_deck_id" "uuid", "p_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_notifications_read"() RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  update public.notifications set read = true, read_at = now()
   where user_id = auth.uid() and read = false;
$$;


ALTER FUNCTION "public"."mark_notifications_read"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."nearby_trade_binders"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text" DEFAULT NULL::"text") RETURNS TABLE("binder_id" "uuid", "user_id" "uuid", "display_name" "text", "binder_name" "text", "binder_description" "text", "sleeve_image_url" "text", "flair" "text", "category" "text", "last_updated_at" timestamp with time zone, "distance_m" double precision)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with code as (
    select nullif(lower(btrim(coalesce(p_event_code, ''))), '') as v
  ),
  caller_pt as (
    select ll_to_earth(p_lat, p_lng) as pt
  ),
  active as (
    select up.user_id,
           up.event_code,
           earth_distance(ll_to_earth(up.lat, up.lng), (select pt from caller_pt)) as distance_m
      from public.user_presence up
     where up.expires_at > now()
       and up.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  hits as (
    select a.user_id, a.distance_m
      from active a, code
     where a.distance_m <= 500
        or (code.v is not null and a.event_code = code.v and a.distance_m <= 3220)
  )
  select b.id as binder_id,
         b.user_id,
         p.display_name,
         b.name as binder_name,
         b.description as binder_description,
         b.sleeve_image_url,
         b.flair,
         b.category,
         coalesce((select max(l.created_at) from public.listings l where l.binder_id = b.id), b.created_at) as last_updated_at,
         h.distance_m
    from hits h
    join public.binders b on b.user_id = h.user_id
    join public.profiles p on p.user_id = b.user_id
   where b.flair = 'trade'
   order by h.distance_m asc, last_updated_at desc
   limit 200;
$$;


ALTER FUNCTION "public"."nearby_trade_binders"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."nearby_wishlist_matches"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text" DEFAULT NULL::"text") RETURNS TABLE("binder_id" "uuid", "owner_user_id" "uuid", "owner_display_name" "text", "category" "text", "matched_card_codes" "text"[])
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with code as (
    select nullif(lower(btrim(coalesce(p_event_code, ''))), '') as v
  ),
  caller_pt as (
    select ll_to_earth(p_lat, p_lng) as pt
  ),
  active as (
    select up.user_id,
           up.event_code,
           earth_distance(ll_to_earth(up.lat, up.lng), (select pt from caller_pt)) as distance_m
      from public.user_presence up
     where up.expires_at > now()
       and up.user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  ),
  hits as (
    select a.user_id, a.distance_m
      from active a, code
     where a.distance_m <= 500
        or (code.v is not null and a.event_code = code.v and a.distance_m <= 3220)
  ),
  -- Caller's wishlist card_codes per game.
  my_wishes as (
    select b.category, l.card_code
      from public.binders b
      join public.listings l on l.binder_id = b.id
     where b.user_id = auth.uid()
       and b.flair  = 'wishlist'
  )
  select b.id as binder_id,
         b.user_id as owner_user_id,
         p.display_name as owner_display_name,
         b.category,
         array_agg(distinct l.card_code order by l.card_code) as matched_card_codes
    from hits h
    join public.binders  b on b.user_id = h.user_id and b.flair = 'trade'
    join public.profiles p on p.user_id = b.user_id
    join public.listings l on l.binder_id = b.id
    join my_wishes m on m.category = b.category and m.card_code = l.card_code
   group by b.id, b.user_id, p.display_name, b.category
   order by array_length(array_agg(distinct l.card_code), 1) desc nulls last
   limit 200;
$$;


ALTER FUNCTION "public"."nearby_wishlist_matches"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."normalize_for_moderation"("s" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select regexp_replace(
    translate(
      lower(coalesce(s, '')),
      '@$013457!|',
      'asoieastii'
    ),
    '[^a-z]+', '', 'g'
  );
$_$;


ALTER FUNCTION "public"."normalize_for_moderation"("s" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profiles_enforce_name_cooldown"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
  begin
    if new.display_name is distinct from old.display_name then
      if old.display_name_set is true
         and old.display_name_changed_at is not null
         and now() - old.display_name_changed_at < interval '90 days' then
        raise exception 'display_name can only be changed once every 90 days (next change allowed at %)',
          old.display_name_changed_at + interval '90 days'
          using errcode = 'check_violation';
      end if;
      new.display_name_changed_at := now();
    else
      new.display_name_changed_at := old.display_name_changed_at;
    end if;
    return new;
  end; $$;


ALTER FUNCTION "public"."profiles_enforce_name_cooldown"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profiles_validate_display_name"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.display_name is not null
     and (tg_op = 'INSERT' or new.display_name is distinct from old.display_name)
     and public.contains_banned_word(new.display_name) then
    raise exception 'display_name contains disallowed words'
      using errcode = 'check_violation',
            hint = 'Please choose a different display name.';
  end if;
  return new;
end; $$;


ALTER FUNCTION "public"."profiles_validate_display_name"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."prune_notifications"() RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  delete from public.notifications
   where user_id = auth.uid()
     and read and read_at is not null
     and read_at < now() - interval '14 days';
$$;


ALTER FUNCTION "public"."prune_notifications"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."publish_deck"("p_deck_id" "uuid", "p_listing_type" "text") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
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


ALTER FUNCTION "public"."publish_deck"("p_deck_id" "uuid", "p_listing_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_trade_tap"("p_partner_user_id" "uuid", "p_match_count" integer) RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;
  if p_partner_user_id is null then
    raise exception 'p_partner_user_id is required';
  end if;
  if p_partner_user_id = auth.uid() then
    raise exception 'cannot record a trade tap with yourself';
  end if;
  insert into public.trade_tap_history (user_id, partner_user_id, match_count)
  values (auth.uid(), p_partner_user_id, greatest(coalesce(p_match_count, 0), 0))
  on conflict (user_id, partner_user_id, tapped_on) do update
    set match_count = excluded.match_count,
        tapped_at   = now()
  returning id into v_id;
  return v_id;
end;
$$;


ALTER FUNCTION "public"."record_trade_tap"("p_partner_user_id" "uuid", "p_match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rescind_deck_invite"("p_deck_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.decks where id = p_deck_id;
  if v_owner is null then raise exception 'Deck not found'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'Only the deck owner can do that'; end if;
  delete from public.notifications
   where type = 'deck_invite' and status = 'pending'
     and (data->>'deck_id')::uuid = p_deck_id;
end $$;


ALTER FUNCTION "public"."rescind_deck_invite"("p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resolve_binder_slug"("p_slug" "text") RETURNS "uuid"
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  declare
    v_suffix text;
    v_id uuid;
    v_count int;
  begin
    v_suffix := lower(substring(p_slug from '[0-9a-f]{8}$'));
    if v_suffix is null then return null; end if;
    select count(*) into v_count from public.binders
      where id::text like v_suffix || '%';
    if v_count <> 1 then return null; end if;
    select id into v_id from public.binders
      where id::text like v_suffix || '%';
    return v_id;
  end;
  $_$;


ALTER FUNCTION "public"."resolve_binder_slug"("p_slug" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."respond_binder_invite"("p_notification_id" "uuid", "p_accept" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare n public.notifications; v_binder uuid; v_from uuid;
        v_flair text; v_cat text; v_name text; v_by text; v_old uuid;
begin
  select * into n from public.notifications
   where id = p_notification_id and user_id = auth.uid() and type = 'binder_invite';
  if n.id is null then raise exception 'Invite not found'; end if;
  if n.status <> 'pending' then raise exception 'This invite was already handled'; end if;

  v_binder := (n.data->>'binder_id')::uuid;
  v_from   := (n.data->>'from_user')::uuid;
  select display_name into v_by from public.profiles where user_id = auth.uid();
  select flair, category, name into v_flair, v_cat, v_name from public.binders where id = v_binder;

  if p_accept then
    if v_binder is null or v_cat is null then raise exception 'That binder no longer exists'; end if;
    if v_flair is distinct from 'trade' then raise exception 'Only trade binders can be shared with a partner'; end if;
    -- One partner per binder: if someone already joined (e.g. two invites were
    -- out and one was accepted first), reject this accept with a clear message
    -- instead of letting the unique index throw a raw error.
    if exists (select 1 from public.binder_collaborators c where c.binder_id = v_binder) then
      raise exception 'This binder already has a partner';
    end if;
    -- Merge (non-destructive): fold the partner's own trade binder for this game
    -- into the shared binder instead of deleting it, so no cards are lost. The
    -- couple then co-edits the single shared binder.
    select id into v_old from public.binders
     where user_id = auth.uid() and category = v_cat and flair = 'trade'
     limit 1;
    if v_old is not null and v_old is distinct from v_binder then
      -- 1. Overlapping cards: add the partner's quantity onto the shared row.
      update public.listings sh
         set quantity = sh.quantity + ov.qty
        from (select card_code, sum(quantity) as qty
                from public.listings where binder_id = v_old group by card_code) ov
       where sh.binder_id = v_binder and sh.card_code = ov.card_code;
      -- 2. Drop the partner's rows that were just folded in.
      delete from public.listings
       where binder_id = v_old
         and card_code in (select card_code from public.listings where binder_id = v_binder);
      -- 3. Move the remaining (non-overlapping) cards into the shared binder;
      --    null sort_order so they append at the end of the existing layout.
      update public.listings set binder_id = v_binder, sort_order = null
       where binder_id = v_old;
      -- 4. The partner's old binder is now empty — remove it.
      delete from public.binders where id = v_old;
    end if;
    insert into public.binder_collaborators (binder_id, user_id, added_by)
    values (v_binder, auth.uid(), v_from)
    on conflict (binder_id, user_id) do nothing;
    update public.notifications set status = 'accepted', read = true where id = p_notification_id;
    insert into public.notifications (user_id, type, status, data)
    values (v_from, 'binder_invite_accepted', 'info',
            jsonb_build_object('binder_name', v_name, 'by_name', coalesce(v_by, 'Someone')));
  else
    update public.notifications set status = 'declined', read = true where id = p_notification_id;
    insert into public.notifications (user_id, type, status, data)
    values (v_from, 'binder_invite_declined', 'info',
            jsonb_build_object('binder_name', v_name, 'by_name', coalesce(v_by, 'Someone')));
  end if;
end $$;


ALTER FUNCTION "public"."respond_binder_invite"("p_notification_id" "uuid", "p_accept" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."respond_deck_invite"("p_notification_id" "uuid", "p_accept" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare n public.notifications; v_deck uuid; v_from uuid; v_game text; v_name text; v_by text; v_partner uuid; v_leader text;
begin
  select * into n from public.notifications
   where id = p_notification_id and user_id = auth.uid() and type = 'deck_invite';
  if n.id is null then raise exception 'Invite not found'; end if;
  if n.status <> 'pending' then raise exception 'This invite was already handled'; end if;

  v_deck := (n.data->>'deck_id')::uuid;
  v_from := (n.data->>'from_user')::uuid;
  select display_name into v_by from public.profiles where user_id = auth.uid();
  select game, name, leader_card_code into v_game, v_name, v_leader from public.decks where id = v_deck;

  if p_accept then
    if v_game is null then raise exception 'That deck no longer exists'; end if;
    if exists (select 1 from public.deck_collaborators c where c.deck_id = v_deck) then
      raise exception 'This deck already has a partner';
    end if;
    -- Re-confirm the trade-binder partnership still holds for this game.
    select case when b.user_id = v_from then c.user_id else b.user_id end
      into v_partner
      from public.binder_collaborators c
      join public.binders b on b.id = c.binder_id
     where b.flair = 'trade' and b.category = v_game
       and (b.user_id = v_from or c.user_id = v_from)
     limit 1;
    if v_partner is distinct from auth.uid() then
      raise exception 'You are no longer your partner''s trade-binder co-owner for this game';
    end if;

    -- The shared deck REPLACES the recipient's own deck for this leader: destroy
    -- it so they don't keep two decks for the same leader. The delete cascades
    -- its deck_cards and fires decks_cleanup_wishlist to pull its wishlist rows.
    delete from public.decks
     where user_id = auth.uid() and game = v_game
       and leader_card_code = v_leader and id <> v_deck;

    insert into public.deck_collaborators (deck_id, user_id, added_by)
    values (v_deck, auth.uid(), v_from)
    on conflict (deck_id, user_id) do nothing;
    -- Seed the new collaborator's wishlist with the deck's missing cards.
    perform public.resync_deck_member_wishlist(v_deck, auth.uid());

    update public.notifications set status = 'accepted', read = true where id = p_notification_id;
    insert into public.notifications (user_id, type, status, data)
    values (v_from, 'deck_invite_accepted', 'info',
            jsonb_build_object('deck_id', v_deck, 'deck_name', v_name, 'by_name', coalesce(v_by, 'Someone')));
  else
    update public.notifications set status = 'declined', read = true where id = p_notification_id;
    insert into public.notifications (user_id, type, status, data)
    values (v_from, 'deck_invite_declined', 'info',
            jsonb_build_object('deck_id', v_deck, 'deck_name', v_name, 'by_name', coalesce(v_by, 'Someone')));
  end if;
end $$;


ALTER FUNCTION "public"."respond_deck_invite"("p_notification_id" "uuid", "p_accept" boolean) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."resync_deck_member_wishlist"("p_deck_id" "uuid", "p_member" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_deck public.decks%rowtype; r record; v_binder uuid; v_missing int;
begin
  select * into v_deck from public.decks where id = p_deck_id;
  if not found then return; end if;

  select id into v_binder from public.binders
   where user_id = p_member and category = v_deck.game and flair = 'wishlist' limit 1;

  for r in select card_code, quantity, owned from public.deck_cards where deck_id = p_deck_id loop
    v_missing := greatest(r.quantity - r.owned, 0);
    if v_missing > 0 then
      if v_binder is null then
        insert into public.binders (user_id, name, category, flair)
        values (p_member, 'Wishlist', v_deck.game, 'wishlist') returning id into v_binder;
      end if;
      if exists (select 1 from public.listings where binder_id = v_binder and card_code = r.card_code) then
        update public.listings set deck_id = v_deck.id, quantity = v_missing
         where binder_id = v_binder and card_code = r.card_code;
      else
        insert into public.listings (binder_id, card_code, quantity, listing_type, deck_id)
        values (v_binder, r.card_code, v_missing, 'trade', v_deck.id);
      end if;
    end if;
  end loop;
end $$;


ALTER FUNCTION "public"."resync_deck_member_wishlist"("p_deck_id" "uuid", "p_member" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."search_binders"("p_boroughs" "text"[] DEFAULT NULL::"text"[], "p_subways" "text"[] DEFAULT NULL::"text"[], "p_shop" "text" DEFAULT NULL::"text", "p_category" "text" DEFAULT NULL::"text", "p_city" "text" DEFAULT NULL::"text", "p_card_codes" "text"[] DEFAULT NULL::"text"[]) RETURNS TABLE("binder_id" "uuid", "user_id" "uuid", "display_name" "text", "binder_name" "text", "binder_description" "text", "sleeve_image_url" "text", "flair" "text", "category" "text", "last_updated_at" timestamp with time zone, "matched_card_count" integer, "matched_cards" "text"[])
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with searched as (
    select b.id as binder_id, b.user_id, p.display_name,
           b.name as binder_name, b.description as binder_description,
           b.sleeve_image_url, b.flair, b.category,
           coalesce((select max(l.created_at) from public.listings l where l.binder_id = b.id), b.created_at) as last_updated_at,
           (case when p_card_codes is null or coalesce(array_length(p_card_codes, 1), 0) = 0
                 then 0
                 else (select count(distinct l.card_code)::int
                         from public.listings l
                        where l.binder_id = b.id and l.card_code = any(p_card_codes))
            end) as matched_card_count,
           (case when p_card_codes is null or coalesce(array_length(p_card_codes, 1), 0) = 0
                 then null::text[]
                 else (select array_agg(distinct l.card_code order by l.card_code)
                         from public.listings l
                        where l.binder_id = b.id and l.card_code = any(p_card_codes))
            end) as matched_cards
    from public.binders b
    join public.profiles p on p.user_id = b.user_id
    where b.flair <> 'wishlist'
      and (p_city     is null or p.city = p_city)
      and (p_boroughs is null or coalesce(array_length(p_boroughs, 1), 0) = 0 or p.boroughs && p_boroughs)
      and (p_subways  is null or coalesce(array_length(p_subways,  1), 0) = 0 or p.subway_stops && p_subways)
      and (p_shop     is null or p_shop = any(p.local_shops))
      and (p_category is null or b.category = p_category)
  )
  select *
  from searched
  where p_card_codes is null
    or coalesce(array_length(p_card_codes, 1), 0) = 0
    or matched_card_count > 0
  order by matched_card_count desc, last_updated_at desc
  limit 200;
$$;


ALTER FUNCTION "public"."search_binders"("p_boroughs" "text"[], "p_subways" "text"[], "p_shop" "text", "p_category" "text", "p_city" "text", "p_card_codes" "text"[]) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."share_binder"("p_binder_id" "uuid", "p_display_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_owner uuid; v_partner uuid; v_bname text; v_fname text; v_flair text;
begin
  select b.user_id, b.name, b.flair into v_owner, v_bname, v_flair from public.binders b where b.id = p_binder_id;
  if v_owner is null then raise exception 'Binder not found'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'Only the binder owner can share it'; end if;
  -- Only trade binders can have a partner (wishlist/flex/lgs are not shareable).
  if v_flair is distinct from 'trade' then raise exception 'Only trade binders can be shared with a partner'; end if;
  -- One partner per binder: block if it already has a collaborator OR any pending invite.
  if exists (select 1 from public.binder_collaborators c where c.binder_id = p_binder_id) then
    raise exception 'This binder already has a partner'; end if;
  if exists (select 1 from public.notifications n
              where n.type = 'binder_invite' and n.status = 'pending'
                and (n.data->>'binder_id')::uuid = p_binder_id) then
    raise exception 'An invite for this binder is already pending';
  end if;

  select p.user_id into v_partner from public.profiles p
   where lower(p.display_name) = lower(btrim(p_display_name))
   limit 1;
  if v_partner is null then raise exception 'No account found with that name'; end if;
  if v_partner = v_owner then raise exception 'That account already owns this binder'; end if;

  select display_name into v_fname from public.profiles where user_id = auth.uid();
  insert into public.notifications (user_id, type, status, data)
  values (v_partner, 'binder_invite', 'pending',
          jsonb_build_object('binder_id', p_binder_id, 'binder_name', v_bname,
                             'from_user', auth.uid(), 'from_name', coalesce(v_fname, 'Someone')));
end $$;


ALTER FUNCTION "public"."share_binder"("p_binder_id" "uuid", "p_display_name" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."share_deck"("p_deck_id" "uuid", "p_display_name" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_owner uuid; v_game text; v_dname text; v_partner uuid; v_named uuid; v_fname text; v_leader text;
begin
  select user_id, game, name, leader_card_code into v_owner, v_game, v_dname, v_leader
    from public.decks where id = p_deck_id;
  if v_owner is null then raise exception 'Deck not found'; end if;
  if v_owner is distinct from auth.uid() then raise exception 'Only the deck owner can share it'; end if;

  select user_id into v_named from public.profiles
   where lower(display_name) = lower(btrim(p_display_name)) limit 1;
  if v_named is null then raise exception 'No account found with that name'; end if;
  if v_named = v_owner then raise exception 'That account already owns this deck'; end if;

  -- The named account must be your trade-binder partner for this game:
  -- the other member of your shared trade binder (you as owner OR collaborator).
  select case when b.user_id = auth.uid() then c.user_id else b.user_id end
    into v_partner
    from public.binder_collaborators c
    join public.binders b on b.id = c.binder_id
   where b.flair = 'trade' and b.category = v_game
     and (b.user_id = auth.uid() or c.user_id = auth.uid())
   limit 1;
  if v_partner is null then
    raise exception 'Share a trade binder with your partner first — decks can only be shared with that partner';
  end if;
  if v_partner is distinct from v_named then
    raise exception 'You can only share a deck with your trade-binder partner';
  end if;

  -- One partner per deck; no double invites.
  if exists (select 1 from public.deck_collaborators c where c.deck_id = p_deck_id) then
    raise exception 'This deck already has a partner'; end if;
  if exists (select 1 from public.notifications n
              where n.type = 'deck_invite' and n.status = 'pending'
                and (n.data->>'deck_id')::uuid = p_deck_id) then
    raise exception 'An invite for this deck is already pending';
  end if;

  select display_name into v_fname from public.profiles where user_id = auth.uid();
  insert into public.notifications (user_id, type, status, data)
  values (v_partner, 'deck_invite', 'pending',
          jsonb_build_object('deck_id', p_deck_id, 'deck_name', v_dname,
                             'leader_card_code', v_leader, 'game', v_game,
                             'from_user', auth.uid(), 'from_name', coalesce(v_fname, 'Someone')));
end $$;


ALTER FUNCTION "public"."share_deck"("p_deck_id" "uuid", "p_display_name" "text") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."binders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" DEFAULT 'My Binder'::"text" NOT NULL,
    "description" "text",
    "sleeve_image_url" "text",
    "binder_background_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "flair" "text" DEFAULT 'trade'::"text" NOT NULL,
    "category" "text" DEFAULT 'optcg'::"text" NOT NULL,
    "layout" "text" DEFAULT '4x3'::"text" NOT NULL,
    CONSTRAINT "binders_background_url_check" CHECK ((("binder_background_url" IS NULL) OR ("binder_background_url" ~~ 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'::"text"))),
    CONSTRAINT "binders_category_check" CHECK (("category" = ANY (ARRAY['optcg'::"text", 'pokemon'::"text", 'cyberpunk'::"text"]))),
    CONSTRAINT "binders_layout_check" CHECK (("layout" = ANY (ARRAY['4x3'::"text", '3x3'::"text"]))),
    CONSTRAINT "binders_sleeve_image_url_check" CHECK ((("sleeve_image_url" IS NULL) OR ("sleeve_image_url" ~~ 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'::"text")))
);


ALTER TABLE "public"."binders" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."shared_binders"() RETURNS SETOF "public"."binders"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select b.*
  from public.binders b
  join public.binder_collaborators c on c.binder_id = b.id
  where c.user_id = auth.uid();
$$;


ALTER FUNCTION "public"."shared_binders"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."decks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "game" "text" DEFAULT 'optcg'::"text" NOT NULL,
    "leader_card_code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "is_public" boolean DEFAULT false NOT NULL,
    "listing_type" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "format" "text" DEFAULT 'standard'::"text" NOT NULL,
    "goals" "jsonb",
    CONSTRAINT "decks_format_check" CHECK (("format" = ANY (ARRAY['standard'::"text", 'eternal'::"text"]))),
    CONSTRAINT "decks_game_check" CHECK (("game" = ANY (ARRAY['optcg'::"text", 'cyberpunk'::"text"]))),
    CONSTRAINT "decks_listing_type_check" CHECK (("listing_type" = ANY (ARRAY['trade'::"text", 'sell'::"text", 'borrow'::"text"])))
);


ALTER TABLE "public"."decks" OWNER TO "postgres";


COMMENT ON COLUMN "public"."decks"."goals" IS 'User-set deck-building targets for the stats panel:
  {curve:{count,cost}, counters, search}.';



CREATE OR REPLACE FUNCTION "public"."shared_decks"() RETURNS SETOF "public"."decks"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select d.*
  from public.decks d
  join public.deck_collaborators c on c.deck_id = d.id
  where c.user_id = auth.uid();
$$;


ALTER FUNCTION "public"."shared_decks"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."slugify"("s" "text") RETURNS "text"
    LANGUAGE "sql" IMMUTABLE
    AS $_$
  select regexp_replace(
    lower(regexp_replace(coalesce(s, ''), '[^a-zA-Z0-9]+', '-', 'g')),
    '^-+|-+$', '', 'g'
  );
$_$;


ALTER FUNCTION "public"."slugify"("s" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."standard_legal"("p_game" "text", "p_code" "text") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select not exists (
           select 1 from public.rotated_sets
            where game = p_game and set_prefix = split_part(p_code, '-', 1))
      or exists (
           select 1 from public.rotation_exempt_cards
            where game = p_game and card_code = public.card_base_code(p_code))
$$;


ALTER FUNCTION "public"."standard_legal"("p_game" "text", "p_code" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."trade_matches"("p_partner_user_id" "uuid") RETURNS TABLE("game" "text", "card_code" "text", "card_name" "text", "card_image_url" "text", "i_want_they_have" boolean, "they_want_i_have" boolean, "my_trade_binder_id" "uuid", "their_trade_binder_id" "uuid", "mutual" boolean)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  with me as (select auth.uid() as user_id),
  my_wish as (
    select b.category as game, l.card_code
      from public.binders b
      join public.listings l on l.binder_id = b.id
      join me on b.user_id = me.user_id
     where b.flair = 'wishlist'
  ),
  my_trade as (
    select b.category as game, l.card_code, b.id as binder_id
      from public.binders b
      join public.listings l on l.binder_id = b.id
      join me on b.user_id = me.user_id
     where b.flair = 'trade'
  ),
  their_wish as (
    select b.category as game, l.card_code
      from public.binders b
      join public.listings l on l.binder_id = b.id
     where b.user_id = p_partner_user_id and b.flair = 'wishlist'
  ),
  their_trade as (
    select b.category as game, l.card_code, b.id as binder_id
      from public.binders b
      join public.listings l on l.binder_id = b.id
     where b.user_id = p_partner_user_id and b.flair = 'trade'
  ),
  all_codes as (
    select distinct game, card_code from (
      -- cards I want that they have
      select mw.game, mw.card_code
        from my_wish mw
        join their_trade tt on tt.game = mw.game and tt.card_code = mw.card_code
      union
      -- cards they want that I have
      select tw.game, tw.card_code
        from their_wish tw
        join my_trade mt on mt.game = tw.game and mt.card_code = tw.card_code
    ) u
  )
  select c.game,
         c.card_code,
         cd.name      as card_name,
         cd.image_url as card_image_url,
         (exists (select 1 from my_wish    mw where mw.game = c.game and mw.card_code = c.card_code)
            and exists (select 1 from their_trade tt where tt.game = c.game and tt.card_code = c.card_code)) as i_want_they_have,
         (exists (select 1 from their_wish tw where tw.game = c.game and tw.card_code = c.card_code)
            and exists (select 1 from my_trade    mt where mt.game = c.game and mt.card_code = c.card_code)) as they_want_i_have,
         (select binder_id from my_trade    where game = c.game and card_code = c.card_code limit 1) as my_trade_binder_id,
         (select binder_id from their_trade where game = c.game and card_code = c.card_code limit 1) as their_trade_binder_id,
         ((exists (select 1 from my_wish    mw where mw.game = c.game and mw.card_code = c.card_code)
             and exists (select 1 from their_trade tt where tt.game = c.game and tt.card_code = c.card_code))
          and
          (exists (select 1 from their_wish tw where tw.game = c.game and tw.card_code = c.card_code)
             and exists (select 1 from my_trade    mt where mt.game = c.game and mt.card_code = c.card_code))) as mutual
    from all_codes c
    join public.cards cd on cd.game = c.game and cd.card_code = c.card_code
   order by mutual desc,
            c.game asc,
            c.card_code asc;
$$;


ALTER FUNCTION "public"."trade_matches"("p_partner_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unpublish_deck"("p_deck_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
begin
  update public.decks set is_public = false, listing_type = null, updated_at = now()
   where id = p_deck_id and user_id = auth.uid();
end $$;


ALTER FUNCTION "public"."unpublish_deck"("p_deck_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unshare_binder"("p_binder_id" "uuid", "p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_owner uuid;
begin
  select b.user_id into v_owner from public.binders b where b.id = p_binder_id;
  if v_owner is null then raise exception 'Binder not found'; end if;
  if v_owner is distinct from auth.uid() and p_user_id is distinct from auth.uid() then
    raise exception 'Not allowed';
  end if;
  delete from public.binder_collaborators
   where binder_id = p_binder_id and user_id = p_user_id;
end $$;


ALTER FUNCTION "public"."unshare_binder"("p_binder_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."unshare_deck"("p_deck_id" "uuid", "p_user_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_owner uuid;
begin
  select user_id into v_owner from public.decks where id = p_deck_id;
  if v_owner is null then raise exception 'Deck not found'; end if;
  if v_owner is distinct from auth.uid() and p_user_id is distinct from auth.uid() then
    raise exception 'Not allowed';
  end if;
  delete from public.deck_collaborators where deck_id = p_deck_id and user_id = p_user_id;
  -- Pull the removed member's deck-claimed wishlist rows back out.
  delete from public.listings
   where deck_id = p_deck_id
     and binder_id in (select id from public.binders where user_id = p_user_id and flair = 'wishlist');
end $$;


ALTER FUNCTION "public"."unshare_deck"("p_deck_id" "uuid", "p_user_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_presence"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'must be authenticated';
  end if;
  v_code := nullif(lower(btrim(coalesce(p_event_code, ''))), '');
  insert into public.user_presence (user_id, lat, lng, event_code, last_ping, expires_at)
  values (
    auth.uid(),
    round(p_lat::numeric, 3)::double precision,
    round(p_lng::numeric, 3)::double precision,
    v_code,
    now(),
    now() + interval '1 hour'
  )
  on conflict (user_id) do update
    set lat        = excluded.lat,
        lng        = excluded.lng,
        event_code = excluded.event_code,
        last_ping  = excluded.last_ping,
        expires_at = excluded.expires_at;
end;
$$;


ALTER FUNCTION "public"."upsert_presence"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."banned_words" (
    "word" "text" NOT NULL
);


ALTER TABLE "public"."banned_words" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."binder_collaborators" (
    "binder_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "added_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."binder_collaborators" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cards" (
    "card_code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "series" "text",
    "color" "text",
    "type" "text",
    "cost" integer,
    "power" integer,
    "counter" integer,
    "attribute" "text",
    "trigger_text" "text",
    "rarity" "text",
    "effect_text" "text",
    "image_url" "text",
    "release_order" integer DEFAULT 0,
    "image_url_lg" "text",
    "game" "text" DEFAULT 'optcg'::"text" NOT NULL,
    "hp" integer,
    "types" "text"[],
    "retreat_cost" integer,
    "weakness" "text",
    "resistance" "text",
    "evolves_from" "text",
    "supertype" "text",
    "subtypes" "text"[],
    "set_id" "text",
    "number" "text",
    "attacks" "jsonb",
    "price_usd" numeric(10,2),
    "price_updated_at" timestamp with time zone,
    "block_number" "text",
    "search_meta" "jsonb",
    "life" integer,
    "ram" integer,
    "is_eddiable" boolean,
    "keywords" "text"[],
    "artist" "text",
    "legality" "text",
    CONSTRAINT "cards_game_check" CHECK (("game" = ANY (ARRAY['optcg'::"text", 'pokemon'::"text", 'cyberpunk'::"text"])))
);


ALTER TABLE "public"."cards" OWNER TO "postgres";


COMMENT ON COLUMN "public"."cards"."price_usd" IS 'Cheapest USD price across this card number''s prints (TCGplayer via Limitless). Maintained by scripts/update_prices.py; null = no price found yet.';



COMMENT ON COLUMN "public"."cards"."price_updated_at" IS 'When price_usd was last refreshed by scripts/update_prices.py.';



COMMENT ON COLUMN "public"."cards"."block_number" IS 'Printed Block Icon (1-5 or X) scraped from the official card list — the ORIGINAL block cohort, NOT the current rotation block. Reference only; never derive legality from it (OP05-003 prints 1 but is Standard-legal). Rotation is set-based + manual exemptions. See scripts/rules_check.py.';



COMMENT ON COLUMN "public"."cards"."search_meta" IS 'Parsed One Piece searcher predicate (null = not a recognized searcher). Shape: {kind,look,take,filters[],union,gated,trigger,template,confidence,source}. Written service-role only by scripts/search_meta.py; see search_meta_migration.sql.';



COMMENT ON COLUMN "public"."cards"."ram" IS 'Cyberpunk TCG RAM value. Deck-building constraint: a card is legal only if its RAM <= sum of the deck''s three Legends'' RAM in the card''s color. Legends store the per-color RAM limit they grant. See cyberpunk_deck_rules.json.';



CREATE TABLE IF NOT EXISTS "public"."deck_banned_groups" (
    "group_id" integer NOT NULL,
    "game" "text" NOT NULL,
    "card_code" "text" NOT NULL,
    "max_together" integer DEFAULT 1 NOT NULL,
    "note" "text"
);


ALTER TABLE "public"."deck_banned_groups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deck_cards" (
    "deck_id" "uuid" NOT NULL,
    "card_code" "text" NOT NULL,
    "quantity" integer NOT NULL,
    "owned" integer DEFAULT 0 NOT NULL,
    "art_mix" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    CONSTRAINT "deck_cards_check" CHECK (("owned" <= "quantity")),
    CONSTRAINT "deck_cards_owned_check" CHECK (("owned" >= 0)),
    CONSTRAINT "deck_cards_quantity_check" CHECK ((("quantity" >= 1) AND ("quantity" <= 50)))
);

ALTER TABLE ONLY "public"."deck_cards" REPLICA IDENTITY FULL;


ALTER TABLE "public"."deck_cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deck_collaborators" (
    "deck_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "added_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."deck_collaborators" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deck_legends" (
    "deck_id" "uuid" NOT NULL,
    "card_code" "text" NOT NULL,
    "owned" integer DEFAULT 0 NOT NULL,
    CONSTRAINT "deck_legends_owned_check" CHECK ((("owned" >= 0) AND ("owned" <= 1)))
);


ALTER TABLE "public"."deck_legends" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deck_rule_exceptions" (
    "game" "text" NOT NULL,
    "card_code" "text" NOT NULL,
    "max_copies" integer,
    "note" "text"
);


ALTER TABLE "public"."deck_rule_exceptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."listings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "card_code" "text" NOT NULL,
    "quantity" integer NOT NULL,
    "listing_type" "text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "binder_id" "uuid",
    "sort_order" integer,
    "deck_id" "uuid",
    CONSTRAINT "listings_listing_type_check" CHECK (("listing_type" = ANY (ARRAY['trade'::"text", 'sell'::"text", 'free'::"text", 'combo'::"text"]))),
    CONSTRAINT "listings_quantity_check" CHECK (("quantity" > 0))
);

ALTER TABLE ONLY "public"."listings" REPLICA IDENTITY FULL;


ALTER TABLE "public"."listings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "status" "text" DEFAULT 'info'::"text" NOT NULL,
    "data" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "read" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "read_at" timestamp with time zone
);

ALTER TABLE ONLY "public"."notifications" REPLICA IDENTITY FULL;


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "user_id" "uuid" NOT NULL,
    "display_name" "text" NOT NULL,
    "discord_handle" "text",
    "binder_name" "text" DEFAULT 'My Binder'::"text" NOT NULL,
    "binder_description" "text",
    "boroughs" "text"[] DEFAULT '{}'::"text"[],
    "subway_stops" "text"[] DEFAULT '{}'::"text"[],
    "local_shops" "text"[] DEFAULT '{}'::"text"[],
    "created_at" timestamp with time zone DEFAULT "now"(),
    "slug" "text" GENERATED ALWAYS AS ((("public"."slugify"("display_name") || '_'::"text") || "public"."slugify"("binder_name"))) STORED,
    "sleeve_image_url" "text",
    "binder_background_url" "text",
    "city" "text" DEFAULT 'nyc'::"text" NOT NULL,
    "display_name_changed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "display_name_set" boolean DEFAULT false NOT NULL,
    "deck_limit" integer DEFAULT 5,
    CONSTRAINT "profiles_binder_background_url_check" CHECK ((("binder_background_url" IS NULL) OR ("binder_background_url" ~~ 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'::"text"))),
    CONSTRAINT "profiles_sleeve_image_url_check" CHECK ((("sleeve_image_url" IS NULL) OR ("sleeve_image_url" ~~ 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'::"text")))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rotated_sets" (
    "game" "text" NOT NULL,
    "set_prefix" "text" NOT NULL,
    "note" "text"
);


ALTER TABLE "public"."rotated_sets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rotation_exempt_cards" (
    "game" "text" NOT NULL,
    "card_code" "text" NOT NULL,
    "note" "text"
);


ALTER TABLE "public"."rotation_exempt_cards" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."trade_tap_history" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "partner_user_id" "uuid" NOT NULL,
    "tapped_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "match_count" integer DEFAULT 0 NOT NULL,
    "tapped_on" "date" GENERATED ALWAYS AS ((("tapped_at" AT TIME ZONE 'UTC'::"text"))::"date") STORED
);


ALTER TABLE "public"."trade_tap_history" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."user_presence" (
    "user_id" "uuid" NOT NULL,
    "lat" double precision NOT NULL,
    "lng" double precision NOT NULL,
    "event_code" "text",
    "last_ping" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '01:00:00'::interval) NOT NULL
);


ALTER TABLE "public"."user_presence" OWNER TO "postgres";


ALTER TABLE ONLY "public"."banned_words"
    ADD CONSTRAINT "banned_words_pkey" PRIMARY KEY ("word");



ALTER TABLE ONLY "public"."binder_collaborators"
    ADD CONSTRAINT "binder_collaborators_pkey" PRIMARY KEY ("binder_id", "user_id");



ALTER TABLE ONLY "public"."binders"
    ADD CONSTRAINT "binders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cards"
    ADD CONSTRAINT "cards_pkey" PRIMARY KEY ("game", "card_code");



ALTER TABLE ONLY "public"."deck_banned_groups"
    ADD CONSTRAINT "deck_banned_groups_pkey" PRIMARY KEY ("group_id", "game", "card_code");



ALTER TABLE ONLY "public"."deck_cards"
    ADD CONSTRAINT "deck_cards_pkey" PRIMARY KEY ("deck_id", "card_code");



ALTER TABLE ONLY "public"."deck_collaborators"
    ADD CONSTRAINT "deck_collaborators_pkey" PRIMARY KEY ("deck_id", "user_id");



ALTER TABLE ONLY "public"."deck_legends"
    ADD CONSTRAINT "deck_legends_pkey" PRIMARY KEY ("deck_id", "card_code");



ALTER TABLE ONLY "public"."deck_rule_exceptions"
    ADD CONSTRAINT "deck_rule_exceptions_pkey" PRIMARY KEY ("game", "card_code");



ALTER TABLE ONLY "public"."decks"
    ADD CONSTRAINT "decks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."listings"
    ADD CONSTRAINT "listings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("user_id");



ALTER TABLE ONLY "public"."rotated_sets"
    ADD CONSTRAINT "rotated_sets_pkey" PRIMARY KEY ("game", "set_prefix");



ALTER TABLE ONLY "public"."rotation_exempt_cards"
    ADD CONSTRAINT "rotation_exempt_cards_pkey" PRIMARY KEY ("game", "card_code");



ALTER TABLE ONLY "public"."trade_tap_history"
    ADD CONSTRAINT "trade_tap_history_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."user_presence"
    ADD CONSTRAINT "user_presence_pkey" PRIMARY KEY ("user_id");



CREATE INDEX "binder_collaborators_user_idx" ON "public"."binder_collaborators" USING "btree" ("user_id");



CREATE UNIQUE INDEX "binders_one_trade_per_user_game" ON "public"."binders" USING "btree" ("user_id", "category") WHERE ("flair" = 'trade'::"text");



CREATE UNIQUE INDEX "binders_one_wishlist_per_user_game" ON "public"."binders" USING "btree" ("user_id", "category") WHERE ("flair" = 'wishlist'::"text");



CREATE INDEX "binders_user_id_idx" ON "public"."binders" USING "btree" ("user_id");



CREATE INDEX "cards_color_idx" ON "public"."cards" USING "btree" ("color");



CREATE INDEX "cards_game_idx" ON "public"."cards" USING "btree" ("game");



CREATE INDEX "cards_game_release_idx" ON "public"."cards" USING "btree" ("game", "release_order" DESC, "card_code");



CREATE INDEX "cards_is_searcher_idx" ON "public"."cards" USING "btree" ((("search_meta" IS NOT NULL)));



CREATE INDEX "cards_ram_idx" ON "public"."cards" USING "btree" ("ram");



CREATE INDEX "cards_release_order_idx" ON "public"."cards" USING "btree" ("release_order" DESC, "card_code");



CREATE INDEX "cards_series_idx" ON "public"."cards" USING "btree" ("series");



CREATE INDEX "cards_type_idx" ON "public"."cards" USING "btree" ("type");



CREATE INDEX "deck_collaborators_user_idx" ON "public"."deck_collaborators" USING "btree" ("user_id");



CREATE INDEX "deck_legends_deck_idx" ON "public"."deck_legends" USING "btree" ("deck_id");



CREATE INDEX "decks_user_idx" ON "public"."decks" USING "btree" ("user_id");



CREATE INDEX "listings_binder_id_idx" ON "public"."listings" USING "btree" ("binder_id");



CREATE INDEX "listings_binder_sort_idx" ON "public"."listings" USING "btree" ("binder_id", "sort_order");



CREATE INDEX "listings_card_code_idx" ON "public"."listings" USING "btree" ("card_code");



CREATE INDEX "listings_deck_idx" ON "public"."listings" USING "btree" ("deck_id") WHERE ("deck_id" IS NOT NULL);



CREATE INDEX "notifications_user_idx" ON "public"."notifications" USING "btree" ("user_id", "created_at" DESC);



CREATE UNIQUE INDEX "one_collaborator_per_binder" ON "public"."binder_collaborators" USING "btree" ("binder_id");



CREATE UNIQUE INDEX "one_collaborator_per_deck" ON "public"."deck_collaborators" USING "btree" ("deck_id");



CREATE UNIQUE INDEX "one_deck_per_leader" ON "public"."decks" USING "btree" ("user_id", "game", "leader_card_code") WHERE ("game" = 'optcg'::"text");



CREATE INDEX "profiles_city_idx" ON "public"."profiles" USING "btree" ("city");



CREATE UNIQUE INDEX "profiles_display_name_unique" ON "public"."profiles" USING "btree" ("lower"("display_name"));



CREATE UNIQUE INDEX "profiles_slug_unique" ON "public"."profiles" USING "btree" ("slug");



CREATE INDEX "trade_tap_history_user_idx" ON "public"."trade_tap_history" USING "btree" ("user_id", "tapped_at" DESC);



CREATE UNIQUE INDEX "trade_tap_history_user_partner_day_idx" ON "public"."trade_tap_history" USING "btree" ("user_id", "partner_user_id", "tapped_on");



CREATE INDEX "user_presence_event_idx" ON "public"."user_presence" USING "btree" ("lower"("event_code")) WHERE ("event_code" IS NOT NULL);



CREATE INDEX "user_presence_expires_idx" ON "public"."user_presence" USING "btree" ("expires_at");



CREATE INDEX "user_presence_geo_idx" ON "public"."user_presence" USING "gist" ("public"."ll_to_earth"("lat", "lng"));



CREATE OR REPLACE TRIGGER "deck_cards_check_art_mix" BEFORE INSERT OR UPDATE ON "public"."deck_cards" FOR EACH ROW EXECUTE FUNCTION "public"."deck_cards_check_art_mix"();



CREATE OR REPLACE TRIGGER "deck_cards_notify_collect" AFTER UPDATE ON "public"."deck_cards" FOR EACH ROW EXECUTE FUNCTION "public"."deck_cards_notify_collect"();



CREATE OR REPLACE TRIGGER "deck_cards_sync_wishlist" AFTER INSERT OR DELETE OR UPDATE ON "public"."deck_cards" FOR EACH ROW EXECUTE FUNCTION "public"."deck_cards_sync_wishlist"();



CREATE OR REPLACE TRIGGER "deck_cards_touch_deck" AFTER INSERT OR DELETE OR UPDATE ON "public"."deck_cards" FOR EACH ROW EXECUTE FUNCTION "public"."deck_cards_touch_deck"();



CREATE OR REPLACE TRIGGER "deck_cards_validate" BEFORE INSERT OR UPDATE ON "public"."deck_cards" FOR EACH ROW EXECUTE FUNCTION "public"."deck_cards_validate"();



CREATE OR REPLACE TRIGGER "deck_legends_touch_deck" AFTER INSERT OR DELETE OR UPDATE ON "public"."deck_legends" FOR EACH ROW EXECUTE FUNCTION "public"."deck_cards_touch_deck"();



CREATE OR REPLACE TRIGGER "deck_legends_validate" BEFORE INSERT OR UPDATE ON "public"."deck_legends" FOR EACH ROW EXECUTE FUNCTION "public"."deck_legends_validate"();



CREATE OR REPLACE TRIGGER "decks_cleanup_wishlist" BEFORE DELETE ON "public"."decks" FOR EACH ROW EXECUTE FUNCTION "public"."decks_cleanup_wishlist"();



CREATE OR REPLACE TRIGGER "decks_enforce_limit" BEFORE INSERT ON "public"."decks" FOR EACH ROW EXECUTE FUNCTION "public"."decks_enforce_limit"();



CREATE OR REPLACE TRIGGER "decks_validate_leader" BEFORE INSERT OR UPDATE ON "public"."decks" FOR EACH ROW EXECUTE FUNCTION "public"."decks_validate_leader"();



CREATE OR REPLACE TRIGGER "profiles_name_cooldown" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."profiles_enforce_name_cooldown"();



CREATE OR REPLACE TRIGGER "profiles_validate_display_name" BEFORE INSERT OR UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."profiles_validate_display_name"();



ALTER TABLE ONLY "public"."binder_collaborators"
    ADD CONSTRAINT "binder_collaborators_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."binder_collaborators"
    ADD CONSTRAINT "binder_collaborators_binder_id_fkey" FOREIGN KEY ("binder_id") REFERENCES "public"."binders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."binder_collaborators"
    ADD CONSTRAINT "binder_collaborators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."binders"
    ADD CONSTRAINT "binders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deck_cards"
    ADD CONSTRAINT "deck_cards_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deck_collaborators"
    ADD CONSTRAINT "deck_collaborators_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."deck_collaborators"
    ADD CONSTRAINT "deck_collaborators_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deck_collaborators"
    ADD CONSTRAINT "deck_collaborators_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deck_legends"
    ADD CONSTRAINT "deck_legends_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."decks"
    ADD CONSTRAINT "decks_game_leader_card_code_fkey" FOREIGN KEY ("game", "leader_card_code") REFERENCES "public"."cards"("game", "card_code");



ALTER TABLE ONLY "public"."decks"
    ADD CONSTRAINT "decks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."listings"
    ADD CONSTRAINT "listings_binder_id_fkey" FOREIGN KEY ("binder_id") REFERENCES "public"."binders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."listings"
    ADD CONSTRAINT "listings_deck_id_fkey" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trade_tap_history"
    ADD CONSTRAINT "trade_tap_history_partner_user_id_fkey" FOREIGN KEY ("partner_user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."trade_tap_history"
    ADD CONSTRAINT "trade_tap_history_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."user_presence"
    ADD CONSTRAINT "user_presence_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE "public"."banned_words" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "binder_collab_delete" ON "public"."binder_collaborators" FOR DELETE USING (((EXISTS ( SELECT 1
   FROM "public"."binders" "b"
  WHERE (("b"."id" = "binder_collaborators"."binder_id") AND ("b"."user_id" = "auth"."uid"())))) OR ("user_id" = "auth"."uid"())));



CREATE POLICY "binder_collab_insert" ON "public"."binder_collaborators" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."binders" "b"
  WHERE (("b"."id" = "binder_collaborators"."binder_id") AND ("b"."user_id" = "auth"."uid"())))));



CREATE POLICY "binder_collab_read" ON "public"."binder_collaborators" FOR SELECT USING ("public"."is_binder_member"("binder_id", "auth"."uid"()));



ALTER TABLE "public"."binder_collaborators" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."binders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "binders_delete" ON "public"."binders" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "binders_insert" ON "public"."binders" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "binders_read" ON "public"."binders" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "binders_update" ON "public"."binders" FOR UPDATE USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."cards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cards_read" ON "public"."cards" FOR SELECT USING (true);



ALTER TABLE "public"."deck_banned_groups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "deck_banned_groups_read" ON "public"."deck_banned_groups" FOR SELECT USING (true);



ALTER TABLE "public"."deck_cards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "deck_cards_select" ON "public"."deck_cards" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "deck_cards"."deck_id") AND ("d"."is_public" OR "public"."is_deck_member"("d"."id", "auth"."uid"()))))));



CREATE POLICY "deck_cards_write" ON "public"."deck_cards" USING ("public"."is_deck_member"("deck_id", "auth"."uid"())) WITH CHECK ("public"."is_deck_member"("deck_id", "auth"."uid"()));



CREATE POLICY "deck_collab_delete" ON "public"."deck_collaborators" FOR DELETE USING (((EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "deck_collaborators"."deck_id") AND ("d"."user_id" = "auth"."uid"())))) OR ("user_id" = "auth"."uid"())));



CREATE POLICY "deck_collab_insert" ON "public"."deck_collaborators" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "deck_collaborators"."deck_id") AND ("d"."user_id" = "auth"."uid"())))));



CREATE POLICY "deck_collab_read" ON "public"."deck_collaborators" FOR SELECT USING ("public"."is_deck_member"("deck_id", "auth"."uid"()));



ALTER TABLE "public"."deck_collaborators" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deck_legends" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "deck_legends_select" ON "public"."deck_legends" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."decks" "d"
  WHERE (("d"."id" = "deck_legends"."deck_id") AND ("d"."is_public" OR "public"."is_deck_member"("d"."id", "auth"."uid"()))))));



CREATE POLICY "deck_legends_write" ON "public"."deck_legends" USING ("public"."is_deck_member"("deck_id", "auth"."uid"())) WITH CHECK ("public"."is_deck_member"("deck_id", "auth"."uid"()));



ALTER TABLE "public"."deck_rule_exceptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "deck_rule_exceptions_read" ON "public"."deck_rule_exceptions" FOR SELECT USING (true);



ALTER TABLE "public"."decks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "decks_delete" ON "public"."decks" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "decks_insert" ON "public"."decks" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "decks_select" ON "public"."decks" FOR SELECT USING (("is_public" OR ("user_id" = "auth"."uid"()) OR "public"."is_deck_member"("id", "auth"."uid"())));



CREATE POLICY "decks_update" ON "public"."decks" FOR UPDATE USING ("public"."is_deck_member"("id", "auth"."uid"()));



ALTER TABLE "public"."listings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "listings_delete" ON "public"."listings" FOR DELETE USING ("public"."is_binder_member"("binder_id", "auth"."uid"()));



CREATE POLICY "listings_insert" ON "public"."listings" FOR INSERT WITH CHECK ("public"."is_binder_member"("binder_id", "auth"."uid"()));



CREATE POLICY "listings_read" ON "public"."listings" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "listings_update" ON "public"."listings" FOR UPDATE USING ("public"."is_binder_member"("binder_id", "auth"."uid"()));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_read" ON "public"."notifications" FOR SELECT USING (("user_id" = "auth"."uid"()));



CREATE POLICY "presence delete own" ON "public"."user_presence" FOR DELETE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_insert" ON "public"."profiles" FOR INSERT WITH CHECK (("auth"."uid"() = "user_id"));



CREATE POLICY "profiles_read" ON "public"."profiles" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "profiles_update" ON "public"."profiles" FOR UPDATE USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."rotated_sets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rotated_sets_read" ON "public"."rotated_sets" FOR SELECT USING (true);



ALTER TABLE "public"."rotation_exempt_cards" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rotation_exempt_cards_read" ON "public"."rotation_exempt_cards" FOR SELECT USING (true);



CREATE POLICY "tap history delete own" ON "public"."trade_tap_history" FOR DELETE USING (("auth"."uid"() = "user_id"));



CREATE POLICY "tap history select own" ON "public"."trade_tap_history" FOR SELECT USING (("auth"."uid"() = "user_id"));



ALTER TABLE "public"."trade_tap_history" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_presence" ENABLE ROW LEVEL SECURITY;




ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";






ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."deck_cards";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."listings";



ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."notifications";



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_in"("cstring") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_in"("cstring") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_in"("cstring") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_in"("cstring") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_out"("public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_out"("public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_out"("public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_out"("public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_recv"("internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_recv"("internal") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_recv"("internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_recv"("internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_send"("public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_send"("public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_send"("public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_send"("public"."cube") TO "service_role";






















































































































































REVOKE ALL ON FUNCTION "public"."binder_collaborators_list"("p_binder_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."binder_collaborators_list"("p_binder_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."binder_collaborators_list"("p_binder_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."binder_collaborators_list"("p_binder_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."card_base_code"("p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."card_base_code"("p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."card_base_code"("p_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."clear_presence"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."clear_presence"() TO "anon";
GRANT ALL ON FUNCTION "public"."clear_presence"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."clear_presence"() TO "service_role";



GRANT ALL ON FUNCTION "public"."colors_overlap"("a" "text", "b" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."colors_overlap"("a" "text", "b" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."colors_overlap"("a" "text", "b" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."contains_banned_word"("p_text" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."contains_banned_word"("p_text" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."contains_banned_word"("p_text" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube"(double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube"(double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."cube"(double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube"(double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube"(double precision) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube"(double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."cube"(double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube"(double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube"(double precision[], double precision[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube"(double precision[], double precision[]) TO "anon";
GRANT ALL ON FUNCTION "public"."cube"(double precision[], double precision[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube"(double precision[], double precision[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube"(double precision, double precision) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube"(double precision, double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."cube"(double precision, double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube"(double precision, double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube"("public"."cube", double precision) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube"("public"."cube", double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."cube"("public"."cube", double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube"("public"."cube", double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube"("public"."cube", double precision, double precision) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube"("public"."cube", double precision, double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."cube"("public"."cube", double precision, double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube"("public"."cube", double precision, double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_cmp"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_cmp"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_cmp"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_cmp"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_contained"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_contained"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_contained"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_contained"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_contains"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_contains"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_contains"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_contains"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_coord"("public"."cube", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_coord"("public"."cube", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."cube_coord"("public"."cube", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_coord"("public"."cube", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_coord_llur"("public"."cube", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_coord_llur"("public"."cube", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."cube_coord_llur"("public"."cube", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_coord_llur"("public"."cube", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_dim"("public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_dim"("public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_dim"("public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_dim"("public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_distance"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_distance"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_distance"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_distance"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_enlarge"("public"."cube", double precision, integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_enlarge"("public"."cube", double precision, integer) TO "anon";
GRANT ALL ON FUNCTION "public"."cube_enlarge"("public"."cube", double precision, integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_enlarge"("public"."cube", double precision, integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_eq"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_eq"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_eq"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_eq"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_ge"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_ge"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_ge"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_ge"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_gt"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_gt"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_gt"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_gt"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_inter"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_inter"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_inter"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_inter"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_is_point"("public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_is_point"("public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_is_point"("public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_is_point"("public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_le"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_le"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_le"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_le"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_ll_coord"("public"."cube", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_ll_coord"("public"."cube", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."cube_ll_coord"("public"."cube", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_ll_coord"("public"."cube", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_lt"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_lt"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_lt"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_lt"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_ne"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_ne"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_ne"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_ne"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_overlap"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_overlap"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_overlap"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_overlap"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_size"("public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_size"("public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_size"("public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_size"("public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_subset"("public"."cube", integer[]) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_subset"("public"."cube", integer[]) TO "anon";
GRANT ALL ON FUNCTION "public"."cube_subset"("public"."cube", integer[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_subset"("public"."cube", integer[]) TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_union"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_union"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."cube_union"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_union"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."cube_ur_coord"("public"."cube", integer) TO "postgres";
GRANT ALL ON FUNCTION "public"."cube_ur_coord"("public"."cube", integer) TO "anon";
GRANT ALL ON FUNCTION "public"."cube_ur_coord"("public"."cube", integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."cube_ur_coord"("public"."cube", integer) TO "service_role";



GRANT ALL ON FUNCTION "public"."cyberpunk_deck_validity"("p_deck_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."cyberpunk_deck_validity"("p_deck_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."cyberpunk_deck_validity"("p_deck_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deck_cards_check_art_mix"() TO "anon";
GRANT ALL ON FUNCTION "public"."deck_cards_check_art_mix"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_cards_check_art_mix"() TO "service_role";



GRANT ALL ON FUNCTION "public"."deck_cards_notify_collect"() TO "anon";
GRANT ALL ON FUNCTION "public"."deck_cards_notify_collect"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_cards_notify_collect"() TO "service_role";



GRANT ALL ON FUNCTION "public"."deck_cards_sync_wishlist"() TO "anon";
GRANT ALL ON FUNCTION "public"."deck_cards_sync_wishlist"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_cards_sync_wishlist"() TO "service_role";



GRANT ALL ON FUNCTION "public"."deck_cards_touch_deck"() TO "anon";
GRANT ALL ON FUNCTION "public"."deck_cards_touch_deck"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_cards_touch_deck"() TO "service_role";



GRANT ALL ON FUNCTION "public"."deck_cards_validate"() TO "anon";
GRANT ALL ON FUNCTION "public"."deck_cards_validate"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_cards_validate"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."deck_collaborators_list"("p_deck_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deck_collaborators_list"("p_deck_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deck_collaborators_list"("p_deck_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_collaborators_list"("p_deck_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deck_legends_validate"() TO "anon";
GRANT ALL ON FUNCTION "public"."deck_legends_validate"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_legends_validate"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."deck_pending_invite"("p_deck_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deck_pending_invite"("p_deck_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deck_pending_invite"("p_deck_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_pending_invite"("p_deck_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."deck_trade_partner"("p_deck_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."deck_trade_partner"("p_deck_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deck_trade_partner"("p_deck_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_trade_partner"("p_deck_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."deck_validity"("p_deck_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."deck_validity"("p_deck_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."deck_validity"("p_deck_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."decks_cleanup_wishlist"() TO "anon";
GRANT ALL ON FUNCTION "public"."decks_cleanup_wishlist"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."decks_cleanup_wishlist"() TO "service_role";



GRANT ALL ON FUNCTION "public"."decks_enforce_limit"() TO "anon";
GRANT ALL ON FUNCTION "public"."decks_enforce_limit"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."decks_enforce_limit"() TO "service_role";



GRANT ALL ON FUNCTION "public"."decks_validate_leader"() TO "anon";
GRANT ALL ON FUNCTION "public"."decks_validate_leader"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."decks_validate_leader"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."dismiss_notification"("p_notification_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."dismiss_notification"("p_notification_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."dismiss_notification"("p_notification_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."dismiss_notification"("p_notification_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."display_name_acceptable"("p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."display_name_acceptable"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."display_name_acceptable"("p_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."display_name_available"("p_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."display_name_available"("p_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."display_name_available"("p_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."distance_chebyshev"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."distance_chebyshev"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."distance_chebyshev"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."distance_chebyshev"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."distance_taxicab"("public"."cube", "public"."cube") TO "postgres";
GRANT ALL ON FUNCTION "public"."distance_taxicab"("public"."cube", "public"."cube") TO "anon";
GRANT ALL ON FUNCTION "public"."distance_taxicab"("public"."cube", "public"."cube") TO "authenticated";
GRANT ALL ON FUNCTION "public"."distance_taxicab"("public"."cube", "public"."cube") TO "service_role";



GRANT ALL ON FUNCTION "public"."earth"() TO "postgres";
GRANT ALL ON FUNCTION "public"."earth"() TO "anon";
GRANT ALL ON FUNCTION "public"."earth"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."earth"() TO "service_role";



GRANT ALL ON FUNCTION "public"."gc_to_sec"(double precision) TO "postgres";
GRANT ALL ON FUNCTION "public"."gc_to_sec"(double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."gc_to_sec"(double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."gc_to_sec"(double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."earth_box"("public"."earth", double precision) TO "postgres";
GRANT ALL ON FUNCTION "public"."earth_box"("public"."earth", double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."earth_box"("public"."earth", double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."earth_box"("public"."earth", double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."sec_to_gc"(double precision) TO "postgres";
GRANT ALL ON FUNCTION "public"."sec_to_gc"(double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."sec_to_gc"(double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."sec_to_gc"(double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."earth_distance"("public"."earth", "public"."earth") TO "postgres";
GRANT ALL ON FUNCTION "public"."earth_distance"("public"."earth", "public"."earth") TO "anon";
GRANT ALL ON FUNCTION "public"."earth_distance"("public"."earth", "public"."earth") TO "authenticated";
GRANT ALL ON FUNCTION "public"."earth_distance"("public"."earth", "public"."earth") TO "service_role";



GRANT ALL ON FUNCTION "public"."g_cube_consistent"("internal", "public"."cube", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."g_cube_consistent"("internal", "public"."cube", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."g_cube_consistent"("internal", "public"."cube", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."g_cube_consistent"("internal", "public"."cube", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."g_cube_distance"("internal", "public"."cube", smallint, "oid", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."g_cube_distance"("internal", "public"."cube", smallint, "oid", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."g_cube_distance"("internal", "public"."cube", smallint, "oid", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."g_cube_distance"("internal", "public"."cube", smallint, "oid", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."g_cube_penalty"("internal", "internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."g_cube_penalty"("internal", "internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."g_cube_penalty"("internal", "internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."g_cube_penalty"("internal", "internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."g_cube_picksplit"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."g_cube_picksplit"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."g_cube_picksplit"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."g_cube_picksplit"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."g_cube_same"("public"."cube", "public"."cube", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."g_cube_same"("public"."cube", "public"."cube", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."g_cube_same"("public"."cube", "public"."cube", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."g_cube_same"("public"."cube", "public"."cube", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."g_cube_union"("internal", "internal") TO "postgres";
GRANT ALL ON FUNCTION "public"."g_cube_union"("internal", "internal") TO "anon";
GRANT ALL ON FUNCTION "public"."g_cube_union"("internal", "internal") TO "authenticated";
GRANT ALL ON FUNCTION "public"."g_cube_union"("internal", "internal") TO "service_role";



GRANT ALL ON FUNCTION "public"."geo_distance"("point", "point") TO "postgres";
GRANT ALL ON FUNCTION "public"."geo_distance"("point", "point") TO "anon";
GRANT ALL ON FUNCTION "public"."geo_distance"("point", "point") TO "authenticated";
GRANT ALL ON FUNCTION "public"."geo_distance"("point", "point") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_binder_listings_public"("p_binder_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_binder_listings_public"("p_binder_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_binder_listings_public"("p_binder_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_binder_listings_public"("p_binder_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_binder_public"("p_binder_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_binder_public"("p_binder_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_binder_public"("p_binder_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_binder_public"("p_binder_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_identity"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_identity"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_identity"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_binder_member"("p_binder_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_binder_member"("p_binder_id" "uuid", "p_uid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_binder_member"("p_binder_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_binder_member"("p_binder_id" "uuid", "p_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_deck_member"("p_deck_id" "uuid", "p_uid" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_deck_member"("p_deck_id" "uuid", "p_uid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_deck_member"("p_deck_id" "uuid", "p_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_deck_member"("p_deck_id" "uuid", "p_uid" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."latitude"("public"."earth") TO "postgres";
GRANT ALL ON FUNCTION "public"."latitude"("public"."earth") TO "anon";
GRANT ALL ON FUNCTION "public"."latitude"("public"."earth") TO "authenticated";
GRANT ALL ON FUNCTION "public"."latitude"("public"."earth") TO "service_role";



GRANT ALL ON FUNCTION "public"."ll_to_earth"(double precision, double precision) TO "postgres";
GRANT ALL ON FUNCTION "public"."ll_to_earth"(double precision, double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."ll_to_earth"(double precision, double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."ll_to_earth"(double precision, double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."longitude"("public"."earth") TO "postgres";
GRANT ALL ON FUNCTION "public"."longitude"("public"."earth") TO "anon";
GRANT ALL ON FUNCTION "public"."longitude"("public"."earth") TO "authenticated";
GRANT ALL ON FUNCTION "public"."longitude"("public"."earth") TO "service_role";



REVOKE ALL ON FUNCTION "public"."mark_notifications_read"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."mark_notifications_read"() TO "anon";
GRANT ALL ON FUNCTION "public"."mark_notifications_read"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."mark_notifications_read"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."nearby_trade_binders"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."nearby_trade_binders"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."nearby_trade_binders"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."nearby_trade_binders"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."nearby_wishlist_matches"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."nearby_wishlist_matches"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."nearby_wishlist_matches"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."nearby_wishlist_matches"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."normalize_for_moderation"("s" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."normalize_for_moderation"("s" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."normalize_for_moderation"("s" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."profiles_enforce_name_cooldown"() TO "anon";
GRANT ALL ON FUNCTION "public"."profiles_enforce_name_cooldown"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."profiles_enforce_name_cooldown"() TO "service_role";



GRANT ALL ON FUNCTION "public"."profiles_validate_display_name"() TO "anon";
GRANT ALL ON FUNCTION "public"."profiles_validate_display_name"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."profiles_validate_display_name"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."prune_notifications"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."prune_notifications"() TO "anon";
GRANT ALL ON FUNCTION "public"."prune_notifications"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."prune_notifications"() TO "service_role";



GRANT ALL ON FUNCTION "public"."publish_deck"("p_deck_id" "uuid", "p_listing_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."publish_deck"("p_deck_id" "uuid", "p_listing_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."publish_deck"("p_deck_id" "uuid", "p_listing_type" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."record_trade_tap"("p_partner_user_id" "uuid", "p_match_count" integer) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."record_trade_tap"("p_partner_user_id" "uuid", "p_match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."record_trade_tap"("p_partner_user_id" "uuid", "p_match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."record_trade_tap"("p_partner_user_id" "uuid", "p_match_count" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."rescind_deck_invite"("p_deck_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."rescind_deck_invite"("p_deck_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."rescind_deck_invite"("p_deck_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."rescind_deck_invite"("p_deck_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."resolve_binder_slug"("p_slug" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resolve_binder_slug"("p_slug" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_binder_slug"("p_slug" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_binder_slug"("p_slug" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."respond_binder_invite"("p_notification_id" "uuid", "p_accept" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."respond_binder_invite"("p_notification_id" "uuid", "p_accept" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."respond_binder_invite"("p_notification_id" "uuid", "p_accept" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."respond_binder_invite"("p_notification_id" "uuid", "p_accept" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."respond_deck_invite"("p_notification_id" "uuid", "p_accept" boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."respond_deck_invite"("p_notification_id" "uuid", "p_accept" boolean) TO "anon";
GRANT ALL ON FUNCTION "public"."respond_deck_invite"("p_notification_id" "uuid", "p_accept" boolean) TO "authenticated";
GRANT ALL ON FUNCTION "public"."respond_deck_invite"("p_notification_id" "uuid", "p_accept" boolean) TO "service_role";



REVOKE ALL ON FUNCTION "public"."resync_deck_member_wishlist"("p_deck_id" "uuid", "p_member" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."resync_deck_member_wishlist"("p_deck_id" "uuid", "p_member" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."resync_deck_member_wishlist"("p_deck_id" "uuid", "p_member" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resync_deck_member_wishlist"("p_deck_id" "uuid", "p_member" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."search_binders"("p_boroughs" "text"[], "p_subways" "text"[], "p_shop" "text", "p_category" "text", "p_city" "text", "p_card_codes" "text"[]) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."search_binders"("p_boroughs" "text"[], "p_subways" "text"[], "p_shop" "text", "p_category" "text", "p_city" "text", "p_card_codes" "text"[]) TO "anon";
GRANT ALL ON FUNCTION "public"."search_binders"("p_boroughs" "text"[], "p_subways" "text"[], "p_shop" "text", "p_category" "text", "p_city" "text", "p_card_codes" "text"[]) TO "authenticated";
GRANT ALL ON FUNCTION "public"."search_binders"("p_boroughs" "text"[], "p_subways" "text"[], "p_shop" "text", "p_category" "text", "p_city" "text", "p_card_codes" "text"[]) TO "service_role";



REVOKE ALL ON FUNCTION "public"."share_binder"("p_binder_id" "uuid", "p_display_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."share_binder"("p_binder_id" "uuid", "p_display_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."share_binder"("p_binder_id" "uuid", "p_display_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."share_binder"("p_binder_id" "uuid", "p_display_name" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."share_deck"("p_deck_id" "uuid", "p_display_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."share_deck"("p_deck_id" "uuid", "p_display_name" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."share_deck"("p_deck_id" "uuid", "p_display_name" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."share_deck"("p_deck_id" "uuid", "p_display_name" "text") TO "service_role";



GRANT ALL ON TABLE "public"."binders" TO "anon";
GRANT ALL ON TABLE "public"."binders" TO "authenticated";
GRANT ALL ON TABLE "public"."binders" TO "service_role";



REVOKE ALL ON FUNCTION "public"."shared_binders"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."shared_binders"() TO "anon";
GRANT ALL ON FUNCTION "public"."shared_binders"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."shared_binders"() TO "service_role";



GRANT ALL ON TABLE "public"."decks" TO "anon";
GRANT ALL ON TABLE "public"."decks" TO "authenticated";
GRANT ALL ON TABLE "public"."decks" TO "service_role";



REVOKE ALL ON FUNCTION "public"."shared_decks"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."shared_decks"() TO "anon";
GRANT ALL ON FUNCTION "public"."shared_decks"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."shared_decks"() TO "service_role";



GRANT ALL ON FUNCTION "public"."slugify"("s" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."slugify"("s" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."slugify"("s" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."standard_legal"("p_game" "text", "p_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."standard_legal"("p_game" "text", "p_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."standard_legal"("p_game" "text", "p_code" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."trade_matches"("p_partner_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."trade_matches"("p_partner_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."trade_matches"("p_partner_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."trade_matches"("p_partner_user_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."unpublish_deck"("p_deck_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."unpublish_deck"("p_deck_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unpublish_deck"("p_deck_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."unshare_binder"("p_binder_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unshare_binder"("p_binder_id" "uuid", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."unshare_binder"("p_binder_id" "uuid", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unshare_binder"("p_binder_id" "uuid", "p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."unshare_deck"("p_deck_id" "uuid", "p_user_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."unshare_deck"("p_deck_id" "uuid", "p_user_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."unshare_deck"("p_deck_id" "uuid", "p_user_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."unshare_deck"("p_deck_id" "uuid", "p_user_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."upsert_presence"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."upsert_presence"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."upsert_presence"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."upsert_presence"("p_lat" double precision, "p_lng" double precision, "p_event_code" "text") TO "service_role";


















GRANT ALL ON TABLE "public"."banned_words" TO "anon";
GRANT ALL ON TABLE "public"."banned_words" TO "authenticated";
GRANT ALL ON TABLE "public"."banned_words" TO "service_role";



GRANT ALL ON TABLE "public"."binder_collaborators" TO "anon";
GRANT ALL ON TABLE "public"."binder_collaborators" TO "authenticated";
GRANT ALL ON TABLE "public"."binder_collaborators" TO "service_role";



GRANT ALL ON TABLE "public"."cards" TO "anon";
GRANT ALL ON TABLE "public"."cards" TO "authenticated";
GRANT ALL ON TABLE "public"."cards" TO "service_role";



GRANT ALL ON TABLE "public"."deck_banned_groups" TO "anon";
GRANT ALL ON TABLE "public"."deck_banned_groups" TO "authenticated";
GRANT ALL ON TABLE "public"."deck_banned_groups" TO "service_role";



GRANT ALL ON TABLE "public"."deck_cards" TO "anon";
GRANT ALL ON TABLE "public"."deck_cards" TO "authenticated";
GRANT ALL ON TABLE "public"."deck_cards" TO "service_role";



GRANT ALL ON TABLE "public"."deck_collaborators" TO "anon";
GRANT ALL ON TABLE "public"."deck_collaborators" TO "authenticated";
GRANT ALL ON TABLE "public"."deck_collaborators" TO "service_role";



GRANT ALL ON TABLE "public"."deck_legends" TO "anon";
GRANT ALL ON TABLE "public"."deck_legends" TO "authenticated";
GRANT ALL ON TABLE "public"."deck_legends" TO "service_role";



GRANT ALL ON TABLE "public"."deck_rule_exceptions" TO "anon";
GRANT ALL ON TABLE "public"."deck_rule_exceptions" TO "authenticated";
GRANT ALL ON TABLE "public"."deck_rule_exceptions" TO "service_role";



GRANT ALL ON TABLE "public"."listings" TO "anon";
GRANT ALL ON TABLE "public"."listings" TO "authenticated";
GRANT ALL ON TABLE "public"."listings" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."rotated_sets" TO "anon";
GRANT ALL ON TABLE "public"."rotated_sets" TO "authenticated";
GRANT ALL ON TABLE "public"."rotated_sets" TO "service_role";



GRANT ALL ON TABLE "public"."rotation_exempt_cards" TO "anon";
GRANT ALL ON TABLE "public"."rotation_exempt_cards" TO "authenticated";
GRANT ALL ON TABLE "public"."rotation_exempt_cards" TO "service_role";



GRANT ALL ON TABLE "public"."trade_tap_history" TO "anon";
GRANT ALL ON TABLE "public"."trade_tap_history" TO "authenticated";
GRANT ALL ON TABLE "public"."trade_tap_history" TO "service_role";



GRANT ALL ON TABLE "public"."user_presence" TO "anon";
GRANT ALL ON TABLE "public"."user_presence" TO "authenticated";
GRANT ALL ON TABLE "public"."user_presence" TO "service_role";









ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";































