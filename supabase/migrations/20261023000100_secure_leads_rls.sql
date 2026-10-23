-- Restrict every client-visible operation on leads to its authenticated owner.
-- This forward migration intentionally replaces existing policies on public.leads.
-- It does not modify or delete lead rows. Review this access change before applying
-- it to a remote database; service_role continues to use Supabase's bypass-RLS role.

DO $$
BEGIN
  IF to_regclass('public.leads') IS NULL THEN
    RAISE EXCEPTION 'Expected public.leads to exist before applying owner-isolation policy';
  END IF;
END
$$;

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
  existing_policy record;
BEGIN
  FOR existing_policy IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'leads'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.leads', existing_policy.policyname);
  END LOOP;
END
$$;

REVOKE ALL ON TABLE public.leads FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.leads TO authenticated;

CREATE POLICY leads_select_own
  ON public.leads
  FOR SELECT
  TO authenticated
  USING (user_id::text = (SELECT auth.uid())::text);

CREATE POLICY leads_insert_own
  ON public.leads
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id::text = (SELECT auth.uid())::text);

CREATE POLICY leads_update_own
  ON public.leads
  FOR UPDATE
  TO authenticated
  USING (user_id::text = (SELECT auth.uid())::text)
  WITH CHECK (user_id::text = (SELECT auth.uid())::text);

CREATE POLICY leads_delete_own
  ON public.leads
  FOR DELETE
  TO authenticated
  USING (user_id::text = (SELECT auth.uid())::text);

COMMENT ON TABLE public.leads IS
  'RLS restricts authenticated client reads and writes to rows whose user_id matches auth.uid().';
