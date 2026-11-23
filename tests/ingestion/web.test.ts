import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSourceConfig } from '../../server/contracts/webHarvest.ts';

const sourcesMod = () => import('../../server/ingest/sources.ts');
const webMod = () => import('../../server/ingest/adapters/web.ts');
const storeMod = () => import('../../server/ingest/store.ts');

const CAPTURED_AT = '2026-11-23T10:00:00.000Z';
const OBSERVED_AT = '2026-11-20T08:30:00.000Z';
const PAGE_URL = 'https://catalog.example.com/listings';

interface FetchCall {
  url: string;
  headers?: Record<string, string>;
}

interface FakeResponse {
  status: number;
  body: string;
  failText?: boolean;
}

function fakeFetch(handler: (call: FetchCall) => FakeResponse) {
  const calls: FetchCall[] = [];
  const impl = async (url: string, init?: { headers?: Record<string, string> }) => {
    const call: FetchCall = { url, headers: init?.headers };
    calls.push(call);
    const response = handler(call);
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      text: async () => {
        if (response.failText) throw new Error('SECRET-TOKEN-MUST-NOT-LEAK');
        return response.body;
      },
    };
  };
  return { impl, calls };
}

function source(overrides: Partial<WebSourceConfig> = {}): WebSourceConfig {
  return {
    id: 'catalog-a',
    name: 'Catalog A',
    url: PAGE_URL,
    kind: 'json',
    enabled: true,
    license: 'CC-BY-4.0',
    respectRobots: false,
    rateLimitMs: 0,
    recordPath: 'data.cards',
    ...overrides,
  };
}

async function harvestWith(configs: WebSourceConfig[], fetchImpl: ReturnType<typeof fakeFetch>['impl'], repos?: ReturnType<typeof import('../../server/ingest/store.ts')['createInMemoryRepositories']>) {
  const { WebSourceRegistry } = await sourcesMod();
  const { harvestWebSources } = await webMod();
  const store = await storeMod();
  const ledger = repos ?? store.createInMemoryRepositories();
  const results = await harvestWebSources({
    repos: ledger,
    registry: new WebSourceRegistry({ sources: configs }),
    fetchImpl,
    capturedAt: CAPTURED_AT,
  });
  return { results, ledger };
}

test('empty allowlist makes zero fetches and writes no evidence', async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: '{}' }));
  const { results, ledger } = await harvestWith([], impl);
  assert.deepEqual(results, []);
  assert.equal(calls.length, 0);
  assert.deepEqual(await ledger.evidence.list({}), []);
  assert.deepEqual(await ledger.marketObservations.list({}), []);
});

test('registry enables/disables sources, stores declared license and exposes only non-secret config', async () => {
  const { WebSourceRegistry } = await sourcesMod();
  const registry = new WebSourceRegistry();
  const added = registry.add({
    ...source({
      url: 'https://catalog.example.com/listings?token=SECRET123',
      rateLimitMs: 1500,
    }),
    ...({ apiKey: 'DO-NOT-STORE', token: 'DO-NOT-STORE' } as Record<string, unknown>),
  } as unknown as WebSourceConfig);

  assert.equal(added.url, PAGE_URL, 'query string (possible secret) must be stripped');
  assert.equal(added.license, 'CC-BY-4.0');
  assert.equal(added.rateLimitMs, 1500);
  assert.equal(JSON.stringify(added).includes('DO-NOT-STORE'), false);
  assert.equal(JSON.stringify(added).includes('SECRET123'), false);
  assert.deepEqual(registry.list().map((item) => item.id), ['catalog-a']);

  registry.setEnabled('catalog-a', false);
  assert.deepEqual(registry.enabled(), []);
  registry.setEnabled('catalog-a', true);
  assert.equal(registry.enabled().length, 1);
  assert.equal(registry.remove('catalog-a'), true);
  assert.equal(registry.list().length, 0);
});

