-- ============================================================
-- Shared binders: restrict binder-row metadata to the OWNER
-- ============================================================
-- Follow-up to binder_sharing_migration.sql. That migration made the binders
-- UPDATE policy member-based (is_binder_member) so a couple could co-edit a
-- binder. But that also let a *collaborator* change the owner's binder name,
-- flair, layout, cover, and category — not just its cards. Card co-edit lives
-- in the listings_* policies (left unchanged); the binder ROW itself should be
-- owner-only.
--
-- This narrows binders UPDATE back to the owner (binders.user_id). The sharing
-- RPCs (share_binder / unshare_binder / respond_binder_invite) are SECURITY
-- DEFINER and bypass RLS, so invite / merge-on-accept / listing re-parent flows
-- are unaffected.
--
-- Idempotent — safe to re-run. Apply in the Supabase SQL editor.

drop policy if exists "binders_update" on public.binders;
create policy "binders_update" on public.binders for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
-- listings_insert/update/delete stay member-based (see binder_sharing_migration.sql)
-- so collaborators keep full card co-edit; binders_insert/delete remain owner-only.
