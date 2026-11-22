import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { LLMProviderId, SwarmRoutingConfig } from '../src/types/graph.ts';

export interface StoredProviderView {
  fields: string[];
  model: string;
}

interface StoredProviderRecord {
  encrypted: string;
  fields: string[];
  model: string;
}

interface SettingsFile {
  schemaVersion: 1;
  routing: SwarmRoutingConfig | null;
  providers: Partial<Record<LLMProviderId, StoredProviderRecord>>;
}

export const PROVIDER_ENV_FIELDS: Record<LLMProviderId, string[]> = {
  gemini: ['GEMINI_API_KEY'],
  hermes: ['HERMES_API_URL', 'HERMES_API_KEY'],
  openai: ['OPENAI_API_KEY', 'OPENAI_BASE_URL'],
  anthropic: ['ANTHROPIC_API_KEY'],
  ollama: ['OLLAMA_BASE_URL'],
};

export const PROVIDER_MODEL_ENV: Record<LLMProviderId, string> = {
  gemini: 'GEMINI_MODEL',
  hermes: 'HERMES_MODEL',
  openai: 'OPENAI_MODEL',
  anthropic: 'ANTHROPIC_MODEL',
  ollama: 'OLLAMA_MODEL',
};

const PROVIDER_IDS = Object.keys(PROVIDER_ENV_FIELDS) as LLMProviderId[];

function resolvePaths(): { dir: string; settingsPath: string; keyPath: string } {
  const configured = process.env.SLABGRAPH_DATA_DIR?.trim();
  const dir = path.resolve(configured || path.join(process.cwd(), 'data'));
  return {
    dir,
    settingsPath: path.join(dir, 'llm-settings.json'),
    keyPath: path.join(dir, 'llm-settings.key'),
  };
}

function getEncryptionKey(): Buffer {
  const { dir, keyPath } = resolvePaths();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(keyPath)) {
    const key = Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'base64');
    if (key.length !== 32) throw new Error('LLM settings key is invalid.');
    return key;
  }
  const key = crypto.randomBytes(32);
  try {
    const fd = fs.openSync(keyPath, 'wx', 0o600);
    fs.writeFileSync(fd, key.toString('base64') + '\n', 'utf-8');
    fs.closeSync(fd);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  return Buffer.from(fs.readFileSync(keyPath, 'utf-8').trim(), 'base64');
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf-8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((b) => b.toString('base64')).join(':');
}

function decrypt(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Stored LLM credential record is malformed.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getEncryptionKey(),
    Buffer.from(ivB64, 'base64')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]).toString('utf-8');
}

function emptySettings(): SettingsFile {
  return { schemaVersion: 1, routing: null, providers: {} };
}

function loadSettings(): SettingsFile {
  const { settingsPath } = resolvePaths();
  if (!fs.existsSync(settingsPath)) return emptySettings();
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Partial<SettingsFile>;
    return {
      schemaVersion: 1,
      routing: parsed.routing || null,
      providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {},
    };
  } catch {
    return emptySettings();
  }
}

function saveSettings(settings: SettingsFile): void {
  const { dir, settingsPath } = resolvePaths();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, settingsPath);
}

function assertProvider(id: LLMProviderId): void {
  if (!PROVIDER_IDS.includes(id)) throw new Error(`Unknown LLM provider: ${id}`);
}

export function setProviderCredentials(
  id: LLMProviderId,
  credentials: Record<string, string>,
  model?: string
): StoredProviderView {
  assertProvider(id);
  const settings = loadSettings();
  const allowed = PROVIDER_ENV_FIELDS[id];
  const clean: Record<string, string> = {};
  for (const field of allowed) {
    const value = credentials[field];
    if (typeof value === 'string' && value.trim().length > 0) clean[field] = value.trim();
  }
  if (Object.keys(clean).length === 0) {
    throw new Error(`No valid credential fields supplied for ${id}.`);
  }
  const previous = settings.providers[id];
  const nextModel = model?.trim() || previous?.model || process.env[PROVIDER_MODEL_ENV[id]] || '';
  settings.providers[id] = {
    encrypted: encrypt(JSON.stringify(clean)),
    fields: Object.keys(clean),
    model: nextModel,
  };
  saveSettings(settings);
  return { fields: Object.keys(clean), model: nextModel };
}

export function getProviderConfigView(id: LLMProviderId): StoredProviderView | null {
  assertProvider(id);
  const record = loadSettings().providers[id];
  if (!record) return null;
  return { fields: record.fields, model: record.model };
}

export function hasStoredCredentials(id: LLMProviderId): boolean {
  return Boolean(loadSettings().providers[id]);
}

export function clearProviderCredentials(id: LLMProviderId): void {
  assertProvider(id);
  const settings = loadSettings();
  const record = settings.providers[id];
  if (!record) return;
  let decrypted: Record<string, string> = {};
  try {
    decrypted = JSON.parse(decrypt(record.encrypted)) as Record<string, string>;
  } catch {
    decrypted = {};
  }
  for (const field of record.fields) {
    if (process.env[field] === decrypted[field]) delete process.env[field];
  }
  const modelEnv = PROVIDER_MODEL_ENV[id];
  if (process.env[modelEnv] === record.model) delete process.env[modelEnv];
  delete settings.providers[id];
  saveSettings(settings);
}

export function saveStoredRouting(routing: SwarmRoutingConfig): void {
  const settings = loadSettings();
  settings.routing = { ...routing };
  saveSettings(settings);
}

export function loadStoredRouting(): SwarmRoutingConfig | null {
  return loadSettings().routing;
}

export function applyStoredSettingsToEnv(): void {
  const settings = loadSettings();
  for (const id of PROVIDER_IDS) {
    const record = settings.providers[id];
    if (!record) continue;
    let secrets: Record<string, string>;
    try {
      secrets = JSON.parse(decrypt(record.encrypted)) as Record<string, string>;
    } catch (err) {
      console.error(`Failed to decrypt stored credentials for ${id}:`, err);
      continue;
    }
    for (const field of record.fields) {
      if (typeof secrets[field] === 'string') process.env[field] = secrets[field];
    }
    if (record.model) process.env[PROVIDER_MODEL_ENV[id]] = record.model;
  }
}