test('robots-disallowed source is skipped without a page fetch', async () => {
  const { impl, calls } = fakeFetch((call) =>
    call.url.endsWith('/robots.txt')
      ? { status: 200, body: 'User-agent: *\nDisallow: /listings\n' }
      : { status: 200, body: '{}' },
  );
  const { results, ledger } = await harvestWith([source({ respectRobots: true })], impl);
  assert.equal(calls.length, 1, 'only robots.txt may be fetched');
  assert.equal(results.length, 1);
  assert.equal(results[0].skippedRobots, true);
  assert.equal(results[0].fetched, 0);
  assert.deepEqual(results[0].candidates, []);
  assert.deepEqual(await ledger.evidence.list({}), []);
});

test('robots-allowed JSON harvest writes immutable ledger evidence and no canonical observations', async () => {
  const body = JSON.stringify({
    data: {
      cards: [
        {
          name: 'Charizard',
          set: 'Base',
          game: 'Pokemon',
          number: '4',
          basis: 'CLAIM',
          amount: 1250,
          currency: 'USD',
          observedAt: OBSERVED_AT,
        },
        {
          name: 'Blastoise',
          basis: 'ASKING',
          amount: 990,
          currency: 'USD',
          observedAt: OBSERVED_AT,
          set: 'Base',
          game: 'Pokemon',
          number: '2',
        },
      ],
    },
  });
  const { impl } = fakeFetch(() => ({ status: 200, body }));
  const { results, ledger } = await harvestWith([source()], impl);

  assert.equal(results.length, 1);
  assert.equal(results[0].fetched, 1);
  assert.equal(results[0].parsed, 2);
  assert.deepEqual(results[0].errors, []);
  assert.equal(results[0].candidates.length, 2);

  const first = results[0].candidates[0];
  assert.equal(first.sourceId, 'catalog-a');
  assert.equal(first.basis, 'CLAIM', 'source basis preserved exactly');
  assert.equal(first.amount, 1250);
  assert.equal(first.currency, 'USD');
  assert.equal(first.observedAt, OBSERVED_AT);
  assert.equal(first.capturedAt, CAPTURED_AT);
  assert.equal(first.license, 'CC-BY-4.0');
  assert.ok(first.evidenceId);
  assert.equal(first.set, 'Base');
  assert.equal(first.game, 'Pokemon');
  assert.equal(first.number, '4');

  const evidence = await ledger.evidence.list({});
  assert.equal(evidence.length, 2);
  const linked = evidence.find((row) => row.id === first.evidenceId);
  assert.ok(linked);
  assert.equal(linked.sourceId, 'web:catalog-a');
  assert.equal(linked.sourceUri, PAGE_URL);
  assert.equal(linked.capturedAt, CAPTURED_AT);
  assert.equal(linked.observedAt, OBSERVED_AT);
  assert.equal(linked.license, 'CC-BY-4.0');
  assert.ok((linked as unknown as { lineage: string[] }).lineage.includes('web'), 'lineage preserved');
  assert.ok(Object.isFrozen(linked), 'evidence record is immutable');
  assert.equal((linked.parsedPayload as Record<string, unknown>).basis, 'CLAIM');
  assert.deepEqual(await ledger.marketObservations.list({}), []);
  assert.deepEqual(await ledger.candidates.list({}), []);

  const before = JSON.stringify(linked);
  await harvestWith([source()], impl, ledger);
  assert.equal((await ledger.evidence.list({})).length, 2, 'rerun is idempotent');
  assert.equal(JSON.stringify(await ledger.evidence.get(linked.id)), before, 'evidence unchanged');
});

test('missing values stay UNKNOWN and basis never defaults to SOLD', async () => {
  const body = JSON.stringify({
    data: {
      cards: [
        { name: 'No Basis Card', amount: 10, currency: 'usd', observedAt: OBSERVED_AT },
        { name: 'Bad Basis Card', basis: 'sold', amount: 0, currency: 'XXX' },
        { name: 'Explicit Sold', basis: 'SOLD', amount: 5, currency: 'USD' },
      ],
    },
  });
  const { impl } = fakeFetch(() => ({ status: 200, body }));
  const { results } = await harvestWith([source()], impl);
  const candidates = results[0].candidates;

  assert.deepEqual(candidates.map((candidate) => candidate.basis), ['UNKNOWN', 'UNKNOWN', 'SOLD']);
  assert.equal(candidates[0].amount, 10);
  assert.equal(candidates[0].set, 'UNKNOWN');
  assert.equal(candidates[0].game, 'UNKNOWN');
  assert.equal(candidates[0].number, 'UNKNOWN');
  assert.equal(candidates[0].currency, 'usd');
  assert.equal(candidates[1].amount, 'UNKNOWN', 'zero amount is not a fact');
  assert.equal(candidates[1].currency, 'UNKNOWN');
  assert.equal(candidates[1].observedAt, 'UNKNOWN');
  assert.ok(candidates[1].warnings.length > 0);
  assert.equal(candidates[0].confidence, 'UNKNOWN');
});

