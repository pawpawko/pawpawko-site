-- ============================================================
-- Deck art composition — deck_cards.art_mix
-- ============================================================
-- Decks keep ONE row per BASE card code (locked invariant: the 4-copy rule,
-- deck_validity, and wishlist sync all count by base). art_mix annotates that
-- row with which physical copies are alt-art prints:
--
--   art_mix = {"OP01-025_p1": 2}   -- an x4 stack = 2 base + 2 alt
--
-- Base copies are implied (quantity - sum of values); '{}' = all base.
-- Rules/validity/wishlist are untouched — this is a pure annotation.
--
-- Guardrails (trigger below):
--   * every key must be an alt print of the row's base code AND exist in cards
--   * values are positive integers (zero/negative entries are dropped)
--   * the mix never exceeds quantity — on qty decrease it clamps,
--     shedding alt assignments largest-count-first
--
-- Apply in the Supabase SQL editor. Idempotent, safe to re-run.
-- ============================================================

alter table public.deck_cards
  add column if not exists art_mix jsonb not null default '{}'::jsonb;

create or replace function public.deck_cards_check_art_mix()
returns trigger
language plpgsql
as $$
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

drop trigger if exists deck_cards_check_art_mix on public.deck_cards;
create trigger deck_cards_check_art_mix
  before insert or update on public.deck_cards
  for each row execute function public.deck_cards_check_art_mix();
