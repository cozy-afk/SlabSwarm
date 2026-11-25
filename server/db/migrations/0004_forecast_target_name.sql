-- Add a human-readable target name to forecasts. Raw IDs remain stable keys.
ALTER TABLE forecasts ADD COLUMN IF NOT EXISTS target_name text;

COMMENT ON COLUMN forecasts.target_name IS 'Human-facing card name copied from the evidence-backed active report; stable target_id remains the key.';
