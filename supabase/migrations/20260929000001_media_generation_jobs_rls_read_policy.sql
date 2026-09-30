-- Phase A Item 4: Customer-facing RLS read policy for media_generation_jobs
-- Allows authenticated organization members to SELECT their organization's media jobs.

GRANT SELECT ON public.media_generation_jobs TO authenticated;

CREATE POLICY "Members can view media generation jobs for their organization"
  ON public.media_generation_jobs FOR SELECT
  TO authenticated
  USING (
    private.is_org_member(organization_id, auth.uid())
  );
