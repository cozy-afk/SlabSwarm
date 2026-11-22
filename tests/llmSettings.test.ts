import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-settings-test-'));
process.env.SLABGRAPH_DATA_DIR = dataDir;

const {
  applyStoredSettingsToEnv,
  clearProviderCredentials,
  getProviderConfigView,
  loadStoredRouting,
  saveStoredRouting,
  setProviderCredentials,
} = await import('../server/llmSettings.ts');

const SECRET = 'sk-super-secret-value-12345';

test('stored provider credentials are encrypted at rest and never returned to callers', () => {
  setProviderCredentials('gemini', { GEMINI_API_KEY: SECRET }, 'gemini-4-hydrogen');

  const view = getProviderConfigView('gemini');
  assert.equal(view?.model, 'gemini-4-hydrogen');
  assert.deepEqual(view?.fields, ['GEMINI_API_KEY']);
  assert.equal(JSON.stringify(view).includes(SECRET), false);

  const raw = fs.readFileSync(path.join(dataDir, 'llm-settings.json'), 'utf-8');
  assert.equal(raw.includes(SECRET), false);
  const keyStat = fs.statSync(path.join(dataDir, 'llm-settings.key'));
  assert.equal(keyStat.mode & 0o777, 0o600);
});

test('stored settings are applied to process environment', () => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;

  applyStoredSettingsToEnv();

  assert.equal(process.env.GEMINI_API_KEY, SECRET);
  assert.equal(process.env.GEMINI_MODEL, 'gemini-4-hydrogen');
});

test('routing survives a settings reload', () => {
  saveStoredRouting({
    entityResolution: 'gemini',
    outlierFilter: 'openai',
    catalystSentiment: 'gemini',
    graphRagSynthesis: 'anthropic',
  });

  const reloaded = loadStoredRouting();
  assert.deepEqual(reloaded, {
    entityResolution: 'gemini',
    outlierFilter: 'openai',
    catalystSentiment: 'gemini',
    graphRagSynthesis: 'anthropic',
  });
});

test('clearing credentials removes stored secret and environment value', () => {
  clearProviderCredentials('gemini');

  assert.equal(getProviderConfigView('gemini'), null);
  assert.equal(process.env.GEMINI_API_KEY, undefined);
  assert.equal(loadStoredRouting()?.outlierFilter, 'openai');
});
