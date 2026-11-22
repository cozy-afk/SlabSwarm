// Legacy graph adapter: converts the existing first-party JSON graph into raw
// evidence items with stable source keys. It is strictly read-only — the
// snapshot is deep-frozen by callers/tests and never mutated here. Asset
// metadata carries UNKNOWN basis; only explicitly verified sold marketplaces
// become SOLD. Quarantined/zero-price sales carry UNKNOWN/null.

import fs from 'node:fs';
import path from 'node:path';
import type {
  AdapterFetchContext,
  AdapterFetchResult,
  IngestAdapter,
  RawItem,
} from '../types.ts';

export interface LegacySnapshot {
  updatedAt?: string;
  assets: Array<Record<string, unknown>>;
  sales: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface LegacyAdapterOptions {
  snapshot?: LegacySnapshot | null;
  path?: string;
  loadSnapshot?: () => LegacySnapshot;
}

const LEGACY_DB_FILENAME = 'slabgraph-db.json';

/**
 * Resolve the legacy snapshot at call time. SLABGRAPH_DATA_DIR is the
 * container-friendly override (Docker sets it to /app/data); otherwise ./data
 * is resolved against the current working directory. No host path is baked in.
 */
export function resolveLegacyDbPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const configured = env.SLABGRAPH_DATA_DIR?.trim();
  const dataDir = configured && configured.length > 0 ? configured : './data';
  return path.resolve(cwd, dataDir, LEGACY_DB_FILENAME);
}

export function loadLegacySnapshot(path: string): LegacySnapshot {
  let raw: string;
  try {
    raw = fs.readFileSync(path, 'utf8');
  } catch {
    throw new Error(`legacy snapshot not found or unreadable: ${path}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`legacy snapshot is not valid JSON: ${path}`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as LegacySnapshot).assets) ||
    !Array.isArray((parsed as LegacySnapshot).sales)
  ) {
    throw new Error('legacy snapshot must contain assets and sales arrays');
  }
  return parsed as LegacySnapshot;
}

function isUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

export function createLegacyAdapter(options: LegacyAdapterOptions): IngestAdapter {
  const resolveSnapshot = (): LegacySnapshot => {
    if (options.snapshot) return options.snapshot;
    if (options.loadSnapshot) return options.loadSnapshot();
    // Resolved inside fetch(), so a change to SLABGRAPH_DATA_DIR after router
    // construction is picked up on the next request.
    return loadLegacySnapshot(options.path ?? resolveLegacyDbPath());
  };

  return {
    id: 'legacy-graph',
    sourceId: 'legacy-graph',
    async fetch(ctx: AdapterFetchContext): Promise<AdapterFetchResult> {
      const snapshot = resolveSnapshot();
      const assets = Array.isArray(snapshot.assets) ? snapshot.assets : [];
      const sales = Array.isArray(snapshot.sales) ? snapshot.sales : [];
      const items: RawItem[] = [];

      const snapshotTime = stringField(snapshot.updatedAt);
      for (const asset of assets) {
        if (asset === null || typeof asset !== 'object') continue;
        const id = String((asset as Record<string, unknown>).id ?? 'unknown');
        const nativeId = `asset:${id}`;
        const payload: Record<string, unknown> = {
          source: 'legacy-graph',
          recordType: 'ASSET',
          targetIdentityRef: nativeId,
          title: stringField((asset as Record<string, unknown>).title),
          setName: stringField((asset as Record<string, unknown>).setName),
          cardNumber: stringField((asset as Record<string, unknown>).cardNumber),
          releaseYear: (asset as Record<string, unknown>).releaseYear ?? null,
          // Asset metadata is not a price fact. Basis is never inferred.
          basis: 'UNKNOWN',
          price: null,
          currency: 'UNKNOWN',
        };
        // Never embed capturedAt in the checksummed payload: it changes every
        // run and would defeat idempotency by source + native id + checksum.
        if (snapshotTime) payload.observedAt = snapshotTime;
        items.push({
          nativeId,
          observedAt: snapshotTime ?? ctx.capturedAt,
          payload,
          sourceUri: null,
          mimeType: 'application/json',
        });
      }

      for (const sale of sales) {
        if (sale === null || typeof sale !== 'object') continue;
        const row = sale as Record<string, unknown>;
        const id = String(row.id ?? 'unknown');
        const nativeId = `sale:${id}`;
        const marketplace = stringField(row.marketplaceId);
        const status = stringField(row.status);
        const sold =
          status === 'VERIFIED' && marketplace !== null && /sold/i.test(marketplace);
        const basis = sold ? 'SOLD' : 'UNKNOWN';
        const price = sold ? finitePositive(row.priceUsd) : null;
        const rawTitle = row.rawTitle;
        const saleTime = stringField(row.date) ?? snapshotTime;
        const payload: Record<string, unknown> = {
          source: 'legacy-graph',
          recordType: 'SALE',
          targetIdentityRef: nativeId,
          title: stringField(rawTitle),
          basis,
          price,
          currency: price === null ? 'UNKNOWN' : 'USD',
          marketplace,
          grade: stringField(row.grade),
          condition: null,
          status,
        };
        if (saleTime) payload.observedAt = saleTime;
        items.push({
          nativeId,
          observedAt: saleTime ?? ctx.capturedAt,
          payload,
          sourceUri: isUrl(rawTitle) ? rawTitle : null,
          mimeType: 'application/json',
        });
      }

      return {
        items,
        meta: {
          assetCount: items.filter((i) => i.nativeId.startsWith('asset:')).length,
          saleCount: items.filter((i) => i.nativeId.startsWith('sale:')).length,
        },
      };
    },
  };
}
