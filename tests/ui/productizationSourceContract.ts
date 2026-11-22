import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Productization source-contract suite.
 *
 * These are static contract tests: they assert that the UI surface built by
 * the PRODUCTIZATION lane (a) points at every endpoint planned in the approved
 * data-product design, (b) has replaced the generic collectibles-terminal
 * shell with the trading-card research product shell, and (c) keeps the stable
 * Hermes tool IDs and basis vocabulary intact.
 *
 * The module only *registers* tests. It is imported by both
 * `tests/ui/productizationSourceContract.test.ts` (documented UI location) and
 * `tests/benchmarks/productization.test.ts` (the file actually picked up by
 * the repository's `npm test` glob).
 */

const WORKTREE_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Canonical endpoint list, transcribed from the approved design spec. */
export const REQUIRED_ENDPOINTS = [
  '/api/evidence',
  '/api/observations',
  '/api/ingest/:source',
  '/api/catalog/search',
  '/api/catalog/:id',
  '/api/catalog/:id/printings',
  '/api/pricing/:id',
  '/api/comps/:id',
  '/api/market/:id',
  '/api/intelligence/harvest-legacy',
  '/api/intelligence/discovery-sweep',
  '/api/intelligence/findings',
  '/api/swarm/research/run',
  '/api/swarm/runs/:id',
  '/api/forecasts',
  '/api/forecasts/:id',
  '/api/forecasts/:id/score',
  '/api/forecasts/:id/backtest',
  '/api/learning/state',
  '/api/learning/feedback',
  '/api/learning/run-cycle',
  '/api/sql/query',
  '/api/sql/saved',
] as const;

/** The eight product sections that must appear in the primary navigation. */
export const NAV_LABELS = [
  'Sources',
  'Catalog',
  'Market Intelligence',
  'Research Swarm',
  'Forecast Lab',
  'Learning',
  'SQL Lab',
  /API\s*\/?\s*Hermes/,
] as const;

/** Legacy shell copy that must no longer be advertised in the primary nav. */
export const FORBIDDEN_NAV_COPY = [
  'Run Generic Swarm',
  'Setup Guide',
  'Schema & LLM',
  'Collectibles Terminal',
  'Portfolio Vault',
  'Market Pulse',
  'Agent Swarm',
  'Knowledge Graph',
  'Valuation & Alerts',
  'Hermes Agent',
] as const;

/** Legacy novelty components that must no longer be mounted by the app shell. */
export const FORBIDDEN_APP_IMPORTS = [
  'OnboardingWizard',
  'SchemaBlueprintView',
  'SwarmStudioView',
  'MarketPulseView',
  'PortfolioView',
  'GraphRagExplorerView',
  'ValuationArbitrageView',
  'AddAssetModal',
  'AssetDetailDrawer',
] as const;

/** Hermes tool IDs that are a non-negotiable stable surface. */
export const STABLE_HERMES_TOOLS = [
  'get_collectible_valuation',
  'scan_arbitrage_spreads',
  'query_knowledge_graph',
  'ingest_market_listing',
] as const;

/** Basis vocabulary from the global constraints. */
export const BASIS_VALUES = [
  'SOLD',
  'ASKING',
  'OFFER',
  'GUIDE',
  'CLAIM',
  'POPULATION',
  'UNKNOWN',
] as const;

function readIfExists(relativePath: string): string {
  const full = path.join(WORKTREE_ROOT, relativePath);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function allUiSource(): string {
  return listSourceFiles(path.join(WORKTREE_ROOT, 'src'))
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
}

export function registerProductizationSourceContractTests(): void {
  test('ui contract: primary nav exposes the eight product sections', () => {
    const app = readIfExists('src/App.tsx');
    assert.ok(app.length > 0, 'src/App.tsx must exist');
    for (const label of NAV_LABELS) {
      assert.ok(
        typeof label === 'string' ? app.includes(label) : label.test(app),
        `primary nav must expose ${String(label)}`
      );
    }
  });

  test('ui contract: generic swarm stub and novelty screens are gone from the shell', () => {
    const app = readIfExists('src/App.tsx');
    for (const copy of FORBIDDEN_NAV_COPY) {
      assert.ok(!app.includes(copy), `app shell must not advertise "${copy}"`);
    }
    for (const component of FORBIDDEN_APP_IMPORTS) {
      assert.ok(
        !app.includes(component),
        `app shell must not mount legacy novelty component ${component}`
      );
    }
    const ui = allUiSource();
    assert.ok(
      !/generic\s+swarm/i.test(ui),
      'no "generic swarm" copy may remain anywhere in src/**'
    );
  });

  test('ui contract: every planned API endpoint is referenced by the UI', () => {
    const ui = allUiSource();
    for (const endpoint of REQUIRED_ENDPOINTS) {
      assert.ok(
        ui.includes(endpoint),
        `UI must reference planned endpoint ${endpoint}`
      );
    }
  });

  test('ui contract: product copy is trading-card research, not a collectibles terminal', () => {
    const app = readIfExists('src/App.tsx');
    const ui = allUiSource();
    assert.match(app, /trading[- ]card/i, 'shell must identify as a trading-card product');
    assert.match(
      app,
      /research|data product/i,
      'shell must identify as research/data product'
    );
    assert.ok(
      !app.includes('Collectibles Terminal'),
      'shell must not call itself a Collectibles Terminal'
    );
    for (const view of [
      'SourcesView.tsx',
      'MarketIntelligenceView.tsx',
      'ForecastLabView.tsx',
      'SqlLabView.tsx',
    ]) {
      const source = readIfExists(`src/components/product/${view}`);
      assert.ok(source.length > 0, `${view} must exist`);
      assert.match(source, /trading[- ]card/i, `${view} must use trading-card copy`);
    }
  });

  test('ui contract: basis vocabulary and UNKNOWN sentinel are represented', () => {
    const ui = allUiSource();
    for (const basis of BASIS_VALUES) {
      assert.ok(ui.includes(basis), `basis ${basis} must be represented in the UI`);
    }
  });

  test('ui contract: stable Hermes tool IDs are preserved', () => {
    const ui = allUiSource();
    for (const tool of STABLE_HERMES_TOOLS) {
      assert.ok(ui.includes(tool), `Hermes tool ID ${tool} must remain stable`);
    }
  });
}
