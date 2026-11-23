import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  WebHarvestResult,
  WebSourceConfig,
} from '../../server/contracts/webHarvest.ts';
import {
  REGISTERED_TOOLS,
  buildEvidencePacket,
  type EvidenceItem,
} from '../../server/swarm/tools.ts';
import { reviewProposals, runRole } from '../../server/swarm/roles.ts';
import {
  WEB_TOOL_NAMES,
  createWebTools,
  harvestWebSource,
  invokeWebTool,
  proposeWebCandidate,
  searchWebSources,
} from '../../server/swarm/webTools.ts';

const NOW = '2026-11-23T00:00:00.000Z';

const SOURCES: WebSourceConfig[] = [
  {
    id: 'public-catalog',
    name: 'Public catalog',
    url: 'https://example.com/catalog.json?token=TOP_SECRET&page=1',
    kind: 'json',
    enabled: true,
    license: 'CC-BY-4.0',
    recordPath: 'records',
    respectRobots: true,
    rateLimitMs: 0,
    provenanceNote: 'operator configured public catalog',
  },
  {
    id: 'disabled-feed',
    name: 'Disabled feed',
    url: 'https://example.com/private.json?key=TOP_SECRET',
    kind: 'json',
    enabled: false,
    license: 'PROPRIETARY',
    recordPath: 'records',
    respectRobots: true,
    rateLimitMs: 0,
  },
];

const CATALOG = {
  records: [
    {
      name: 'Charizard',
      set: 'Base',
      game: 'pokemon',
      number: '4',
      basis: 'GUIDE',
      amount: 120,
      currency: 'USD',
      observedAt: '2026-03-01T00:00:00.000Z',
    },
    {
      name: 'Blastoise',
      set: 'Base',
      game: 'pokemon',
      number: '2',
      observedAt: '2026-03-02T00:00:00.000Z',
    },
  ],
};

interface StubResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

type FetchStub = (url: string) => Promise<StubResponse>;

function fetchStub(body: unknown): { fetch: FetchStub; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url: string): Promise<StubResponse> => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    },
  };
}

test('web source tools are registered in the closed allowlist', () => {
  assert.deepEqual([...WEB_TOOL_NAMES], ['search_web_sources', 'harvest_web_source']);
  for (const name of WEB_TOOL_NAMES) {
    assert.ok(REGISTERED_TOOLS.includes(name), `${name} must be registered`);
  }
  assert.equal(
    (REGISTERED_TOOLS as readonly string[]).filter((name) => name === 'write_canonical_fact').length,
    0,
  );
});

test('search_web_sources returns only enabled sources and no secrets', () => {
  const result = searchWebSources({ sources: SOURCES });
  const ids = (result as { items: Array<{ id: string }> }).items.map((i) => i.id);
  assert.deepEqual(ids, ['public-catalog']);
  assert.ok(!JSON.stringify(result).includes('TOP_SECRET'));
  const url = (result as { items: Array<{ url: string }> }).items[0].url;
  assert.equal(url, 'https://example.com/catalog.json');
});

test('search_web_sources filters by query and is deterministic', () => {
  const a = searchWebSources({ sources: SOURCES, query: 'CATALOG' });
  const b = searchWebSources({ sources: SOURCES, query: 'CATALOG' });
  assert.deepEqual(a, b);
  assert.equal((a as { items: unknown[] }).items.length, 1);
  assert.equal((a as { items: unknown[] }).items.length > 0, true);
  assert.deepEqual(
    (searchWebSources({ sources: SOURCES, query: 'disabled' }) as { items: unknown[] }).items,
    [],
  );
});

test('invokeWebTool dispatches search_web_sources through the closed registry', async () => {
  const stub = fetchStub(CATALOG);
  const result = await invokeWebTool(
    { tool: 'search_web_sources', args: { query: 'public' } },
    { sources: SOURCES, fetchImpl: stub.fetch, now: () => NOW },
  );
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'search_web_sources');
  assert.deepEqual(result.evidenceIds, []);
  assert.deepEqual(stub.calls, [], 'source discovery must not fetch');
});

test('createWebTools exposes the exact registered tool names', () => {
  const tools = createWebTools({ sources: SOURCES, fetchImpl: fetchStub(CATALOG).fetch });
  for (const name of WEB_TOOL_NAMES) {
    assert.equal(typeof tools[name], 'function');
  }
  assert.equal((tools as object & { write_canonical_fact?: unknown }).write_canonical_fact, undefined);
});

