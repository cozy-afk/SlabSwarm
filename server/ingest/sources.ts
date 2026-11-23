// Operator-controlled web source registry. The allowlist is the only source
// of truth: an empty registry means zero network calls. Config is normalised
// here so no query string, credential or unknown field (which might be a
// secret) is ever stored, returned or logged downstream.

import type { WebSourceConfig, SourceKind } from '../contracts/webHarvest.ts';

export class WebSourceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebSourceConfigError';
  }
}

/** Only these fields are part of the public, non-secret configuration. */
const CONFIG_KEYS = [
  'id',
  'name',
  'url',
  'kind',
  'enabled',
  'license',
  'recordPath',
  'selectors',
  'respectRobots',
  'rateLimitMs',
  'provenanceNote',
] as const;

const BASES = new Set(['SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', 'UNKNOWN']);

export interface WebSourceRegistryOptions {
  sources?: WebSourceConfig[];
  /** Injectable clock used by the per-source rate limiter. */
  now?: () => number;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WebSourceConfigError(`${label} is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Drops query/hash and credentials. A source URL must never carry a token:
 * URLs are returned by the API and can be echoed in error messages.
 */
export function sanitizeSourceUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new WebSourceConfigError('url is required and must be a non-empty string');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new WebSourceConfigError('url must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebSourceConfigError('url must use http or https');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new WebSourceConfigError('url must not contain credentials');
  }
  return `${parsed.origin}${parsed.pathname}`;
}

export function validateSourceConfig(input: unknown): WebSourceConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new WebSourceConfigError('source config must be an object');
  }
  const raw = input as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== 'json' && kind !== 'html') {
    throw new WebSourceConfigError('kind must be json or html');
  }
  if (typeof raw.enabled !== 'boolean') {
    throw new WebSourceConfigError('enabled must be a boolean');
  }
  if (typeof raw.respectRobots !== 'boolean') {
    throw new WebSourceConfigError('respectRobots must be a boolean');
  }
  const rateLimitMs = raw.rateLimitMs;
  if (typeof rateLimitMs !== 'number' || !Number.isFinite(rateLimitMs) || rateLimitMs < 0) {
    throw new WebSourceConfigError('rateLimitMs must be a non-negative number');
  }
  let selectors: Record<string, string> | undefined;
  if (raw.selectors !== undefined && raw.selectors !== null) {
    if (typeof raw.selectors !== 'object' || Array.isArray(raw.selectors)) {
      throw new WebSourceConfigError('selectors must be an object of field to selector strings');
    }
    selectors = {};
    for (const [key, value] of Object.entries(raw.selectors as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim() !== '') selectors[key] = value;
    }
  }
  if (raw.recordPath !== undefined && typeof raw.recordPath !== 'string') {
    throw new WebSourceConfigError('recordPath must be a string');
  }
  if (raw.provenanceNote !== undefined && typeof raw.provenanceNote !== 'string') {
    throw new WebSourceConfigError('provenanceNote must be a string');
  }
  const config: WebSourceConfig = {
    id: nonEmptyString(raw.id, 'id'),
    name: nonEmptyString(raw.name, 'name'),
    url: sanitizeSourceUrl(raw.url),
    kind: kind as SourceKind,
    enabled: raw.enabled,
    license: nonEmptyString(raw.license, 'license'),
    respectRobots: raw.respectRobots,
    rateLimitMs,
  };
  if (typeof raw.recordPath === 'string' && raw.recordPath.trim() !== '') {
    config.recordPath = raw.recordPath;
  }
  if (selectors && Object.keys(selectors).length > 0) config.selectors = selectors;
  if (typeof raw.provenanceNote === 'string' && raw.provenanceNote.trim() !== '') {
    config.provenanceNote = raw.provenanceNote;
  }
  return config;
}

/** Defensive copy built from known keys only; never exposes injected fields. */
export function publicSourceConfig(config: WebSourceConfig): WebSourceConfig {
  const out = {} as Record<string, unknown>;
  for (const key of CONFIG_KEYS) {
    const value = (config as unknown as Record<string, unknown>)[key];
    if (value !== undefined) out[key] = key === 'selectors' ? { ...(value as Record<string, string>) } : value;
  }
  return out as unknown as WebSourceConfig;
}

export class WebSourceRegistry {
  private readonly sources = new Map<string, WebSourceConfig>();
  private readonly lastFetchAt = new Map<string, number>();
  private readonly now: () => number;

  constructor(options: WebSourceRegistryOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    for (const config of options.sources ?? []) this.add(config);
  }

  add(input: WebSourceConfig): WebSourceConfig {
    const config = validateSourceConfig(input);
    if (this.sources.has(config.id)) {
      throw new WebSourceConfigError(`duplicate source id: ${config.id}`);
    }
    this.sources.set(config.id, config);
    return publicSourceConfig(config);
  }

  upsert(input: WebSourceConfig): WebSourceConfig {
    const config = validateSourceConfig(input);
    this.sources.set(config.id, config);
    return publicSourceConfig(config);
  }

  get(id: string): WebSourceConfig | undefined {
    const config = this.sources.get(id);
    return config ? publicSourceConfig(config) : undefined;
  }

  /** Internal use only: returns the validated, immutable-by-convention object. */
  getInternal(id: string): WebSourceConfig | undefined {
    return this.sources.get(id);
  }

  list(): WebSourceConfig[] {
    return [...this.sources.values()].map(publicSourceConfig);
  }

  enabled(): WebSourceConfig[] {
    return [...this.sources.values()].filter((config) => config.enabled).map(publicSourceConfig);
  }

  setEnabled(id: string, enabled: boolean): WebSourceConfig | undefined {
    const config = this.sources.get(id);
    if (!config) return undefined;
    config.enabled = enabled;
    return publicSourceConfig(config);
  }

  remove(id: string): boolean {
    this.lastFetchAt.delete(id);
    return this.sources.delete(id);
  }

  clear(): void {
    this.sources.clear();
    this.lastFetchAt.clear();
  }

  /** True when enough time has elapsed since the last fetch for this source. */
  isDue(id: string, nowMs: number = this.now()): boolean {
    const last = this.lastFetchAt.get(id);
    const limit = this.sources.get(id)?.rateLimitMs ?? 0;
    return last === undefined || nowMs - last >= limit;
  }

  /** Atomically consume the rate-limit slot for a source. */
  tryAcquire(id: string, nowMs: number = this.now()): boolean {
    if (!this.isDue(id, nowMs)) return false;
    this.lastFetchAt.set(id, nowMs);
    return true;
  }
}

export function isValidBasis(value: unknown): boolean {
  return typeof value === 'string' && BASES.has(value);
}
