/**
 * Canonical PostgreSQL schema for the Slabswarm data product.
 *
 * Raw evidence is immutable and corrections append. Raw JSON payloads and
 * flexible facets live in JSONB columns; observation times are timezone-aware
 * timestamps. Missing values stay NULL (UNKNOWN), never zero.
 */

import { randomUUID } from 'node:crypto';
import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => text('id').primaryKey().$defaultFn(() => randomUUID());
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const evidenceRecords = pgTable(
  'evidence_records',
  {
    id: id(),
    sourceId: text('source_id').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    sourceUri: text('source_uri'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    checksum: text('checksum').notNull(),
    mimeType: text('mime_type').notNull(),
    license: text('license'),
    rawRef: text('raw_ref').notNull(),
    parsedPayload: jsonb('parsed_payload').$type<Record<string, unknown>>(),
    trustTier: text('trust_tier'),
    parseStatus: text('parse_status').notNull().default('PENDING'),
    createdAt: createdAt(),
  },
  (t) => [
    index('evidence_records_source_record_idx').on(t.sourceRecordId),
    index('evidence_records_observed_at_idx').on(t.observedAt),
    index('evidence_records_status_idx').on(t.parseStatus),
    uniqueIndex('evidence_records_dedupe_uq').on(t.sourceId, t.sourceRecordId, t.checksum),
  ],
);

export const rawPayloads = pgTable(
  'raw_payloads',
  {
    id: id(),
    evidenceId: text('evidence_id').notNull(),
    checksum: text('checksum').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: integer('byte_size'),
    createdAt: createdAt(),
  },
  (t) => [
    index('raw_payloads_evidence_id_idx').on(t.evidenceId),
    uniqueIndex('raw_payloads_checksum_uq').on(t.checksum),
  ],
);

export const ingestRuns = pgTable(
  'ingest_runs',
  {
    id: id(),
    sourceId: text('source_id').notNull(),
    mode: text('mode').notNull(),
    status: text('status').notNull(),
    cursor: text('cursor'),
    counts: jsonb('counts').$type<Record<string, unknown>>(),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('ingest_runs_source_id_idx').on(t.sourceId),
    index('ingest_runs_status_idx').on(t.status),
  ],
);

export const marketObservations = pgTable('market_observations', {
  id: id(),
  evidenceId: text('evidence_id').notNull(),
  sourceRecordId: text('source_record_id'),
  targetIdentityId: text('target_identity_id').notNull(),
  basis: text('basis').notNull(),
  amount: doublePrecision('amount').notNull(),
  currency: text('currency').notNull(),
  marketplace: text('marketplace'),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
  priceComponents: jsonb('price_components').$type<Record<string, unknown>>(),
  status: text('status').notNull().default('RAW'),
  confidence: doublePrecision('confidence'),
  lineage: jsonb('lineage').$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [
  index('market_observations_source_record_idx').on(t.sourceRecordId),
  index('market_observations_target_identity_idx').on(t.targetIdentityId),
  index('market_observations_observed_at_idx').on(t.observedAt),
  index('market_observations_basis_idx').on(t.basis),
  index('market_observations_status_idx').on(t.status),
]);

export const games = pgTable(
  'games',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('games_slug_uq').on(t.slug)],
);

export const sets = pgTable(
  'sets',
  {
    id: id(),
    gameId: text('game_id'),
    name: text('name').notNull(),
    code: text('code'),
    releaseYear: integer('release_year'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index('sets_game_id_idx').on(t.gameId)],
);

export const cards = pgTable(
  'cards',
  {
    id: id(),
    setId: text('set_id'),
    name: text('name').notNull(),
    cardNumber: text('card_number'),
    variant: text('variant'),
    identityKey: text('identity_key').notNull(),
    facets: jsonb('facets').$type<Record<string, unknown>>(),
    rawPayload: jsonb('raw_payload').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('cards_identity_key_uq').on(t.identityKey),
    index('cards_card_number_idx').on(t.cardNumber),
  ],
);

export const printings = pgTable(
  'printings',
  {
    id: id(),
    cardId: text('card_id').notNull(),
    printingKey: text('printing_key').notNull(),
    finish: text('finish'),
    language: text('language'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex('printings_key_uq').on(t.printingKey)],
);

export const instances = pgTable(
  'instances',
  {
    id: id(),
    printingId: text('printing_id').notNull(),
    grade: text('grade'),
    gradingCompany: text('grading_company'),
    certificateNumber: text('certificate_number'),
    facets: jsonb('facets').$type<Record<string, unknown>>(),
  },
  (t) => [index('instances_printing_id_idx').on(t.printingId)],
);

export const entities = pgTable(
  'entities',
  {
    id: id(),
    type: text('type').notNull(),
    canonicalRef: text('canonical_ref').notNull(),
    displayName: text('display_name'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('entities_canonical_ref_uq').on(t.canonicalRef)],
);

export const events = pgTable(
  'events',
  {
    id: id(),
    title: text('title').notNull(),
    eventDate: timestamp('event_date', { withTimezone: true }),
    category: text('category'),
    sentiment: text('sentiment'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('events_observed_at_idx').on(t.observedAt)],
);

export const identityDecisions = pgTable(
  'identity_decisions',
  {
    id: id(),
    targetRef: text('target_ref').notNull(),
    status: text('status').notNull(),
    candidates: jsonb('candidates').$type<unknown[]>(),
    scores: jsonb('scores').$type<Record<string, unknown>>(),
    votes: jsonb('votes').$type<unknown[]>(),
    contradictions: jsonb('contradictions').$type<string[]>(),
    createdAt: createdAt(),
  },
  (t) => [index('identity_decisions_status_idx').on(t.status)],
);

export const aliases = pgTable(
  'aliases',
  {
    id: id(),
    entityId: text('entity_id').notNull(),
    alias: text('alias').notNull(),
    source: text('source').notNull(),
    confidence: doublePrecision('confidence'),
  },
  (t) => [uniqueIndex('aliases_entity_alias_uq').on(t.entityId, t.alias, t.source)],
);

export const crosswalks = pgTable(
  'crosswalks',
  {
    id: id(),
    fromSystem: text('from_system').notNull(),
    fromId: text('from_id').notNull(),
    toSystem: text('to_system').notNull(),
    toId: text('to_id').notNull(),
    confidence: doublePrecision('confidence'),
  },
  (t) => [uniqueIndex('crosswalks_pair_uq').on(t.fromSystem, t.fromId, t.toSystem, t.toId)],
);

export const factors = pgTable(
  'factors',
  {
    id: id(),
    key: text('key').notNull(),
    description: text('description'),
    weight: doublePrecision('weight'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex('factors_key_uq').on(t.key)],
);

export const factorScores = pgTable(
  'factor_scores',
  {
    id: id(),
    factorId: text('factor_id').notNull(),
    targetId: text('target_id').notNull(),
    score: doublePrecision('score'),
    basis: text('basis'),
    observedAt: timestamp('observed_at', { withTimezone: true }).notNull(),
    evidenceIds: jsonb('evidence_ids').$type<string[]>(),
  },
  (t) => [
    index('factor_scores_target_id_idx').on(t.targetId),
    index('factor_scores_observed_at_idx').on(t.observedAt),
    index('factor_scores_basis_idx').on(t.basis),
  ],
);

export const forecasts = pgTable(
  'forecasts',
  {
    id: id(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    horizonDays: integer('horizon_days').notNull(),
    scenario: text('scenario').notNull(),
    priceBands: jsonb('price_bands').$type<Record<string, unknown>>().notNull(),
    demandPressure: text('demand_pressure').notNull(),
    supplyPressure: text('supply_pressure').notNull(),
    drivers: jsonb('drivers').$type<string[]>().notNull(),
    invalidators: jsonb('invalidators').$type<string[]>().notNull(),
    evidenceIds: jsonb('evidence_ids').$type<string[]>().notNull(),
    confidence: text('confidence').notNull(),
    status: text('status').notNull().default('HYPOTHESIS'),
    createdAt: createdAt(),
  },
  (t) => [
    index('forecasts_target_id_idx').on(t.targetId),
    index('forecasts_status_idx').on(t.status),
  ],
);

export const forecastScores = pgTable(
  'forecast_scores',
  {
    id: id(),
    forecastId: text('forecast_id').notNull(),
    outcome: jsonb('outcome').$type<Record<string, unknown>>(),
    score: doublePrecision('score'),
    scoredAt: timestamp('scored_at', { withTimezone: true }).notNull(),
    horizonDays: integer('horizon_days'),
  },
  (t) => [index('forecast_scores_forecast_id_idx').on(t.forecastId)],
);

export const simulationRuns = pgTable(
  'simulation_runs',
  {
    id: id(),
    scenario: text('scenario').notNull(),
    persona: jsonb('persona').$type<Record<string, unknown>>(),
    worldModel: jsonb('world_model').$type<Record<string, unknown>>(),
    output: jsonb('output').$type<Record<string, unknown>>(),
    status: text('status').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('simulation_runs_status_idx').on(t.status)],
);

export const swarmRuns = pgTable(
  'swarm_runs',
  {
    id: id(),
    kind: text('kind').notNull(),
    roles: jsonb('roles').$type<unknown[]>(),
    trace: jsonb('trace').$type<unknown[]>(),
    status: text('status').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('swarm_runs_status_idx').on(t.status)],
);

export const researchNotes = pgTable(
  'research_notes',
  {
    id: id(),
    question: text('question').notNull(),
    subquestions: jsonb('subquestions').$type<string[]>(),
    evidenceIds: jsonb('evidence_ids').$type<string[]>(),
    synthesis: text('synthesis'),
    confidence: doublePrecision('confidence'),
    missingData: jsonb('missing_data').$type<string[]>(),
    source: jsonb('source').$type<Record<string, unknown>>(),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('research_notes_observed_at_idx').on(t.observedAt)],
);

export const valuations = pgTable(
  'valuations',
  {
    id: id(),
    targetId: text('target_id').notNull(),
    metrics: jsonb('metrics').$type<Record<string, unknown>>(),
    history: jsonb('history').$type<unknown[]>(),
    source: text('source').notNull(),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('valuations_target_source_uq').on(t.targetId, t.source)],
);

export const learningEvents = pgTable(
  'learning_events',
  {
    id: id(),
    kind: text('kind').notNull(),
    targetId: text('target_id'),
    score: doublePrecision('score'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index('learning_events_kind_idx').on(t.kind),
    index('learning_events_target_id_idx').on(t.targetId),
  ],
);

export const sourceTrustProfiles = pgTable(
  'source_trust_profiles',
  {
    id: id(),
    sourceId: text('source_id').notNull(),
    trustTier: text('trust_tier'),
    score: doublePrecision('score'),
    sampleSize: integer('sample_size'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('source_trust_profiles_source_uq').on(t.sourceId)],
);

export const ruleVersions = pgTable(
  'rule_versions',
  {
    id: id(),
    ruleKey: text('rule_key').notNull(),
    version: integer('version').notNull(),
    definition: jsonb('definition').$type<Record<string, unknown>>(),
    status: text('status').notNull(),
    promotedAt: timestamp('promoted_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('rule_versions_key_version_uq').on(t.ruleKey, t.version),
    index('rule_versions_status_idx').on(t.status),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('PENDING'),
    payload: jsonb('payload').$type<Record<string, unknown>>(),
    attempts: integer('attempts').notNull().default(0),
    runAt: timestamp('run_at', { withTimezone: true }),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lastError: text('last_error'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }),
  },
  (t) => [
    index('jobs_status_idx').on(t.status),
    index('jobs_kind_idx').on(t.kind),
  ],
);

export const schemaMigrations = pgTable('__schema_migrations', {
  name: text('name').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull(),
});
