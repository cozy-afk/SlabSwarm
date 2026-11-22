import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

// Task 7: GraphRAG synthesis must be grounded in first-party evidence.
// The guardrail is a pure, deterministic function so it can be tested without
// a live LLM provider: deterministic facts are authority over LLM output.
import {
  groundGraphRagAnswer,
  extractNumericPrices,
  type GraphRagGroundingInput,
} from '../server/graphRagGuardrails.ts';

const NO_EVIDENCE: GraphRagGroundingInput = {
  question: 'What is the fair market value of this card?',
  draftSynthesis:
    'Based on recent sales, the card is worth approximately $1,250.00. This is a confident market valuation.',
  evidenceFacts: [],
  evidenceIds: [],
  knownBasis: false,
};

/**
 * Step 1 (failing test): with no evidence, the response must deflect — it must
 * say insufficient evidence and must not contain any numeric price. The old
 * prompt permitted a confident answer with an invented price; this test
 * encodes the required deflection before implementation exists.
 */
test('no evidence deflects: synthesis says insufficient evidence and contains no numeric price', () => {
  const result = groundGraphRagAnswer(NO_EVIDENCE);

  assert.equal(result.deflected, true, 'no evidence must set deflected=true');
  assert.match(
    result.synthesis.toLowerCase(),
    /insufficient evidence/,
    'synthesis must explicitly state insufficient evidence'
  );
  assert.deepEqual(
    extractNumericPrices(result.synthesis),
    [],
    'deflected synthesis must contain no numeric price'
  );
  assert.ok(
    result.missingData.length > 0,
    'deflection must enumerate what evidence is missing'
  );
  assert.equal(
    result.confidence,
    'UNKNOWN',
    'no evidence means confidence is UNKNOWN, never defaulted to a factual value'
  );
});

/**
 * A provider that invents an unsupported numeric price must be deflected even
 * when some (unrelated) first-party evidence exists. This is the mechanical
 * numeric-claim verifier called out as a forward-looking concern in Task 6.
 */
test('unbacked numeric price in provider draft is deflected', () => {
  const result = groundGraphRagAnswer({
    question: 'What is the card worth?',
    draftSynthesis: 'The card sold for $999.99 last week [src-1].',
    evidenceFacts: [
      { id: 'src-1', kind: 'researchSource', detail: 'USER_NOTE · seller note · basis=UNKNOWN' },
    ],
    evidenceIds: ['src-1'],
    knownBasis: false,
  });

  assert.equal(result.deflected, true, 'invented $999.99 must trigger deflection');
  assert.match(result.synthesis.toLowerCase(), /insufficient evidence/);
  assert.deepEqual(extractNumericPrices(result.synthesis), []);
});

/**
 * A grounded answer with a cited, evidence-backed number is accepted and the
 * deterministic authority caps confidence. Basis UNKNOWN never yields HIGH.
 */
test('cited evidence-backed answer is grounded with deterministic confidence cap', () => {
  const result = groundGraphRagAnswer({
    question: 'What basis is recorded?',
    draftSynthesis: 'Recorded basis is SOLD at $250.00 [src-1].',
    evidenceFacts: [
      { id: 'src-1', kind: 'researchSource', detail: 'SOLD · sold listing · $250.00 · basis=SOLD' },
    ],
    evidenceIds: ['src-1'],
    knownBasis: true,
  });

  assert.equal(result.deflected, false, 'backed, cited answer must not be deflected');
  assert.match(result.synthesis, /\[src-1\]/, 'grounded answer must retain the evidence-id citation');
  assert.ok(
    result.confidence === 'LOW' || result.confidence === 'MEDIUM',
    'confidence must be capped by deterministic authority, never HIGH by default'
  );
  assert.notEqual(result.confidence, 'HIGH');
});

test('numeric price extraction ignores non-price numbers and finds prices', () => {
  assert.deepEqual(
    extractNumericPrices('lot of 12 cards, grade 9, worth $1,250.00 and $9.50'),
    ['$1,250.00', '$9.50']
  );
  assert.deepEqual(extractNumericPrices('no prices here, only 3 subquestions'), []);
});

/**
 * End-to-end through the real route (no provider configured): the response
 * envelope must expose confidence + missingData and deflect with no price.
 * The plan's review focus is exactly this: a model inventing an unsupported
 * price must be deflected when evidence is insufficient.
 */
test('POST /api/research/question envelope exposes confidence/missingData and deflects without evidence', async () => {
  const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
  const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
  const llmEnvKeys = [
    'GEMINI_API_KEY',
    'HERMES_API_URL',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'OLLAMA_BASE_URL',
  ];
  const originalKeys: Record<string, string | undefined> = {};
  const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-graphrag-envelope-'));
  let server: import('node:http').Server | undefined;
  try {
    process.env.SLABGRAPH_DATA_DIR = tempDataDir;
    process.env.SLABGRAPH_TEST_MODE = '1';
    for (const key of llmEnvKeys) {
      originalKeys[key] = process.env[key];
      delete process.env[key];
    }
    // Fresh module instance with an empty first-party store.
    const { createApp } = await import(
      `../server.ts?graphrag-envelope=${Date.now()}`
    );
    const app = await createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server!.once('listening', () => resolve());
      server!.once('error', reject);
    });
    const { port } = (server as import('node:http').Server).address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    // Confirm the store is empty (no ingest) — no first-party evidence exists.
    const state = await (await fetch(`${baseUrl}/api/research/state`)).json() as {
      counts?: { researchSources?: number; researchObservations?: number };
    };
    assert.equal(state.counts?.researchSources ?? 0, 0, 'test requires an empty source store');

    const res = await fetch(`${baseUrl}/api/research/question`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'What is the exact market value of my card?' }),
    });
    assert.equal(res.status, 201);
    const body = await res.json() as {
      confidence?: number;
      confidenceLabel?: string;
      missingData?: string[];
      deflected?: boolean;
      citations?: string[];
      note?: { synthesis?: string };
    };

    // Response envelope carries grounded fields (Task 7 interface).
    assert.equal(typeof body.confidence, 'number', 'envelope must expose numeric confidence');
    assert.ok(
      ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH'].includes(body.confidenceLabel ?? ''),
      'envelope must expose a deterministic confidence band'
    );
    assert.ok(Array.isArray(body.missingData) && body.missingData.length > 0, 'envelope must expose missingData');
    assert.equal(body.deflected, true, 'no evidence must deflect');
    assert.deepEqual(body.citations ?? [], [], 'no evidence means no citations');

    const synthesis = body.note?.synthesis ?? '';
    assert.match(synthesis.toLowerCase(), /insufficient evidence/);
    assert.deepEqual(extractNumericPrices(synthesis), [], 'deflected answer contains no numeric price');
    // No evidence => confidence is UNKNOWN, never defaulted to a factual band.
    assert.equal(body.confidenceLabel, 'UNKNOWN');
  } finally {
    if (server) server.close();
    if (originalDataDir === undefined) delete process.env.SLABGRAPH_DATA_DIR;
    else process.env.SLABGRAPH_DATA_DIR = originalDataDir;
    if (originalTestMode === undefined) delete process.env.SLABGRAPH_TEST_MODE;
    else process.env.SLABGRAPH_TEST_MODE = originalTestMode;
    for (const key of llmEnvKeys) {
      if (originalKeys[key] === undefined) delete process.env[key];
      else process.env[key] = originalKeys[key];
    }
    fs.rmSync(tempDataDir, { recursive: true, force: true });
  }
});
