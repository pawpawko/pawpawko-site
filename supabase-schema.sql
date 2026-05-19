-- ============================================================
-- Pawpaw Ko — Trades feature schema (one binder per user)
-- Paste this entire file into the Supabase SQL editor and run it.
-- ============================================================
-- If you ran an earlier version of this schema, uncomment the
-- teardown block below first to clean up old tables.

-- ---------- TEARDOWN (only if rerunning) ----------
-- drop table if exists public.listings cascade;
-- drop table if exists public.binders  cascade;
-- drop table if exists public.cards    cascade;
-- drop table if exists public.profiles cascade;
-- drop function if exists public.handle_new_user() cascade;

-- ---------- TABLES ----------

create table if not exists public.profiles (
  user_id            uuid primary key references auth.users on delete cascade,
  display_name       text not null,
  discord_handle     text,
  binder_name        text not null default 'My Binder',
  binder_description text,
  boroughs           text[] default '{}',     -- e.g. {'Brooklyn','Queens'}
  subway_stops       text[] default '{}',     -- e.g. {'Bedford Av','Atlantic Av-Barclays Ctr'}
  local_shops        text[] default '{}',     -- free-text shop names
  created_at         timestamptz default now()
);

create table if not exists public.cards (
  card_code    text primary key,          -- e.g. 'OP01-001'
  name         text not null,
  series       text,                      -- e.g. 'OP-01 Romance Dawn'
  color        text,                      -- Red/Blue/Green/Purple/Black/Yellow
  type         text,                      -- Leader/Character/Event/Stage/Don
  cost         int,
  power        int,
  counter      int,
  attribute    text,                      -- Slash/Strike/Special/Wisdom/Ranged
  trigger_text text,
  rarity       text,                      -- L/C/UC/R/SR/SEC/etc.
  effect_text  text,
  image_url    text,
  image_url_lg text
);

create index if not exists cards_color_idx  on public.cards(color);
create index if not exists cards_type_idx   on public.cards(type);
create index if not exists cards_series_idx on public.cards(series);

-- Release-order column: higher integer = newer set. Sort DESC for newest-first.
-- Numbers are clustered by approximate EN release window; ties broken by card_code.
alter table public.cards add column if not exists release_order int default 0;
alter table public.cards add column if not exists image_url_lg text;
create index if not exists cards_release_order_idx on public.cards(release_order desc, card_code);

-- Backfill (idempotent — re-run safe)
update public.cards set release_order = case
  when card_code like 'OP15%'  then 30
  when card_code like 'OP14%'  then 29
  when card_code like 'EB04%'  then 28
  when card_code like 'PRB02%' then 28
  when card_code like 'ST29%'  then 28
  when card_code like 'OP13%'  then 27
  when card_code like 'ST28%'  then 27
  when card_code like 'ST27%'  then 26
  when card_code like 'ST26%'  then 25
  when card_code like 'EB03%'  then 24
  when card_code like 'OP12%'  then 24
  when card_code like 'ST25%'  then 24
  when card_code like 'ST24%'  then 23
  when card_code like 'ST23%'  then 22
  when card_code like 'OP11%'  then 21
  when card_code like 'EB02%'  then 20
  when card_code like 'ST22%'  then 20
  when card_code like 'ST21%'  then 19
  when card_code like 'OP10%'  then 18
  when card_code like 'ST20%'  then 18
  when card_code like 'ST19%'  then 17
  when card_code like 'PRB01%' then 16
  when card_code like 'ST18%'  then 16
  when card_code like 'OP09%'  then 15
  when card_code like 'ST17%'  then 15
  when card_code like 'ST16%'  then 14
  when card_code like 'EB01%'  then 13
  when card_code like 'ST15%'  then 13
  when card_code like 'OP08%'  then 12
  when card_code like 'ST14%'  then 12
  when card_code like 'ST13%'  then 11
  when card_code like 'OP07%'  then 10
  when card_code like 'ST12%'  then 10
  when card_code like 'ST11%'  then 9
  when card_code like 'OP06%'  then 8
  when card_code like 'ST10%'  then 7
  when card_code like 'OP05%'  then 6
  when card_code like 'ST09%'  then 6
  when card_code like 'OP04%'  then 5
  when card_code like 'ST08%'  then 5
  when card_code like 'ST07%'  then 5
  when card_code like 'ST06%'  then 4
  when card_code like 'OP03%'  then 3
  when card_code like 'ST05%'  then 3
  when card_code like 'OP02%'  then 2
  when card_code like 'ST04%'  then 2
  when card_code like 'OP01%'  then 1
  when card_code like 'ST03%'  then 1
  when card_code like 'ST02%'  then 1
  when card_code like 'ST01%'  then 1
  else 0   -- P (promotional) and any unknown prefix
