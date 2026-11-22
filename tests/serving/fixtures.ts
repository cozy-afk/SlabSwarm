// Shared fixtures for the serving API tests. All data is synthetic and lives
// in memory; the real graph engine's persisted database is never touched.

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import type { GraphStatePayload } from '../../src/types/graph.ts';
import { createInMemoryRepositories } from '../../server/ingest/store.ts';
import type { IngestRepositories } from '../../server/ingest/types.ts';
import { mountServingRoutes } from '../../server/serving/routes.ts';

export const FIXED_NOW = new Date('2026-11-22T00:00:00.000Z');

function makeAsset(id: string, title: string, popCount: number) {
  return {
    id,
    title,
    segment: 'TCG',
    franchise: 'Pokemon',
    setId: `SET-${id}`,
    setName: 'Base Set',
    releaseYear: 1999,
    cardNumber: id === 'A1' ? '4' : '25',
    variant: 'Holo',
    subjectId: `SUB-${id}`,
    subjectName: title,
    communityId: 'COM-VINTAGE-TCG',
    visualTheme: 'vintage_holo',
    grades: [
      { grade: 'PSA 10', gradingCompany: 'PSA', popCount, gemRatePct: 12.5 },
      { grade: 'PSA 9', gradingCompany: 'PSA', popCount: 0, gemRatePct: 0 },
      { grade: 'Raw NM', gradingCompany: 'Raw', popCount: 0, gemRatePct: 0 },
    ],
  };
}

export function makeState(): GraphStatePayload {
  return {
    assets: [makeAsset('A1', 'Charizard', 120), makeAsset('A2', 'Pikachu', 0)],
    sets: [],
  } as unknown as GraphStatePayload;
}

export function makeEmptyState(): GraphStatePayload {
  return { assets: [], sets: [] } as unknown as GraphStatePayload;
}

export interface StartedApp {
  baseUrl: string;
  server: Server;
  state: GraphStatePayload;
  repositories: IngestRepositories;
}

