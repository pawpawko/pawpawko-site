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

create index if not exists listings_user_id_idx   on public.listings(user_id);
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

-- listings: only AUTHENTICATED users can read raw rows; owner writes
drop policy if exists "listings_read"   on public.listings;
drop policy if exists "listings_insert" on public.listings;
drop policy if exists "listings_update" on public.listings;
drop policy if exists "listings_delete" on public.listings;
create policy "listings_read"   on public.listings for select using (auth.role() = 'authenticated');
create policy "listings_insert" on public.listings for insert with check (auth.uid() = user_id);
create policy "listings_update" on public.listings for update using (auth.uid() = user_id);
create policy "listings_delete" on public.listings for delete using (auth.uid() = user_id);

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

drop function if exists public.search_binders(text, text, text);
drop function if exists public.search_binders(text[], text, text);
drop function if exists public.search_binders(text[], text[], text);
create or replace function public.search_binders(
  p_boroughs text[] default null,
  p_subways  text[] default null,
  p_shop     text default null
) returns table (
  binder_id          uuid,
  user_id            uuid,
  display_name       text,
  binder_name        text,
  binder_description text,
  sleeve_image_url   text,
  flair              text,
  category           text,
  last_updated_at    timestamptz
) language sql stable security definer set search_path = public as $$
  select b.id, b.user_id, p.display_name, b.name, b.description, b.sleeve_image_url,
         b.flair, b.category,
         coalesce((select max(l.created_at) from public.listings l where l.binder_id = b.id), b.created_at) as last_updated_at
  from public.binders b
  join public.profiles p on p.user_id = b.user_id
  where (p_boroughs is null or coalesce(array_length(p_boroughs, 1), 0) = 0 or p.boroughs && p_boroughs)
    and (p_subways  is null or coalesce(array_length(p_subways,  1), 0) = 0 or p.subway_stops && p_subways)
    and (p_shop     is null or p_shop = any(p.local_shops))
  order by coalesce((select max(l.created_at) from public.listings l where l.binder_id = b.id), b.created_at) desc
  limit 200;
$$;
revoke all on function public.search_binders(text[], text[], text) from public;
grant execute on function public.search_binders(text[], text[], text) to anon, authenticated;

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