end;

create table if not exists public.listings (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users on delete cascade,
  card_code    text not null references public.cards,
  quantity     int  not null check (quantity > 0),
  listing_type text not null check (listing_type in ('trade','sell','free','combo')),
  notes        text,
  created_at   timestamptz default now()
);

-- Legacy listings.user_id index — only meaningful while the column
-- exists. The multi-binder migration further down drops the column;
-- guarding this avoids "column user_id does not exist" on re-runs.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'listings' and column_name = 'user_id'
  ) then
    execute 'create index if not exists listings_user_id_idx on public.listings(user_id)';
  end if;
end $$;
create index if not exists listings_card_code_idx on public.listings(card_code);

-- ---------- ROW LEVEL SECURITY ----------

alter table public.profiles enable row level security;
alter table public.cards    enable row level security;
alter table public.listings enable row level security;

-- profiles: only AUTHENTICATED users can read (anon goes through RPCs below)
drop policy if exists "profiles_read"   on public.profiles;
drop policy if exists "profiles_insert" on public.profiles;
drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_read"   on public.profiles for select using (auth.role() = 'authenticated');
create policy "profiles_insert" on public.profiles for insert with check (auth.uid() = user_id);
create policy "profiles_update" on public.profiles for update using (auth.uid() = user_id);

-- cards: anyone can read; writes only via service role (admin import)
drop policy if exists "cards_read" on public.cards;
create policy "cards_read" on public.cards for select using (true);

-- listings: only AUTHENTICATED users can read raw rows; owner writes.
-- The owner-write policies below reference `user_id`, which the
-- multi-binder migration further down drops and replaces with
-- binder-scoped policies. On a re-run those statements would fail
-- ("column user_id does not exist"), so they're guarded to run only
-- while the legacy column is still present. The binder-scoped policies
-- are (re)created later in the multi-binder section.
drop policy if exists "listings_read" on public.listings;
create policy "listings_read" on public.listings for select using (auth.role() = 'authenticated');

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'listings' and column_name = 'user_id'
  ) then
    execute 'drop policy if exists "listings_insert" on public.listings';
    execute 'drop policy if exists "listings_update" on public.listings';
    execute 'drop policy if exists "listings_delete" on public.listings';
    execute 'create policy "listings_insert" on public.listings for insert with check (auth.uid() = user_id)';
    execute 'create policy "listings_update" on public.listings for update using (auth.uid() = user_id)';
    execute 'create policy "listings_delete" on public.listings for delete using (auth.uid() = user_id)';
  end if;
end $$;

-- (Older per-user RPCs removed — multi-binder versions defined further below.)

-- ---------- SLUG (URL-safe identifier per binder) ----------

create or replace function public.slugify(s text) returns text
language sql immutable as $$
  select regexp_replace(
    lower(regexp_replace(coalesce(s, ''), '[^a-zA-Z0-9]+', '-', 'g')),
    '^-+|-+$', '', 'g'
  );
$$;

alter table public.profiles
  add column if not exists slug text generated always as (
    public.slugify(display_name) || '_' || public.slugify(binder_name)
  ) stored;

create unique index if not exists profiles_slug_unique on public.profiles(slug);

-- Case-insensitive unique display name across all users.
create unique index if not exists profiles_display_name_unique on public.profiles(lower(display_name));

-- Track when display_name was last changed; used to enforce the 90-day
-- cooldown between renames. Defaults to now() for fresh rows; backfill
-- existing rows to now() so the first-change clock starts when this
-- migration runs.
alter table public.profiles
  add column if not exists display_name_changed_at timestamptz not null default now();

