-- Regression tests for owner isolation. Run with: supabase test db
-- They execute after local migrations and roll back the fixture rows.
BEGIN;
SELECT plan(5);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000001', true);
INSERT INTO public.leads (id, user_id, name, source, source_id, city)
VALUES (
  'e0000000-0000-4000-8000-000000000010',
  'e0000000-0000-4000-8000-000000000001',
  'RLS test owner A',
  'rls-test',
  'fixture/owner-a',
  'Mirassol'
);

SELECT is(
  (SELECT count(*) FROM public.leads WHERE id = 'e0000000-0000-4000-8000-000000000010'),
  1::bigint,
  'a user can read their own lead'
);

SELECT set_config('request.jwt.claim.sub', 'e0000000-0000-4000-8000-000000000002', true);

SELECT is(
  (SELECT count(*) FROM public.leads WHERE id = 'e0000000-0000-4000-8000-000000000010'),
  0::bigint,
  'another user cannot read this lead'
);

UPDATE public.leads SET name = 'tampered by owner B'
WHERE id = 'e0000000-0000-4000-8000-000000000010';

RESET ROLE;
SELECT is(
  (SELECT name FROM public.leads WHERE id = 'e0000000-0000-4000-8000-000000000010'),
  'RLS test owner A',
  'another user cannot update this lead'
);

SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$
    INSERT INTO public.leads (id, user_id, name, source, source_id, city)
    VALUES (
      'e0000000-0000-4000-8000-000000000011',
      'e0000000-0000-4000-8000-000000000001',
      'forged owner',
      'rls-test',
      'fixture/forged',
      'Mirassol'
    )
  $$,
  '42501',
  NULL,
  'a user cannot insert a lead for another owner'
);

DELETE FROM public.leads WHERE id = 'e0000000-0000-4000-8000-000000000010';
RESET ROLE;
SELECT is(
  (SELECT count(*) FROM public.leads WHERE id = 'e0000000-0000-4000-8000-000000000010'),
  1::bigint,
  'another user cannot delete this lead'
);

SELECT * FROM finish();
ROLLBACK;
