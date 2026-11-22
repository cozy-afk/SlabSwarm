import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Source contract for the Market Intelligence card picker (Task 3 of the
 * UI-contract repair plan). Static assertions keep the browser bundle honest:
 * the Price & comps panel must offer a selectable list of real cards sourced
 * from the active report, selection must drive the three detail endpoints,
 * and no placeholder copy or credentials may leak into the client.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const VIEW = 'src/components/product/MarketIntelligenceView.tsx';

function read(relativePath: string): string {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function selectBlock(view: string): string {
  const start = view.indexOf('<select');
  assert.ok(start >= 0, 'the view must render a <select> card picker');
  const end = view.indexOf('</select>', start);
  assert.ok(end > start, 'the <select> card picker must be closed');
  return view.slice(start, end);
}

test('picker: active report is loaded as the card source via useEnvelope', () => {
  const view = read(VIEW);
  assert.match(
    view,
    /useEnvelope<ActiveReport>\(ROUTES\.activeReport\)/,
    'the view must load the active report through the existing useEnvelope hook'
  );
  assert.ok(
    /report\.data\??\.cards/.test(view),
    'picker options must be derived from the active-report cards'
  );
  assert.ok(
    view.includes('ROUTES.activeReport'),
    'the picker must reference the active-report route'
  );
});

test('picker: a labelled select lists real cards with name, set, game and id', () => {
  const view = read(VIEW);
  assert.match(view, /aria-label="Select a trading card"/, 'the select must be labelled as a card picker');
  const block = selectBlock(view);
  for (const token of [
    'card.name',
    'card.set',
    'card.game',
    'card.id',
    '<option',
    'value={card.id}',
    'reportOptions.map(',
  ]) {
    assert.ok(block.includes(token), `picker option must include ${token}`);
  }
});

test('picker: selecting a card drives pricing, comps and market detail paths', () => {
  const view = read(VIEW);
  const block = selectBlock(view);
  assert.match(block, /onChange=/, 'select must react to a selection');
  assert.match(block, /setActiveTarget\(/, 'selection must set the active target id');
  for (const route of ['pricing', 'comps', 'market']) {
    assert.ok(
      view.includes(`buildRoute(ROUTES.${route}, { id: activeTarget })`),
      `${route} path must be keyed on the selected activeTarget`
    );
  }
});

test('picker: no placeholders, credentials or invented data in the view', () => {
  const view = read(VIEW);
  // Split literals so this test can name banned tokens without being flagged
  // by a future repo-wide placeholder scan.
  const banned = [
    'TO' + 'DO',
    'Lo' + 'rem',
    'Coming' + ' soon',
    'T' + 'BD',
    'FI' + 'XME',
    'mo' + 'ck',
    'du' + 'mmy',
    'place' + 'holder',
  ];
  for (const token of banned) {
    assert.ok(
      !view.toLowerCase().includes(token.toLowerCase()),
      `view must not contain placeholder copy "${token}"`
    );
  }
  assert.ok(
    !view.includes('Enter a resolved trading-card id to load pricing, comps and market data.'),
    'the manual-id-only prompt must be removed'
  );
  assert.ok(
    !/api[_-]?key|apikey|secret|password|bearer\s/i.test(view),
    'no credentials may appear in client code'
  );
  // Frozen display rules must survive the picker change.
  assert.match(view, /'UNKNOWN'/, 'UNKNOWN sentinel must remain verbatim');
  assert.match(view, /ProvenanceLine/, 'source and observed_at display must remain');
  assert.match(view, /BasisChip/, 'explicit basis display must remain');
});