-- Enforce the 90-day cooldown on display_name changes at the DB level
-- (so a bypassed client can't sidestep it). On an actual name change,
-- raise if it's been less than 90 days; otherwise stamp the change time.
create or replace function public.profiles_enforce_name_cooldown()
returns trigger language plpgsql as $$
begin
  if new.display_name is distinct from old.display_name then
    if old.display_name_changed_at is not null
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

drop trigger if exists profiles_name_cooldown on public.profiles;
create trigger profiles_name_cooldown
  before update on public.profiles
  for each row execute procedure public.profiles_enforce_name_cooldown();

-- Flag indicating the user has confirmed their display name (saved the
-- profile form at least once). New rows start `false` — the signup
-- trigger pre-fills `display_name` from the email prefix, so a non-null
-- value alone doesn't prove the user picked a real name. The site-wide
-- gate (see js/main.js) blocks navigation until this flips to `true`.
-- The DO-block backfill runs only when the column is first added, so
-- existing accounts aren't relocked when the schema is re-applied.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
      and column_name = 'display_name_set'
  ) then
    alter table public.profiles add column display_name_set boolean not null default false;
    update public.profiles set display_name_set = true;
  end if;
end $$;

-- Availability check for the display-name field. Returns true if no other
-- user currently owns the name (case-insensitive). The caller's own row
-- is excluded so the profile editor doesn't flag the saved name as taken.
-- SECURITY DEFINER so anon (the signup form) can call it without needing
-- read access to public.profiles.
create or replace function public.display_name_available(p_name text)
returns boolean
language sql stable security definer set search_path = public as $$
  select not exists (
    select 1
    from public.profiles
    where lower(display_name) = lower(trim(p_name))
      and user_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
  );
$$;
grant execute on function public.display_name_available(text) to anon, authenticated;

-- ---------- DISPLAY-NAME CONTENT MODERATION ----------
-- Block slurs, racial epithets, and other clearly offensive terms from
-- display names. Implemented as a substring match against the
-- `banned_words` table after normalizing the candidate name (lowercase,
-- common leet substitutions, strip everything except letters) so users
-- can't bypass with spaces, punctuation, or simple character swaps.
--
-- The banned-words list is data, not code — extend it with
-- `insert into public.banned_words (word) values ('something');` from
-- the SQL editor (uses the service role, bypassing RLS).
-- A maintained starter list is available at
--   https://github.com/LDNOOBW/List-of-Dirty-Naughty-Obscene-and-Otherwise-Bad-Words
-- which can be imported directly.

create table if not exists public.banned_words (
  word text primary key   -- store in the same normalized form (lowercase letters only)
);
alter table public.banned_words enable row level security;
-- No SELECT/INSERT/UPDATE/DELETE policies for anon or authenticated:
-- the table is only writable/readable by the service role. The
-- moderation functions below are SECURITY DEFINER so the public-facing
-- pre-check still works.

-- Normalize a string for content matching. Lowercases, substitutes
-- common leet characters for the letters they imitate, then strips
-- everything but a–z. "@$$h0le" → "asshole", "n  i g  g 3 r" → "nigger".
create or replace function public.normalize_for_moderation(s text)
returns text
language sql immutable as $$
  select regexp_replace(
    translate(
      lower(coalesce(s, '')),
      '@$013457!|',
      'asoieastii'
    ),
    '[^a-z]+', '', 'g'
  );
$$;

-- True if any banned word appears as a substring of the normalized
-- input. STABLE since it reads banned_words.
create or replace function public.contains_banned_word(p_text text)
returns boolean
language plpgsql stable security definer set search_path = public as $$
declare
  normalized text := public.normalize_for_moderation(p_text);
begin
  if normalized = '' then return false; end if;
  return exists (
    select 1 from public.banned_words
    where word <> '' and position(word in normalized) > 0
  );
end; $$;

-- Public pre-check used by the signup form and profile editor. Returns
-- true when the name is acceptable.
create or replace function public.display_name_acceptable(p_name text)
returns boolean
language sql stable security definer set search_path = public as $$
  select not public.contains_banned_word(p_name);
