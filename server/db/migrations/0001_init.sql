-- Core data-product schema. DDL only; no data mutation, no destructive rewrites.
CREATE TABLE IF NOT EXISTS evidence_records (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  source_record_id text NOT NULL,
  source_uri text,
  captured_at timestamptz NOT NULL,
  observed_at timestamptz NOT NULL,
  checksum text NOT NULL,
  mime_type text NOT NULL,
  license text,
  raw_ref text NOT NULL,
  parsed_payload jsonb,
  trust_tier text,
  parse_status text NOT NULL DEFAULT 'PENDING',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS raw_payloads (
  id text PRIMARY KEY,
  evidence_id text NOT NULL,
  checksum text NOT NULL,
  payload jsonb NOT NULL,
  mime_type text NOT NULL,
  byte_size integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ingest_runs (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  mode text NOT NULL,
  status text NOT NULL,
  cursor text,
  counts jsonb,
  error text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS market_observations (
  id text PRIMARY KEY,
  evidence_id text NOT NULL,
  source_record_id text,
  target_identity_id text NOT NULL,
  basis text NOT NULL,
  amount double precision NOT NULL,
  currency text NOT NULL,
  marketplace text,
  observed_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  price_components jsonb,
  status text NOT NULL DEFAULT 'RAW',
  confidence double precision,
  lineage jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS games (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sets (
  id text PRIMARY KEY,
  game_id text,
  name text NOT NULL,
  code text,
  release_year integer,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cards (
  id text PRIMARY KEY,
  set_id text,
  name text NOT NULL,
  card_number text,
  variant text,
  identity_key text NOT NULL,
  facets jsonb,
  raw_payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS printings (
  id text PRIMARY KEY,
  card_id text NOT NULL,
  printing_key text NOT NULL,
  finish text,
  language text,
  metadata jsonb
);
CREATE TABLE IF NOT EXISTS instances (
  id text PRIMARY KEY,
  printing_id text NOT NULL,
  grade text,
  grading_company text,
  certificate_number text,
  facets jsonb
);
CREATE TABLE IF NOT EXISTS entities (
  id text PRIMARY KEY,
  type text NOT NULL,
  canonical_ref text NOT NULL,
  display_name text,
  attributes jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  title text NOT NULL,
  event_date timestamptz,
  category text,
  sentiment text,
  payload jsonb,
  observed_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS identity_decisions (
  id text PRIMARY KEY,
  target_ref text NOT NULL,
  status text NOT NULL,
  candidates jsonb,
  scores jsonb,
  votes jsonb,
  contradictions jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS aliases (
  id text PRIMARY KEY,
  entity_id text NOT NULL,
  alias text NOT NULL,
  source text NOT NULL,
  confidence double precision
);
CREATE TABLE IF NOT EXISTS crosswalks (
  id text PRIMARY KEY,
  from_system text NOT NULL,
  from_id text NOT NULL,
  to_system text NOT NULL,
  to_id text NOT NULL,
  confidence double precision
);
CREATE TABLE IF NOT EXISTS factors (
  id text PRIMARY KEY,
  key text NOT NULL,
  description text,
  weight double precision,
  metadata jsonb
);
CREATE TABLE IF NOT EXISTS factor_scores (
  id text PRIMARY KEY,
  factor_id text NOT NULL,
  target_id text NOT NULL,
  score double precision,
  basis text,
  observed_at timestamptz NOT NULL,
  evidence_ids jsonb
);
CREATE TABLE IF NOT EXISTS forecasts (
  id text PRIMARY KEY,
  target_type text NOT NULL,
  target_id text NOT NULL,
  horizon_days integer NOT NULL,
  scenario text NOT NULL,
  price_bands jsonb NOT NULL,
  demand_pressure text NOT NULL,
  supply_pressure text NOT NULL,
  drivers jsonb NOT NULL,
  invalidators jsonb NOT NULL,
  evidence_ids jsonb NOT NULL,
  confidence text NOT NULL,
  status text NOT NULL DEFAULT 'HYPOTHESIS',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS forecast_scores (
  id text PRIMARY KEY,
  forecast_id text NOT NULL,
  outcome jsonb,
  score double precision,
  scored_at timestamptz NOT NULL,
  horizon_days integer
);
CREATE TABLE IF NOT EXISTS simulation_runs (
  id text PRIMARY KEY,
  scenario text NOT NULL,
  persona jsonb,
  world_model jsonb,
  output jsonb,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS swarm_runs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  roles jsonb,
  trace jsonb,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS research_notes (
  id text PRIMARY KEY,
  question text NOT NULL,
  subquestions jsonb,
  evidence_ids jsonb,
  synthesis text,
  confidence double precision,
  missing_data jsonb,
  source jsonb,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS valuations (
  id text PRIMARY KEY,
  target_id text NOT NULL,
  metrics jsonb,
  history jsonb,
  source text NOT NULL,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS learning_events (
  id text PRIMARY KEY,
  kind text NOT NULL,
  target_id text,
  score double precision,
  payload jsonb,
  observed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS source_trust_profiles (
  id text PRIMARY KEY,
  source_id text NOT NULL,
  trust_tier text,
  score double precision,
  sample_size integer,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_versions (
  id text PRIMARY KEY,
  rule_key text NOT NULL,
  version integer NOT NULL,
  definition jsonb,
  status text NOT NULL,
  promoted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING',
  payload jsonb,
  attempts integer NOT NULL DEFAULT 0,
  run_at timestamptz,
  locked_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz
);
CREATE TABLE IF NOT EXISTS __schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL
);
