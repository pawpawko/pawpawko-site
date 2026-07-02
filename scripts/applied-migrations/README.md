# Applied migrations (pre-CLI history)

Every file here was hand-applied to prod via the Supabase SQL editor before the
project adopted the Supabase CLI (2026-07-02). They are kept as history only —
do NOT re-run them, and do NOT add new files here.

## Schema changes from now on

```
npx supabase migration new <name>   # writes supabase/migrations/<ts>_<name>.sql
npx supabase db push                # applies pending migrations to prod
```

The CLI is linked to project `cligjmfhxvazjarbvexp` (auth token stored per-user;
`npx supabase login` if it expires; the link itself lives in gitignored
`supabase/.temp/` — rerun `npx supabase link --project-ref cligjmfhxvazjarbvexp`
after a fresh clone/worktree). **The live-schema baseline is
`supabase/migrations/20260702114456_baseline_prod_schema.sql`** (pg_dump via
`supabase db dump`, marked applied with `migration repair`). The old hand-kept
`supabase-schema.sql` is retired here as
`supabase-schema-reference-2026-07-02.sql` — history only.

## After any schema change

Regenerate the mobile app's DB types:

```
npx supabase gen types typescript --linked > ../pawpawko-mobile/src/lib/database.types.ts
```
