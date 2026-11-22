// Stable import path for the ingest router. The implementation lives in the
// ingestion lane (server/ingest/routes.ts); this module only re-exports it so
// the integrator can mount from server/routes/ingest.ts without depending on
// internal layout.
export { createIngestRouter, default } from '../ingest/routes.ts';