$$;
grant execute on function public.display_name_acceptable(text) to anon, authenticated;

-- Server-side enforcement: reject inserts/updates whose display_name
-- contains a banned word. Belt and braces with the client pre-check —
-- a bypassed client still can't sneak a slur into the table.
create or replace function public.profiles_validate_display_name()
returns trigger language plpgsql as $$
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

drop trigger if exists profiles_validate_display_name on public.profiles;
create trigger profiles_validate_display_name
  before insert or update on public.profiles
  for each row execute procedure public.profiles_validate_display_name();

-- Starter seed. Idempotent; expand by inserting more rows. Words must be
-- already normalized (lowercase letters only — no spaces, numbers, or
-- punctuation), since matching happens against the normalized form of
-- the candidate name. To import the LDNOOBW list, run the project's
-- `scripts/import_banned_words.py` (or COPY directly from the source
-- text file after stripping non-letters).
insert into public.banned_words (word) values
  ('nigger'), ('nigga'),
  ('faggot'), ('fag'),
  ('retard'), ('retarded'),
  ('tranny'),
  ('chink'), ('gook'),
  ('spic'), ('wetback'),
  ('kike'),
  ('coon'),
  ('beaner'),
  ('cracker'),
  ('cunt')
on conflict (word) do nothing;

-- (Earlier get_binder_by_slug RPC removed — superseded by multi-binder design.)

-- ---------- USER CUSTOMIZATIONS (sleeve image, binder background) ----------

alter table public.profiles add column if not exists sleeve_image_url text;
alter table public.profiles add column if not exists binder_background_url text;

-- Public bucket for user-uploaded sleeve / background images
insert into storage.buckets (id, name, public)
values ('binder-customs', 'binder-customs', true)
on conflict (id) do nothing;

-- Storage RLS: anyone can read; only the owner can upload/update/delete
-- (file path must start with the user's auth.uid())
drop policy if exists "binder_customs_read"   on storage.objects;
drop policy if exists "binder_customs_insert" on storage.objects;
drop policy if exists "binder_customs_update" on storage.objects;
drop policy if exists "binder_customs_delete" on storage.objects;

create policy "binder_customs_read"
  on storage.objects for select
  using (bucket_id = 'binder-customs');

create policy "binder_customs_insert"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'binder-customs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "binder_customs_update"
  on storage.objects for update to authenticated
  using (
    bucket_id = 'binder-customs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "binder_customs_delete"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'binder-customs'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- (Older intermediate versions of get_binder_by_slug and get_binder_public —
--  superseded by the multi-binder versions below.)

-- ============================================================
-- MULTI-BINDER MIGRATION (each user can own many binders)
-- Idempotent: safe to re-run.
-- ============================================================

create table if not exists public.binders (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users on delete cascade,
  name                   text not null default 'My Binder',
  description            text,
  sleeve_image_url       text,
  binder_background_url  text,
  created_at             timestamptz default now()
);
create index if not exists binders_user_id_idx on public.binders(user_id);

alter table public.binders add column if not exists flair text not null default 'trade';
alter table public.binders add column if not exists category text not null default 'optcg' check (category in ('optcg','pokemon'));
alter table public.binders add column if not exists layout text not null default '4x3' check (layout in ('4x3','3x3'));

-- At most one Trade Binder and one Wishlist Binder per user per game.
-- Partial unique indexes — other flair types (flex, lgs, future) are
-- unrestricted. Drop these indexes if/when the restriction is relaxed.
create unique index if not exists binders_one_trade_per_user_game
  on public.binders (user_id, category) where flair = 'trade';
create unique index if not exists binders_one_wishlist_per_user_game
  on public.binders (user_id, category) where flair = 'wishlist';

alter table public.binders enable row level security;
drop policy if exists "binders_read"   on public.binders;
drop policy if exists "binders_insert" on public.binders;
drop policy if exists "binders_update" on public.binders;
drop policy if exists "binders_delete" on public.binders;
create policy "binders_read"   on public.binders for select using (auth.role() = 'authenticated');
create policy "binders_insert" on public.binders for insert with check (auth.uid() = user_id);
create policy "binders_update" on public.binders for update using (auth.uid() = user_id);
create policy "binders_delete" on public.binders for delete using (auth.uid() = user_id);

-- Backfill: every existing profile gets a binder seeded from its old single-binder fields
insert into public.binders (user_id, name, description, sleeve_image_url, binder_background_url)
select p.user_id,
       coalesce(p.binder_name, 'My Binder'),
       p.binder_description,
       p.sleeve_image_url,
       p.binder_background_url
from public.profiles p
where not exists (select 1 from public.binders b where b.user_id = p.user_id);

-- Migrate listings from user_id → binder_id
alter table public.listings add column if not exists binder_id uuid references public.binders(id) on delete cascade;
alter table public.listings add column if not exists sort_order int;
create index if not exists listings_binder_sort_idx on public.listings(binder_id, sort_order);

-- Backfill any rows that still reference user_id (only if user_id column still exists)
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema='public' and table_name='listings' and column_name='user_id') then
    update public.listings l
       set binder_id = (select b.id from public.binders b where b.user_id = l.user_id order by b.created_at limit 1)
     where binder_id is null;
  end if;
