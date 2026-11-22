import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BASIS_VALUES,
  REQUIRED_ENDPOINTS,
  STABLE_HERMES_TOOLS,
  registerProductizationSourceContractTests,
} from '../ui/productizationSourceContract.ts';

/**
 * PRODUCTIZATION benchmark — deterministic golden checks on the Phase 5
 * product surface. Like the existing research benchmark, this is a golden
 * contract suite rather than a performance measurement: it encodes the
 * approved design spec's API groups, the {data,meta} envelope, explicit basis,
 * and full provenance so a future regression is caught without a live service.
 */

const WORKTREE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OPENAPI_PATH = path.join(WORKTREE_ROOT, 'docs/openapi.json');

// The repository's test glob does not descend into tests/ui/, so register the
// UI source-contract suite here as well.
registerProductizationSourceContractTests();

type Json = Record<string, any>;

function readOpenApi(): Json {
  assert.ok(fs.existsSync(OPENAPI_PATH), 'docs/openapi.json must exist');
  return JSON.parse(fs.readFileSync(OPENAPI_PATH, 'utf8')) as Json;
}

function asOpenApiPath(endpoint: string): string {
  return endpoint.replace(/:([A-Za-z]+)/g, '{$1}');
}

const EXPECTED_TAGS = [
  'Evidence & Ingest',
  'Catalog',
  'Market',
  'Intelligence',
  'Swarm',
  'Forecast',
  'Learning',
  'SQL Lab',
];

test('benchmark: productization contract fingerprint is stable', () => {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        eps: [...REQUIRED_ENDPOINTS].sort(),
        nav: [
          'Sources',
          'Catalog',
          'Market Intelligence',
          'Research Swarm',
          'Forecast Lab',
          'Learning',
          'SQL Lab',
          'API / Hermes',
        ].sort(),
        tools: [...STABLE_HERMES_TOOLS].sort(),
        basis: [...BASIS_VALUES].sort(),
      })
    )
    .digest('hex');
  assert.equal(
    fingerprint,
    'df57d077ae628c1056b9003f4a3a90642995acf16fb97378441e3c67ad929799',
    'the agreed endpoint/nav/tool/basis surface must not drift silently'
  );
});

test('benchmark: OpenAPI is 3.1 and declares every planned API group', () => {
  const doc = readOpenApi();
  assert.match(doc.openapi ?? '', /^3\.1\.\d+$/, 'must be an OpenAPI 3.1 document');
  assert.match(doc.info?.title ?? '', /trading card/i);
  const tags: string[] = (doc.tags ?? []).map((t: Json) => t.name);
  for (const tag of EXPECTED_TAGS) {
    assert.ok(tags.includes(tag), `OpenAPI must declare the ${tag} group`);
  }
});

test('benchmark: OpenAPI documents every endpoint planned in the spec', () => {
  const doc = readOpenApi();
  const paths: Json = doc.paths ?? {};
  for (const endpoint of REQUIRED_ENDPOINTS) {
    const key = asOpenApiPath(endpoint);
    assert.ok(paths[key], `OpenAPI must document ${endpoint} (as ${key})`);
  }
});

test('benchmark: every operation returns the {data,meta} envelope', () => {
  const doc = readOpenApi();
  const paths: Json = doc.paths ?? {};
  const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
  let operationCount = 0;
  for (const [route, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item as Json)) {
      if (!methods.has(method)) continue;
      operationCount += 1;
      const op = operation as Json;
      const ok = Object.entries(op.responses ?? {}).find(([code]) =>
        /^2\d\d$/.test(code)
      );
      assert.ok(ok, `${method.toUpperCase()} ${route} must document a 2xx response`);
      assert.match(
        JSON.stringify(ok![1]),
        /ApiEnvelope/,
        `${method.toUpperCase()} ${route} must return the ApiEnvelope`
      );
      if (method === 'post') {
        assert.ok(op.requestBody, `POST ${route} must document a request body`);
      }
    }
  }
  assert.ok(operationCount >= 25, 'all planned operations must be enumerated');
});

test('benchmark: envelope carries provenance and explicit basis', () => {
  const doc = readOpenApi();
  const schemas: Json = doc.components?.schemas ?? {};

  const envelope = schemas.ApiEnvelope ?? {};
  assert.deepEqual(
    [...(envelope.required ?? [])].sort(),
    ['data', 'meta'],
    'the response envelope is exactly { data, meta }'
  );

  const meta = schemas.Meta ?? {};
  for (const field of ['requestId', 'generatedAt', 'contractVersion']) {
    assert.ok((meta.required ?? []).includes(field), `meta must require ${field}`);
  }
  assert.equal(meta.properties?.provenance?.$ref, '#/components/schemas/Provenance');

  const provenance = schemas.Provenance ?? {};
  for (const field of ['source', 'observedAt', 'capturedAt', 'lineage', 'confidence']) {
    assert.ok(
      (provenance.required ?? []).includes(field),
      `provenance must require ${field} (every fact carries provenance)`
    );
  }

  const basis = schemas.Basis ?? {};
  assert.deepEqual(
    [...(basis.enum ?? [])].sort(),
    [...BASIS_VALUES].sort(),
    'basis vocabulary must match the global constraints exactly'
  );
});

test('benchmark: canonical record schemas require provenance', () => {
  const doc = readOpenApi();
  const schemas: Json = doc.components?.schemas ?? {};
  for (const name of [
    'EvidenceRecord',
    'MarketObservation',
    'Finding',
    'Forecast',
    'CatalogItem',
    'PriceSummary',
  ]) {
    const schema = schemas[name];
    assert.ok(schema, `schema ${name} must exist`);
    assert.ok(
      (schema.required ?? []).includes('provenance'),
      `${name} must require provenance`
    );
  }
});

test('benchmark: product copy rules are encoded in the contract description', () => {
  const doc = readOpenApi();
  const description: string = doc.info?.description ?? '';
  assert.match(description, /hypothes/i, 'simulations must be labelled hypotheses');
  assert.match(
    description,
    /never sales evidence/i,
    'simulations must never be sales evidence'
  );
  assert.match(description, /UNKNOWN/, 'missing data must be UNKNOWN');
  assert.match(description, /trading[- ]card/i, 'must describe a trading-card data product');
});
