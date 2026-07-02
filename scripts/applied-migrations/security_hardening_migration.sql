-- ============================================================
-- Pawpaw Ko — Security hardening migration
-- Idempotent: safe to re-run. Paste into the Supabase SQL editor.
-- ============================================================
-- Two defense-in-depth changes that can't live in the static frontend:
--   1. Lock the public `binder-customs` upload bucket to image types + a size
--      cap. Storage RLS already restricts writes to the owner's own folder
--      (path must start with auth.uid()), but nothing currently limits the
--      file TYPE or SIZE — an authenticated user could upload arbitrary
--      content and get a public URL for it. Restrict to images, max 5 MB.
--   2. Cap per-statement runtime for the untrusted PostgREST roles so a
--      pathological or abusive query (e.g. hammering search_binders) can't
--      pin the database. Normal reads and the search RPC finish in well
--      under a second, so these ceilings only ever kill runaway queries.

-- 1) Image-only, size-capped uploads for sleeve / background customs.
update storage.buckets
   set file_size_limit    = 5242880,  -- 5 MB
       allowed_mime_types = array['image/png','image/jpeg','image/webp','image/gif']
 where id = 'binder-customs';

-- 2) Per-role statement timeouts (Supabase/PostgREST applies role-level GUCs).
alter role anon          set statement_timeout = '5s';
alter role authenticated set statement_timeout = '8s';

-- Make PostgREST pick up the changed role settings without waiting for
-- connections to cycle.
notify pgrst, 'reload config';

-- Verify:
--   select id, file_size_limit, allowed_mime_types
--     from storage.buckets where id = 'binder-customs';
--   select rolname, rolconfig from pg_roles where rolname in ('anon','authenticated');