end $$;

-- Drop the OLD policies first (they reference user_id, blocking the column drop)
drop policy if exists "listings_insert" on public.listings;
drop policy if exists "listings_update" on public.listings;
drop policy if exists "listings_delete" on public.listings;

-- Now we can drop the old user_id column
alter table public.listings drop column if exists user_id;

-- New policies: binder ownership controls writes
create policy "listings_insert" on public.listings for insert
  with check (exists (select 1 from public.binders b where b.id = binder_id and b.user_id = auth.uid()));
create policy "listings_update" on public.listings for update
  using (exists (select 1 from public.binders b where b.id = binder_id and b.user_id = auth.uid()));
create policy "listings_delete" on public.listings for delete
  using (exists (select 1 from public.binders b where b.id = binder_id and b.user_id = auth.uid()));

create index if not exists listings_binder_id_idx on public.listings(binder_id);

-- Updated public RPCs (keyed by binder_id, joined to profile for owner name).
-- Drop older signatures first since return types changed (per-user → per-binder).
drop function if exists public.get_binder_by_slug(text);
drop function if exists public.get_binder_public(uuid);
drop function if exists public.get_binder_listings_public(uuid);
drop function if exists public.search_binders(text, text, text);

drop function if exists public.get_binder_public(uuid);
create or replace function public.get_binder_public(p_binder_id uuid)
returns table (
  id                    uuid,
  user_id               uuid,
  display_name          text,
  binder_name           text,
  binder_description    text,
  sleeve_image_url      text,
  binder_background_url text,
  flair                 text,
  category              text
) language sql stable security definer set search_path = public as $$
  select b.id, b.user_id, p.display_name, b.name, b.description,
         b.sleeve_image_url, b.binder_background_url, b.flair, b.category
  from public.binders b
  join public.profiles p on p.user_id = b.user_id
  where b.id = p_binder_id;
$$;
revoke all on function public.get_binder_public(uuid) from public;
grant execute on function public.get_binder_public(uuid) to anon, authenticated;

