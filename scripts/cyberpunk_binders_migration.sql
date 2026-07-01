-- ============================================================
-- Allow Cyberpunk TCG binders
-- ============================================================
-- The multi-game binders migration constrained binders.category to
-- ('optcg','pokemon'); widen it to include 'cyberpunk' so users can create
-- Cyberpunk binders. The per-(user, category) unique indexes for the single
-- Trade / Wishlist binder already key on category, so Cyberpunk gets its own
-- slots automatically. search_binders() pivots on category with no change.
--
-- Idempotent. Drops + re-adds the column check constraint widened.

do $$
declare r record;
begin
  for r in
    select c.conname
      from pg_constraint c
     where c.conrelid = 'public.binders'::regclass
       and c.contype  = 'c'
       and pg_get_constraintdef(c.oid) ilike '%category%'
  loop
    execute format('alter table public.binders drop constraint %I', r.conname);
  end loop;
  alter table public.binders add constraint binders_category_check
    check (category in ('optcg','pokemon','cyberpunk'));
end $$;
