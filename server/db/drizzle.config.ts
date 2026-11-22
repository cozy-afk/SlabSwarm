/**
 * Drizzle Kit configuration for the canonical Postgres schema.
 * Paths are relative to the repository root. Credentials are read from the
 * environment only; no secret values live in this file.
 */
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/db/schema.ts',
  out: './server/db/migrations',
  dialect: 'postgresql',
  verbose: true,
  strict: true,
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://slabswarm@localhost:5432/slabswarm',
  },
});