drop function if exists public.get_binder_listings_public(uuid);
create or replace function public.get_binder_listings_public(p_binder_id uuid)
returns table (id uuid, card_code text, quantity int, listing_type text, sort_order int, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  select l.id, l.card_code, l.quantity, l.listing_type, l.sort_order, l.created_at
  from public.listings l
  where l.binder_id = p_binder_id
  order by l.sort_order nulls last, l.created_at desc;
$$;
revoke all on function public.get_binder_listings_public(uuid) from public;
grant execute on function public.get_binder_listings_public(uuid) to anon, authenticated;

-- City column on profiles — drives the multi-market expansion. Defaults
-- to 'nyc' so existing rows backfill cleanly. Valid values are managed in
-- the client config (window.CITIES) rather than a DB constraint for now,
-- to make adding cities a frontend-only change.
alter table public.profiles add column if not exists city text not null default 'nyc';
create index if not exists profiles_city_idx on public.profiles(city);

drop function if exists public.search_binders(text, text, text);
drop function if exists public.search_binders(text[], text, text);
drop function if exists public.search_binders(text[], text[], text);
drop function if exists public.search_binders(text[], text[], text, text);
drop function if exists public.search_binders(text[], text[], text, text, text);
drop function if exists public.search_binders(text[], text[], text, text, text, text[]);
create or replace function public.search_binders(
  p_boroughs   text[] default null,
  p_subways    text[] default null,
  p_shop       text   default null,
  p_category   text   default null,
  p_city       text   default null,
  p_card_codes text[] default null
) returns table (
  binder_id          uuid,
  user_id            uuid,
  display_name       text,
  binder_name        text,
  binder_description text,
  sleeve_image_url   text,
  flair              text,
  category           text,
  last_updated_at    timestamptz,
  matched_card_count int,
  matched_cards      text[]
) language sql stable security definer set search_path = public as $$
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
revoke all on function public.search_binders(text[], text[], text, text, text, text[]) from public;
grant execute on function public.search_binders(text[], text[], text, text, text, text[]) to anon, authenticated;

-- ---------- AUTO-CREATE PROFILE ON SIGNUP ----------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  insert into public.binders (user_id, name) values (new.id, 'My Binder');
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- ============================================================
-- SECURITY HARDENING (2026-05-15)
-- Idempotent: safe to re-run.
-- ============================================================

-- ---------- Storage: lock down binder-customs bucket ----------
-- Restrict uploads to image types only and cap size at 5 MiB so the
-- public bucket can't be used to host arbitrary content or SVG/JS.
update storage.buckets
   set allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif'],
       file_size_limit    = 5242880
 where id = 'binder-customs';

-- ---------- URL validation on user-controllable image columns ----------
-- RLS lets authenticated users write any string into these columns.
-- Constrain them to NULL or a URL from our own Supabase storage public
-- endpoint, so direct API writes can't smuggle tracking pixels or
-- malicious external URLs into public binder views.
--
-- Constraints are added NOT VALID so this migration applies even if
-- legacy rows would fail the check. After cleaning up any violators
-- (see the validate block at the bottom), re-run a `validate constraint`
-- statement to mark each constraint as enforced for past data too.

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'binders_sleeve_image_url_check') then
    alter table public.binders
      add constraint binders_sleeve_image_url_check
      check (
        sleeve_image_url is null
        or sleeve_image_url like 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'
      ) not valid;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'binders_background_url_check') then
    alter table public.binders
      add constraint binders_background_url_check
      check (
        binder_background_url is null
        or binder_background_url like 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'
      ) not valid;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_sleeve_image_url_check') then
    alter table public.profiles
      add constraint profiles_sleeve_image_url_check
      check (
        sleeve_image_url is null
        or sleeve_image_url like 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'
      ) not valid;
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'profiles_binder_background_url_check') then
    alter table public.profiles
      add constraint profiles_binder_background_url_check
      check (
        binder_background_url is null
        or binder_background_url like 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'
      ) not valid;
  end if;
end $$;

-- After confirming legacy rows comply (see audit query below), run:
--
--   alter table public.binders  validate constraint binders_sleeve_image_url_check;
--   alter table public.binders  validate constraint binders_background_url_check;
--   alter table public.profiles validate constraint profiles_sleeve_image_url_check;
--   alter table public.profiles validate constraint profiles_binder_background_url_check;
--
-- Audit query to find rows that would violate the constraints:
--
--   select 'binders.sleeve' as col, id::text as row_id, sleeve_image_url as url from public.binders
--     where sleeve_image_url is not null and sleeve_image_url not like 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'
--   union all
--   select 'binders.bg', id::text, binder_background_url from public.binders
--     where binder_background_url is not null and binder_background_url not like 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'
--   union all
--   select 'profiles.sleeve', user_id::text, sleeve_image_url from public.profiles
--     where sleeve_image_url is not null and sleeve_image_url not like 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%'
--   union all
--   select 'profiles.bg', user_id::text, binder_background_url from public.profiles
--     where binder_background_url is not null and binder_background_url not like 'https://cligjmfhxvazjarbvexp.supabase.co/storage/v1/object/public/binder-customs/%';

