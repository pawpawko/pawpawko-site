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
`npx supabase login` if it expires). A `db pull` baseline of the live schema is
still pending — it requires Docker Desktop. Until it exists, `supabase-schema.sql`
in the repo root remains the reference copy of the full schema.

## After any schema change

Regenerate the mobile app's DB types:

```
npx supabase gen types typescript --linked > ../pawpawko-mobile/src/lib/database.types.ts
```
