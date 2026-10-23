CREATE TABLE public.leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'openstreetmap',
  source_id text,
  name text NOT NULL,
  category text,
  city text,
  address text,
  phone text,
  whatsapp text,
  website text,
  has_website boolean NOT NULL DEFAULT false,
  has_menu boolean NOT NULL DEFAULT false,
  lat double precision,
  lon double precision,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  ai_score int,
  ai_summary text,
  ai_message text,
  status text NOT NULL DEFAULT 'novo',
  approved boolean NOT NULL DEFAULT false,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source, source_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.leads TO authenticated;
GRANT ALL ON public.leads TO service_role;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own leads select" ON public.leads FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own leads insert" ON public.leads FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY "own leads update" ON public.leads FOR UPDATE TO authenticated USING (auth.uid() = user_id);
CREATE POLICY "own leads delete" ON public.leads FOR DELETE TO authenticated USING (auth.uid() = user_id);