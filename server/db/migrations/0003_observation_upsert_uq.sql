-- Repository upserts on market_observations use this four-column identity.
-- Without a matching unique constraint Postgres rejects ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS market_observations_upsert_uq
  ON market_observations (evidence_id, target_identity_id, basis, observed_at);
