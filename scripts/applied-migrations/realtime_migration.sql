-- ============================================================
-- Realtime: instant sync for notifications + co-edited listings
-- ============================================================
-- Replaces the 60s notification poll + manual binder refresh with live
-- Supabase Realtime. Idempotent; apply in the Supabase SQL editor.
-- (Equivalent to toggling these tables on under Database -> Replication in
-- the dashboard.)
--
-- Client side is already wired:
--   - js/main.js subscribes to public.notifications (bell badge + invites +
--     deck-collect notices update instantly).
--   - js/binder-view.js subscribes to public.listings filtered by binder_id
--     (a co-editor's card change refreshes the shared binder live).
--   - js/decks.js subscribes to public.deck_cards filtered by deck_id (a
--     partner's edit refreshes a shared deck; ignored while a local edit burst
--     is in flight so it never fights the optimistic queue).

-- REPLICA IDENTITY FULL puts the whole row in the WAL so Realtime can filter
-- by non-PK columns (binder_id, user_id, deck_id) on UPDATE/DELETE and evaluate
-- RLS on the old row. Default (PK only) would drop those events from filtered
-- streams.
alter table public.notifications replica identity full;
alter table public.listings      replica identity full;
alter table public.deck_cards     replica identity full;

-- Add both tables to the Realtime publication (idempotent).
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'notifications') then
    alter publication supabase_realtime add table public.notifications;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'listings') then
    alter publication supabase_realtime add table public.listings;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'deck_cards') then
    alter publication supabase_realtime add table public.deck_cards;
  end if;
end $$;
