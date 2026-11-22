import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const legacyMod = () => import('../../server/ingest/adapters/legacy.ts');
const storeMod = () => import('../../server/ingest/store.ts');
const runnerMod = () => import('../../server/ingest/runner.ts');

const REAL_DB = '/opt/slabswarm/data/slabgraph-db.json';

function smallSnapshot() {
  return {
    updatedAt: '2026-11-22T15:12:35.619Z',
    assets: [
      {
        id: 'A1',
        title: 'Card One',
        setName: 'Base',
        cardNumber: '001',
        releaseYear: 2025,
      },
    ],
    sales: [
      {
        id: 'S1',
        assetId: 'A1',
        rawTitle: 'https://www.ebay.com/itm/123',
        grade: 'PSA 10',
        priceUsd: 250,
        marketplaceId: 'ebay_sold',
        date: '2026-11-20',
        status: 'VERIFIED',
      },
      {
        id: 'S2',
        assetId: 'A1',
        rawTitle: 'custom reprint',
        grade: 'Raw NM',
        priceUsd: 0,
        marketplaceId: 'tcgplayer',
        date: '2026-11-21',
        status: 'QUARANTINED',
        outlierReason: 'suspected custom card',
      },
    ],
  };
}

test('legacy adapter converts assets and sales into raw evidence items with stable keys', async () => {
  const { createLegacyAdapter } = await legacyMod();
  const adapter = createLegacyAdapter({ snapshot: smallSnapshot() });
  const result = await adapter.fetch({
    mode: 'backfill',
    since: null,
    cursor: null,
    capturedAt: '2026-11-22T16:00:00.000Z',
    options: {},
  });
  assert.equal(result.items.length, 3);
  assert.deepEqual(
    result.items.map((i) => i.nativeId),
    ['asset:A1', 'sale:S1', 'sale:S2'],
  );
  assert.equal(result.items[0]?.payload.basis, 'UNKNOWN', 'asset metadata is not a price fact');
  assert.equal(result.items[1]?.payload.basis, 'SOLD', 'explicit sold marketplace');
  assert.equal(result.items[2]?.payload.basis, 'UNKNOWN', 'quarantined sale is not sales evidence');
  assert.equal(result.items[2]?.payload.price, null, 'zero price is UNKNOWN, not free');
  assert.equal(result.items[1]?.sourceUri, 'https://www.ebay.com/itm/123');
});

test('legacy adapter reads the real graph without mutating it (19 assets, 21 sales)', async () => {
  const { createLegacyAdapter, loadLegacySnapshot } = await legacyMod();
  const snapshot = loadLegacySnapshot(REAL_DB) as Record<string, unknown>;
  assert.equal((snapshot.assets as unknown[]).length, 19);
  assert.equal((snapshot.sales as unknown[]).length, 21);
  const before = JSON.stringify(snapshot);
  // Freeze the source graph: any attempt to mutate legacy data throws here.
  const deepFreeze = (value: unknown): void => {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
  };
  deepFreeze(snapshot);
  const adapter = createLegacyAdapter({ snapshot: snapshot as never });
  const result = await adapter.fetch({
    mode: 'backfill',
    since: null,
    cursor: null,
    capturedAt: '2026-11-22T16:00:00.000Z',
    options: {},
  });
  assert.equal(result.items.length, 40);
  assert.equal(JSON.stringify(snapshot), before, 'legacy graph must not be mutated');
});

test('harvest-legacy is idempotent by stable source key and never mutates the snapshot', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const { createLegacyAdapter } = await legacyMod();
  const snapshot = smallSnapshot();
  const before = JSON.stringify(snapshot);
  const repos = createInMemoryRepositories();
  const first = await runIngest(createLegacyAdapter({ snapshot: snapshot as never }), repos, {
    mode: 'backfill',
  });
  assert.equal(first.run.counts.created, 3);
  const second = await runIngest(createLegacyAdapter({ snapshot: snapshot as never }), repos, {
    mode: 'backfill',
  });
  assert.equal(second.run.counts.created, 0);
  assert.equal(second.run.counts.duplicates, 3);
  assert.equal((await repos.evidence.list({ sourceId: 'legacy-graph' })).length, 3);
  assert.equal(JSON.stringify(snapshot), before);
});

test('legacy candidates carry basis, lineage, and UNKNOWN values for missing components', async () => {
  const { createInMemoryRepositories } = await storeMod();
  const { runIngest } = await runnerMod();
  const { createLegacyAdapter } = await legacyMod();
  const repos = createInMemoryRepositories();
  const result = await runIngest(createLegacyAdapter({ snapshot: smallSnapshot() as never }), repos, {
    mode: 'backfill',
  });
  const sold = result.candidates.find((c) => c.targetIdentityRef === 'sale:S1');
  assert.ok(sold);
  assert.equal(sold?.basis, 'SOLD');
  assert.equal(sold?.amount, 250);
  assert.equal(sold?.lineage.length, 1);
  const quarantined = result.candidates.find((c) => c.targetIdentityRef === 'sale:S2');
  assert.equal(quarantined?.basis, 'UNKNOWN');
  assert.equal(quarantined?.amount, null);
  assert.equal(
    (quarantined?.priceComponents as Record<string, unknown>).shipping_amount,
    null,
  );
});

test('loadLegacySnapshot fails clearly when the file is missing', async () => {
  const { loadLegacySnapshot } = await legacyMod();
  assert.throws(
    () => loadLegacySnapshot('/no/such/slabgraph-db.json'),
    /legacy snapshot|ENOENT|not found/i,
  );
  assert.ok(fs.existsSync(REAL_DB));
});

test('legacy snapshot path resolves from SLABGRAPH_DATA_DIR or ./data at call time', async () => {
  const { resolveLegacyDbPath, loadLegacySnapshot } = await legacyMod();
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'slabswarm-legacy-path-'));
  const dataDir = path.join(tempDir, 'data');
  const snapshotPath = path.join(dataDir, 'slabgraph-db.json');
  try {
    mkdirSync(dataDir);
    writeFileSync(snapshotPath, JSON.stringify(smallSnapshot()), 'utf-8');

    // Container-style absolute data dir via environment.
    assert.equal(
      resolveLegacyDbPath({ SLABGRAPH_DATA_DIR: dataDir }, tempDir),
      snapshotPath,
    );
    assert.equal(
      loadLegacySnapshot(resolveLegacyDbPath({ SLABGRAPH_DATA_DIR: dataDir }, tempDir)).assets.length,
      1,
      'a snapshot under SLABGRAPH_DATA_DIR must load',
    );

    // Default ./data is resolved against cwd at call time, never a host path.
    assert.equal(resolveLegacyDbPath({}, tempDir), snapshotPath);
    assert.equal(loadLegacySnapshot(resolveLegacyDbPath({}, tempDir)).sales.length, 2);

    // Re-reading the environment at call time changes the answer.
    assert.notEqual(
      resolveLegacyDbPath({ SLABGRAPH_DATA_DIR: path.join(tempDir, 'other') }, tempDir),
      snapshotPath,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('server source contains no hardcoded /opt paths', async () => {
  const serverDir = path.resolve(
    import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
    '../../server',
  );
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && statSync(full).isFile()
        && readFileSync(full, 'utf-8').includes('/opt/slabswarm')) {
        offenders.push(path.relative(serverDir, full));
      }
    }
  };
  walk(serverDir);
  assert.deepEqual(offenders, [], `hardcoded host paths in server code: ${offenders.join(', ')}`);
});