test('HTML selectors extract deterministic records and parse failure yields zero candidates and a safe error', async () => {
  const html = `<html><body>
    <div class="listing"><span class="name">Card One</span><span class="price">42</span>
      <span class="basis">GUIDE</span><span class="set">Set A</span><time datetime="${OBSERVED_AT}">${OBSERVED_AT}</time></div>
    <div class="listing"><span class="name">Card Two</span><span class="price">17</span>
      <span class="basis">CLAIM</span><span class="set">Set B</span></div>
  </body></html>`;
  const htmlSource = source({
    id: 'html-source',
    kind: 'html',
    recordPath: undefined,
    selectors: {
      record: '.listing',
      name: '.name',
      set: '.set',
      basis: '.basis',
      amount: '.price',
      observedAt: 'time',
    },
  });
  const { impl } = fakeFetch(() => ({ status: 200, body: html }));
  const first = await harvestWith([htmlSource], impl);
  assert.equal(first.results[0].parsed, 2);
  assert.deepEqual(first.results[0].candidates.map((candidate) => candidate.name), ['Card One', 'Card Two']);
  assert.deepEqual(first.results[0].candidates.map((candidate) => candidate.basis), ['GUIDE', 'CLAIM']);
  assert.equal(first.results[0].candidates[0].amount, 42);
  assert.equal(first.results[0].candidates[0].set, 'Set A');
  assert.equal(first.results[0].candidates[0].observedAt, OBSERVED_AT);
  assert.equal(first.results[0].candidates[1].observedAt, 'UNKNOWN');

  const second = await harvestWith([htmlSource], impl);
  assert.deepEqual(
    second.results[0].candidates.map((candidate) => candidate.id),
    first.results[0].candidates.map((candidate) => candidate.id),
    'extraction must be deterministic',
  );

  const broken = fakeFetch(() => ({ status: 200, body: '', failText: true }));
  const failed = await harvestWith([htmlSource], broken.impl);
  assert.equal(failed.results[0].parsed, 0);
  assert.deepEqual(failed.results[0].candidates, []);
  assert.ok(failed.results[0].errors.some((message) => message.includes('HTML_PARSE_FAILED')));
  assert.ok(!JSON.stringify(failed.results).includes('SECRET-TOKEN-MUST-NOT-LEAK'));
});

test('per-source rate limit suppresses a second fetch inside the window', async () => {
  const { impl, calls } = fakeFetch(() => ({
    status: 200,
    body: JSON.stringify({ data: { cards: [] } }),
  }));
  const limited = source({ rateLimitMs: 60_000 });
  const { WebSourceRegistry } = await sourcesMod();
  const { harvestWebSources } = await webMod();
  const store = await storeMod();
  let now = 1_000_000;
  const registry = new WebSourceRegistry({ sources: [limited], now: () => now });
  const options = {
    repos: store.createInMemoryRepositories(),
    registry,
    fetchImpl: impl,
    capturedAt: CAPTURED_AT,
    now: () => now,
  };
  const first = await harvestWebSources(options);
  assert.equal(first[0].fetched, 1);
  assert.equal(calls.length, 1);

  now += 1_000;
  const second = await harvestWebSources(options);
  assert.equal(second[0].fetched, 0);
  assert.equal(calls.length, 1, 'rate-limited source must make zero network calls');
  assert.ok(second[0].errors.some((message) => message.includes('RATE_LIMITED')));

  now += 60_000;
  const third = await harvestWebSources(options);
  assert.equal(third[0].fetched, 1);
  assert.equal(calls.length, 2);
});