-- ============================================================
-- MULTI-GAME CARDS MIGRATION (2026-05-18)
-- Adds Pokémon TCG alongside OPTCG in the shared `cards` table.
-- Idempotent: safe to re-run after the first migration.
-- ============================================================

-- 1) Game discriminator. Defaults to 'optcg' so existing rows backfill
--    cleanly. Check constraint allowlists the two games we ship; expand
--    by editing the constraint when adding a third TCG.
alter table public.cards add column if not exists game text not null default 'optcg';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cards_game_check') then
    alter table public.cards add constraint cards_game_check check (game in ('optcg','pokemon'));
  end if;
end $$;

-- 2) Replace the single-column primary key on card_code with a composite
--    (game, card_code) PK. pokemontcg.io IDs (e.g. 'sv1-1') don't clash
--    with OPTCG codes ('OP01-001') today, but a composite PK is the
--    durable answer once we add more games.
--
--    The `listings.card_code` FK has to go before we touch the PK, since
--    it references the column being unkeyed. We don't re-add it because
--    listings' game is derivable from binder.category — adding a `game`
--    column here would denormalize binder.category onto every listing
--    row for no real gain. App + RLS keep the relationship coherent.
-- Drop the listings → cards FK if it still exists, regardless of name.
-- Using a record-based FOR loop with the column-set check joined inline
-- keeps every `any(c.conkey)` unambiguously in the array form.
do $$
declare r record;
begin
  for r in
    select c.conname
      from pg_constraint c
      join pg_attribute  a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid = 'public.listings'::regclass
       and c.contype  = 'f'
     group by c.conname
    having array_agg(a.attname order by a.attnum) = array['card_code']::name[]
  loop
    execute format('alter table public.listings drop constraint %I', r.conname);
  end loop;
end $$;

-- Swap the cards primary key from (card_code) to (game, card_code).
-- Only fires when the current PK is the single-column legacy one, so
-- re-runs against an already-migrated table no-op.
do $$
declare r record;
begin
  for r in
    select c.conname
      from pg_constraint c
      join pg_attribute  a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
     where c.conrelid = 'public.cards'::regclass
       and c.contype  = 'p'
     group by c.conname
    having array_agg(a.attname order by a.attnum) = array['card_code']::name[]
  loop
    execute format('alter table public.cards drop constraint %I', r.conname);
    execute 'alter table public.cards add primary key (game, card_code)';
  end loop;
end $$;

-- 3) Pokémon-only columns. All nullable so OPTCG rows leave them blank.
--    Stored as plain columns where the field is scalar; attacks/abilities
--    go into JSONB so we don't have to model the nested shape rigidly.
alter table public.cards add column if not exists hp           int;
alter table public.cards add column if not exists types        text[];   -- e.g. {'Lightning','Metal'}
alter table public.cards add column if not exists retreat_cost int;
alter table public.cards add column if not exists weakness     text;     -- "Fighting x2"
alter table public.cards add column if not exists resistance   text;     -- "Psychic -30"
alter table public.cards add column if not exists evolves_from text;
alter table public.cards add column if not exists supertype    text;     -- 'Pokémon' | 'Trainer' | 'Energy'
alter table public.cards add column if not exists subtypes     text[];   -- e.g. {'Basic','ex'}
alter table public.cards add column if not exists set_id       text;     -- pokemontcg.io set.id (e.g. 'sv1')
alter table public.cards add column if not exists number       text;     -- card number within set ('001/198')
alter table public.cards add column if not exists attacks      jsonb;    -- raw attacks array from API

-- 4) Helpful indexes for the autocomplete query path
--    (filtered by game, sorted by release_order desc, then card_code).
create index if not exists cards_game_idx          on public.cards(game);
create index if not exists cards_game_release_idx  on public.cards(game, release_order desc, card_code);

-- 5) Search-binders RPC already pivots on binders.category, which maps
--    1:1 to cards.game ('optcg' ↔ 'optcg', 'pokemon' ↔ 'pokemon'), so
--    the existing p_category filter on search_binders is unchanged. The
--    only client change is the card-autocomplete fetch in trades.js,
--    which now filters cards by the active game (see that file).