test('harvest_web_source returns a bounded evidence packet with resolving ids and no canonical write', async () => {
  const stub = fetchStub(CATALOG);
  const result = await harvestWebSource({
    sources: SOURCES,
    fetchImpl: stub.fetch,
    now: () => NOW,
    sourceId: 'public-catalog',
  });
  assert.equal(result.ok, true);
  assert.equal(result.tool, 'harvest_web_source');
  assert.deepEqual(stub.calls, ['https://example.com/catalog.json?token=TOP_SECRET&page=1']);
  const data = result.data as {
    packet: { items: unknown[]; evidenceIds: string[]; digest: string; truncated: boolean };
    harvest: WebHarvestResult;
    canonicalWrites: number;
    status: string;
  };
  assert.ok(data.packet.evidenceIds.length > 0);
  assert.deepEqual(result.evidenceIds, data.packet.evidenceIds);
  assert.ok(result.evidenceIds.every((id) => data.packet.evidenceIds.includes(id)));
  assert.ok(data.packet.items.length <= 12);
  assert.equal(data.canonicalWrites, 0);
  assert.equal(data.status, 'PROPOSAL');
  assert.equal(data.harvest.sourceId, 'public-catalog');
  assert.equal(data.harvest.fetched, 1);
  assert.equal(data.harvest.parsed, 2);
  assert.equal(data.harvest.candidates.length, 2);
  assert.equal(data.harvest.skippedRobots, false);
  assert.deepEqual(data.harvest.errors, []);
  assert.ok(!JSON.stringify(result).includes('TOP_SECRET'));
});