export async function startApp(state: GraphStatePayload = makeState()): Promise<StartedApp> {
  const repositories = createInMemoryRepositories();
  const app = express();
  mountServingRoutes(app, {
    engine: { getState: () => state },
    repositories,
    now: () => FIXED_NOW,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { baseUrl, server, state, repositories };
}

async function addEvidence(
  repositories: IngestRepositories,
  sourceId: string,
  trustTier: 'HIGH' | 'MEDIUM' | 'LOW',
) {
  return (await repositories.evidence.createIdempotent({
    sourceId,
    sourceRecordId: `${sourceId}-record`,
    sourceUri: `https://example.test/${sourceId}`,
    capturedAt: '2026-11-21T10:00:00.000Z',
    observedAt: '2026-11-20T00:00:00.000Z',
    checksum: `checksum-${sourceId}`,
    mimeType: 'application/json',
    rawRef: `raw/${sourceId}.json`,
    trustTier,
    lineage: [`raw-${sourceId}`],
    parseStatus: 'PARSED',
  })).record;
}

/** Seed an append-only ledger with basis-explicit, multi-marketplace facts. */
export async function seedObservations(repositories: IngestRepositories): Promise<void> {
  const ebay = await addEvidence(repositories, 'ebay_sold', 'HIGH');
  const tcg = await addEvidence(repositories, 'tcgplayer', 'MEDIUM');
  const cardmarket = await addEvidence(repositories, 'cardmarket', 'LOW');

  const add = async (
    evidenceId: string,
    targetIdentityRef: string,
    basis: 'SOLD' | 'ASKING' | 'OFFER' | 'GUIDE' | 'CLAIM' | 'POPULATION' | 'UNKNOWN',
    amount: number,
    currency: string,
    marketplace: string,
    observedAt: string,
    status: 'RAW' | 'NORMALIZED' | 'CONTESTED' | 'SUPERSEDED' = 'NORMALIZED',
  ) => repositories.marketObservations.create({
    evidenceId,
    targetIdentityRef,
    basis,
    amount,
    currency,
    marketplace,
    observedAt,
    status,
  });

  // Primary group: ebay_sold / USD. One zero amount is UNKNOWN, one is
  // CONTESTED and must never reach comps or pricing.
  await add(ebay.id, 'A1', 'SOLD', 100, 'USD', 'ebay_sold', '2026-11-20T00:00:00.000Z');
  await add(ebay.id, 'A1', 'SOLD', 120, 'USD', 'ebay_sold', '2026-11-19T00:00:00.000Z');
  await add(ebay.id, 'A1', 'SOLD', 80, 'USD', 'ebay_sold', '2026-10-10T00:00:00.000Z');
  await add(ebay.id, 'A1', 'SOLD', 110, 'USD', 'ebay_sold', '2026-11-17T00:00:00.000Z');
  // `card:A1` must resolve to the same identity; this row is NORMALIZED.
  await add(ebay.id, 'card:A1', 'SOLD', 130, 'USD', 'ebay_sold', '2026-11-16T00:00:00.000Z');
  await add(ebay.id, 'card:A1', 'SOLD', 1100, 'USD', 'ebay_sold', '2026-11-14T00:00:00.000Z', 'SUPERSEDED');
  await add(ebay.id, 'A1', 'SOLD', 0, 'USD', 'ebay_sold', '2026-11-18T00:00:00.000Z');
  await add(ebay.id, 'A1', 'SOLD', 9999, 'USD', 'ebay_sold', '2026-11-15T00:00:00.000Z', 'CONTESTED');
  await add(ebay.id, 'A1', 'ASKING', 250, 'USD', 'ebay_sold', '2026-11-20T12:00:00.000Z');

  // Separate sources / currencies: never converted or summed.
  await add(tcg.id, 'A1', 'SOLD', 300, 'USD', 'tcgplayer', '2026-11-20T00:00:00.000Z');
  await add(cardmarket.id, 'A1', 'SOLD', 90, 'EUR', 'cardmarket', '2026-11-20T00:00:00.000Z');
}

/** A first-party ledger id that has no asset in the graph snapshot. */
export const TCG_LEDGER_ID = 'tcg:719440';

const TCG_FACETS = {
  targetIdentityRef: TCG_LEDGER_ID,
  name: 'Amalgamight, Close Encounter',
  gameName: 'Alpha Clash',
  expansionName: 'Nexus of Power',
  number: '44',
};

/**
 * Seed a graph-unknown id using the same evidence/parsedPayload shape the
 * TCGAPIs chain harvest writes. Identity facets live in the ledger; the graph
 * snapshot has no matching asset. GUIDE and SOLD observations stay separate.
 */
export async function seedTcgLedger(repositories: IngestRepositories): Promise<void> {
  const write = async (
    sourceId: string,
    sourceRecordId: string,
    parsedPayload: Record<string, unknown>,
  ) => (await repositories.evidence.createIdempotent({
    sourceId,
    sourceRecordId,
    sourceUri: `https://example.test/${sourceRecordId}`,
    capturedAt: '2026-11-21T10:00:00.000Z',
    observedAt: '2026-11-21T09:00:00.000Z',
    checksum: `checksum-${sourceRecordId}`,
    mimeType: 'application/json',
    rawRef: `raw/${sourceRecordId}.json`,
    trustTier: 'MEDIUM',
    lineage: ['tcgapis-chain', sourceRecordId],
    parseStatus: 'PARSED',
    parsedPayload,
  })).record;

  await write('tcgapis', 'tcg-card-719440', {
    source: 'tcgapis',
    recordKind: 'CATALOG_CARD',
    basis: 'UNKNOWN',
    ...TCG_FACETS,
  });
  const guide = await write('tcgapis', 'tcg-price-719440', {
    source: 'tcgapis',
    recordKind: 'PRICE_GUIDE',
    basis: 'GUIDE',
    currency: 'USD',
    price: 0.65,
    ...TCG_FACETS,
  });
  const sold = await write('ebay_sold', 'ebay-sale-719440', {
    source: 'ebay_sold',
    recordKind: 'SALE',
    basis: 'SOLD',
    currency: 'USD',
    price: 12,
    ...TCG_FACETS,
  });

  const add = async (
    evidenceId: string,
    basis: 'GUIDE' | 'SOLD',
    amount: number,
    marketplace: string,
    day: number,
  ) => repositories.marketObservations.create({
    evidenceId,
    targetIdentityRef: TCG_LEDGER_ID,
    basis,
    amount,
    currency: 'USD',
    marketplace,
    observedAt: new Date(FIXED_NOW.getTime() - day * 86_400_000).toISOString(),
    status: 'NORMALIZED',
  });

  await add(guide.id, 'GUIDE', 0.20, 'tcgapis', 1);
  await add(guide.id, 'GUIDE', 0.65, 'tcgapis', 2);
  await add(guide.id, 'GUIDE', 1.00, 'tcgapis', 3);
  await add(sold.id, 'SOLD', 10, 'ebay_sold', 1);
  await add(sold.id, 'SOLD', 12, 'ebay_sold', 2);
  await add(sold.id, 'SOLD', 14, 'ebay_sold', 3);
}

/** Ledger evidence carrying only a name; the other identity facets are absent. */
export async function seedSparseLedgerEvidence(
  repositories: IngestRepositories,
  id: string,
): Promise<void> {
  await repositories.evidence.createIdempotent({
    sourceId: 'tcgapis',
    sourceRecordId: `sparse-${id}`,
    sourceUri: `https://example.test/sparse/${encodeURIComponent(id)}`,
    capturedAt: '2026-11-21T10:00:00.000Z',
    observedAt: '2026-11-21T09:00:00.000Z',
    checksum: `checksum-sparse-${id}`,
    mimeType: 'application/json',
    rawRef: `raw/sparse-${id}.json`,
    parseStatus: 'PARSED',
    parsedPayload: { targetIdentityRef: id, name: 'Sparse Card' },
  });
}

export async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: await response.json() };
}