test('harvest_web_source never fetches a disabled source', async () => {
  const stub = fetchStub(CATALOG);
  const result = await harvestWebSource({
    sources: SOURCES,
    fetchImpl: stub.fetch,
    now: () => NOW,
    sourceId: 'disabled-feed',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SOURCE_DISABLED');
  assert.deepEqual(result.evidenceIds, []);
  assert.deepEqual(stub.calls, []);
});

test('harvest_web_source is deterministic for a fixed fetch stub and clock', async () => {
  const run = async () => harvestWebSource({
    sources: SOURCES,
    fetchImpl: fetchStub(CATALOG).fetch,
    now: () => NOW,
    sourceId: 'public-catalog',
  });
  assert.deepEqual(await run(), await run());
});

test('harvest_web_source bounds the packet and preserves UNKNOWN instead of inventing values', async () => {
  const result = await harvestWebSource({
    sources: SOURCES,
    fetchImpl: fetchStub(CATALOG).fetch,
    now: () => NOW,
    sourceId: 'public-catalog',
    maxItems: 1,
    maxCharsPerItem: 40,
  });
  const data = result.data as {
    packet: {
      items: Array<{ id: string; summary: string; basis?: string; amount?: number | null }>;
      truncated: boolean;
      totalAvailable: number;
    };
  };
  assert.equal(data.packet.items.length, 1);
  assert.equal(data.packet.totalAvailable, 2);
  assert.equal(data.packet.truncated, true);
  assert.equal(data.packet.items[0].summary.length <= 40, true);
  assert.deepEqual(result.evidenceIds, [data.packet.items[0].id]);
  const full = await harvestWebSource({
    sources: SOURCES,
    fetchImpl: fetchStub(CATALOG).fetch,
    now: () => NOW,
    sourceId: 'public-catalog',
  });
  const fullItems = (full.data as { packet: { items: Array<{ basis?: string; amount?: number | null }> } })
    .packet.items;
  const unknown = fullItems.find((i) => i.basis === 'UNKNOWN');
  assert.ok(unknown, 'UNKNOWN basis must survive extraction');
  assert.equal(unknown?.amount, null, 'missing amount must be null, never zero');
});

test('invokeWebTool dispatches harvest_web_source with the same bounded envelope', async () => {
  const stub = fetchStub(CATALOG);
  const result = await invokeWebTool(
    { tool: 'harvest_web_source', args: { sourceId: 'public-catalog' } },
    { sources: SOURCES, fetchImpl: stub.fetch, now: () => NOW },
  );
  assert.equal(result.ok, true);
  const packet = (result.data as { packet: { evidenceIds: string[] } }).packet;
  assert.deepEqual(result.evidenceIds, packet.evidenceIds);
});

test('unknown source ids are rejected without any fetch', async () => {
  const stub = fetchStub(CATALOG);
  const result = await harvestWebSource({
    sources: SOURCES,
    fetchImpl: stub.fetch,
    now: () => NOW,
    sourceId: 'not-in-allowlist',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SOURCE_NOT_IN_ALLOWLIST');
  assert.deepEqual(stub.calls, []);
});

test('web candidate proposals without evidence ids are rejected', () => {
  const packet = buildEvidencePacket({ items: [] as EvidenceItem[] });
  const result = proposeWebCandidate({
    packet,
    evidenceIds: [],
    source: 'web:public-catalog',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'EVIDENCE_IDS_REQUIRED');
  assert.deepEqual(result.evidenceIds, []);
});

test('web candidate proposals citing ids outside the packet are rejected', () => {
  const packet = buildEvidencePacket({ items: [] as EvidenceItem[] });
  const result = proposeWebCandidate({ packet, evidenceIds: ['web-forged'] });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'EVIDENCE_ID_NOT_IN_PACKET');
  assert.deepEqual(result.evidenceIds, []);
});

test('web candidate proposals carry citations and proposal status only', async () => {
  const result = await harvestWebSource({
    sources: SOURCES,
    fetchImpl: fetchStub(CATALOG).fetch,
    now: () => NOW,
    sourceId: 'public-catalog',
  });
  const packet = (result.data as { packet: { items: EvidenceItem[] } & Parameters<typeof buildEvidencePacket>[0] })
    .packet as ReturnType<typeof buildEvidencePacket>;
  const proposal = proposeWebCandidate({
    packet,
    evidenceIds: [packet.evidenceIds[0]],
    source: packet.items[0].source,
  });
  assert.equal(proposal.ok, true);
  const data = proposal.data as {
    type: string;
    status: string;
    citations: string[];
    evidenceIds: string[];
    canonicalWrites: number;
  };
  assert.equal(data.type, 'WEB_CANDIDATE');
  assert.equal(data.status, 'PROPOSED');
  assert.deepEqual(data.citations, [packet.evidenceIds[0]]);
  assert.deepEqual(data.evidenceIds, [packet.evidenceIds[0]]);
  assert.equal(data.canonicalWrites, 0);
});

test('review gate rejects unbacked proposals but accepts cited web packet proposals', async () => {
  const result = await harvestWebSource({
    sources: SOURCES,
    fetchImpl: fetchStub(CATALOG).fetch,
    now: () => NOW,
    sourceId: 'public-catalog',
  });
  const data = result.data as {
    packet: ReturnType<typeof buildEvidencePacket>;
    proposals: Array<{ id: string; evidenceIds: string[] }>;
  };
  const reviewed = reviewProposals({
    packet: data.packet,
    proposals: [
      ...data.proposals,
      { id: 'p-unbacked', evidenceIds: [] },
    ],
  });
  assert.equal(reviewed.decision, 'PARTIAL');
  assert.equal(reviewed.accepted.length, data.proposals.length);
  assert.deepEqual(reviewed.rejected.map((r) => r.reason), ['NO_EVIDENCE_IDS']);
  assert.ok(reviewed.accepted.every((p) => p.evidenceIds.every((id) => data.packet.evidenceIds.includes(id))));
});

const WEB_EVIDENCE: EvidenceItem[] = [
  {
    id: 'web-ev-1',
    source: 'web:public-catalog',
    observedAt: '2026-03-01T00:00:00.000Z',
    capturedAt: NOW,
    basis: 'GUIDE',
    confidence: 'LOW',
    kind: 'web-candidate',
    amount: 120,
    summary: 'WEB PROPOSAL (NOT A FACT): Charizard | basis=GUIDE | citations=web-ev-1',
  },
];

test('evidence-scout emits structured web citations and labels them proposals', () => {
  const packet = buildEvidencePacket({ items: WEB_EVIDENCE });
  const out = runRole('evidence_scout', packet);
  const claim = out.claims[0] as unknown as {
    source: string;
    observed_at: string;
    basis: string;
    confidence: string;
    citations: string[];
    status: string;
    text: string;
  };
  assert.equal(claim.source, 'web:public-catalog');
  assert.equal(claim.observed_at, '2026-03-01T00:00:00.000Z');
  assert.equal(claim.basis, 'GUIDE');
  assert.equal(claim.confidence, 'LOW');
  assert.deepEqual(claim.citations, ['web-ev-1']);
  assert.deepEqual((claim as unknown as { evidenceIds: string[] }).evidenceIds, ['web-ev-1']);
  assert.equal(claim.status, 'PROPOSAL');
  assert.match(claim.text, /PROPOSAL|hypothesis/i);
  assert.ok(!JSON.stringify(out).includes('CANONICAL_WRITE'));
});

test('evidence-scout web proposals stay hypotheses with in-packet citations', () => {
  const packet = buildEvidencePacket({ items: WEB_EVIDENCE });
  const out = runRole('evidence_scout', packet);
  assert.ok(out.proposal, 'evidence-scout must emit a web proposal');
  assert.equal(out.proposal.status, 'HYPOTHESIS');
  assert.deepEqual(out.proposal.evidenceIds, ['web-ev-1']);
  const data = out.proposal as unknown as {
    source: string;
    observed_at: string;
    basis: string;
    confidence: string;
    citations: string[];
  };
  assert.equal(data.source, 'web:public-catalog');
  assert.equal(data.observed_at, '2026-03-01T00:00:00.000Z');
  assert.equal(data.basis, 'GUIDE');
  assert.equal(data.confidence, 'LOW');
  assert.deepEqual(data.citations, ['web-ev-1']);
  assert.deepEqual(runRole('evidence_scout', packet), out);
});
