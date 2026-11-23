/**
 * Web-source swarm tools.
 *
 * These are discovery/proposal tools only. They use an injected fetch and the
 * frozen WebSourceConfig/WebHarvestResult contract, return bounded evidence
 * packets, and never touch a canonical table. Operator approval is the only
 * path from a web candidate into canonical storage.
 */

import { createHash } from 'node:crypto';

import type {
  EvidenceItem,
  ToolCall,
  ToolResult,
  EvidencePacket,
} from './tools.ts';
import {
  buildEvidencePacket,
  invokeTool,
  isRegisteredTool,
} from './tools.ts';
import type {
  WebHarvestCandidate,
  WebHarvestResult,
  WebSourceConfig,
} from '../contracts/webHarvest.ts';

/** Exact names added to the closed swarm tool allowlist. */
export const WEB_TOOL_NAMES = ['search_web_sources', 'harvest_web_source'] as const;
export type WebToolName = (typeof WEB_TOOL_NAMES)[number];

export function isWebTool(name: string): name is WebToolName {
  return (WEB_TOOL_NAMES as readonly string[]).includes(name);
}

/** Minimal injected fetch surface; no network is used unless the caller injects one. */
export interface WebFetchResponse {
  ok: boolean;
  status?: number;
  text: () => Promise<string>;
  json?: () => Promise<unknown>;
}

export type WebFetch = (url: string) => Promise<WebFetchResponse> | WebFetchResponse;

const MAX_STRING = 200;

function redact(value: string): string {
  return String(value)
    .replace(/\b(token|key|secret|password|apikey|authorization)\s*[:=]\s*\S+/gi, '$1=REDACTED')
    .slice(0, MAX_STRING);
}

function safeUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return 'UNKNOWN';
  }
}

/** Non-secret projection of an operator allowlist entry. */
export interface SafeWebSource {
  id: string;
  name: string;
  url: string;
  kind: 'json' | 'html';
  license: string;
  respectRobots: boolean;
  rateLimitMs: number;
  provenanceNote?: string;
}

function safeSource(source: WebSourceConfig): SafeWebSource {
  const out: SafeWebSource = {
    id: redact(source.id),
    name: redact(source.name),
    url: safeUrl(String(source.url ?? '')),
    kind: source.kind === 'html' ? 'html' : 'json',
    license: redact(source.license ?? 'UNKNOWN'),
    respectRobots: Boolean(source.respectRobots),
    rateLimitMs: Number.isFinite(source.rateLimitMs) ? source.rateLimitMs : 0,
  };
  if (typeof source.provenanceNote === 'string' && source.provenanceNote.length > 0) {
    out.provenanceNote = redact(source.provenanceNote);
  }
  return out;
}

export interface WebSearchArgs {
  query?: string;
  maxItems?: number;
}

export interface WebSearchResult {
  type: 'SOURCE_DISCOVERY';
  items: SafeWebSource[];
  totalAvailable: number;
  truncated: boolean;
}

/** Tool 1: list only enabled, operator-configured sources; no secrets, no fetch. */
export function searchWebSources(
  args: WebSearchArgs | Record<string, unknown>,
): WebSearchResult {
  const input = (args && typeof args === 'object') ? args as WebSearchArgs : {};
  const sources = (input as WebSearchArgs & { sources?: readonly WebSourceConfig[] }).sources ?? [];
  const query = typeof input.query === 'string' ? input.query.toLowerCase() : '';
  const maxItems = Number.isFinite(input.maxItems) ? Math.max(0, input.maxItems as number) : 20;
  const enabled = sources
    .filter((s) => Boolean(s) && s.enabled === true)
    .filter((s) => query === '' ||
      s.id.toLowerCase().includes(query) ||
      s.name.toLowerCase().includes(query));
  const items = enabled.slice(0, maxItems).map(safeSource);
  return {
    type: 'SOURCE_DISCOVERY',
    items,
    totalAvailable: enabled.length,
    truncated: enabled.length > items.length,
  };
}

export interface WebToolDeps {
  sources?: readonly WebSourceConfig[];
  fetchImpl?: WebFetch;
  now?: () => string;
  maxItems?: number;
  maxCharsPerItem?: number;
  /** Optional robots/license-aware adapter supplied by the ingest lane. */
  harvest?: WebHarvestFn;
}

export interface WebToolContext extends WebToolDeps {
  packet?: EvidencePacket;
  simulationRunner?: (args: Record<string, unknown>, packet: EvidencePacket) => unknown;
  backtestRunner?: (args: Record<string, unknown>, packet: EvidencePacket) => unknown;
}

export interface WebHarvestFn {
  (source: WebSourceConfig, fetchImpl: WebFetch, now: string): Promise<unknown>;
}

export interface WebToolHandlers {
  search_web_sources: (args: Record<string, unknown>) => WebSearchResult;
  harvest_web_source: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function failure(tool: string, error: string): ToolResult {
  return { tool, ok: false, evidenceIds: [], data: {}, error };
}

/** Complete facade over the closed tool registry, including the two web tools. */
export async function invokeWebTool(
  call: ToolCall,
  ctx: WebToolContext,
): Promise<ToolResult> {
  const args = (call.args && typeof call.args === 'object' && !Array.isArray(call.args))
    ? call.args
    : {};
  if (!isWebTool(call.tool)) {
    return invokeTool(call, {
      packet: ctx.packet ?? buildEvidencePacket({ items: [] }),
      ...(ctx.simulationRunner ? { simulationRunner: ctx.simulationRunner } : {}),
      ...(ctx.backtestRunner ? { backtestRunner: ctx.backtestRunner } : {}),
    });
  }
  if (!isRegisteredTool(call.tool)) return failure(call.tool, 'TOOL_NOT_REGISTERED');

  if (call.tool === 'search_web_sources') {
    const rawIds = args.evidenceIds;
    if (rawIds !== undefined) {
      const ids = Array.isArray(rawIds) ? rawIds : [];
      if (ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
        return failure(call.tool, 'EVIDENCE_IDS_REQUIRED');
      }
      const packet = ctx.packet ?? buildEvidencePacket({ items: [] });
      if (ids.some((id) => !packet.evidenceIds.includes(id as string))) {
        return failure(call.tool, 'EVIDENCE_ID_NOT_IN_PACKET');
      }
    }
    return {
      tool: call.tool,
      ok: true,
      evidenceIds: [],
      data: searchWebSources({ ...args, sources: ctx.sources ?? [] }),
    };
  }

  return harvestWebSource({
    ...ctx,
    sourceId: typeof args.sourceId === 'string' ? args.sourceId : '',
  });
}

/** Bound the two web tools as a factory for controller wiring. */
export function createWebTools(deps: WebToolDeps): WebToolHandlers {
  return {
    search_web_sources: (args) => searchWebSources({ ...args, sources: deps.sources ?? [] }),
    harvest_web_source: (args) => invokeWebTool(
      { tool: 'harvest_web_source', args },
      deps,
    ),
  };
}

/** Options for the bounded harvesting tool. */
export interface HarvestWebSourceOptions extends WebToolDeps {
  sourceId?: string;
  source?: WebSourceConfig;
}

const BASIS_VALUES = new Set([
  'SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', 'UNKNOWN',
]);
const CONFIDENCE_VALUES = new Set(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);

function clip(value: unknown, max = MAX_STRING): string {
  return String(value ?? '').slice(0, max);
}

function pick(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function flatten(values: unknown[]): unknown[] {
  return values.flatMap((v) => Array.isArray(v) ? flatten(v) : [v]);
}

function readPath(record: unknown, path?: string): unknown {
  if (!path) return record;
  const segments = path.split(/[./]+/).filter(Boolean);
  let values: unknown[] = [record];
  for (const segment of segments) {
    const next: unknown[] = [];
    for (const value of values) {
      if (Array.isArray(value)) {
        next.push(...value);
      } else if (value && typeof value === 'object') {
        next.push((value as Record<string, unknown>)[segment]);
      }
    }
    values = next;
  }
  const flat = flatten(values).filter((v) => v !== undefined && v !== null);
  return flat.length === 1 ? flat[0] : flat;
}

function selectorPattern(selector: string): RegExp | null {
  const value = selector.trim();
  if (value.startsWith('.')) {
    const name = value.slice(1).replace(/[^\w-]/g, '');
    return name ? new RegExp(`<[^>]+class=["'][^"']*\\b${name}\\b[^"']*["'][^>]*>`, 'i') : null;
  }
  if (value.startsWith('#')) {
    const name = value.slice(1).replace(/[^\w-]/g, '');
    return name ? new RegExp(`<[^>]+id=["']${name}["'][^>]*>`, 'i') : null;
  }
  const tag = value.replace(/[^\w-]/g, '');
  return tag ? new RegExp(`<${tag}\\b[^>]*>`, 'i') : null;
}

function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function blockAfter(html: string, openMatch: RegExpExecArray): string {
  const tag = (openMatch[0].match(/^<([a-zA-Z][\w-]*)/) ?? [])[1] ?? 'div';
  const close = new RegExp(`</${tag}\\s*>`, 'i');
  close.lastIndex = openMatch.index + openMatch[0].length;
  const found = close.exec(html);
  const end = found ? found.index : Math.min(html.length, close.lastIndex + 2000);
  return html.slice(openMatch.index + openMatch[0].length, end);
}

function htmlRecords(html: string, selectors: Record<string, string>): Record<string, unknown>[] {
  const recordSelector = selectors.record ?? selectors.item ?? '';
  const pattern = recordSelector ? selectorPattern(recordSelector) : null;
  if (!pattern) return [Object.fromEntries(
    Object.entries(selectors).map(([key, selector]) => [key, extractText(html, selector)]),
  )];
  const global = new RegExp(pattern.source, 'gi');
  const records: Record<string, unknown>[] = [];
  let match: RegExpExecArray | null;
  while ((match = global.exec(html)) !== null) {
    const block = blockAfter(html, match);
    records.push(Object.fromEntries(
      Object.entries(selectors)
        .filter(([key]) => key !== 'record' && key !== 'item')
        .map(([key, selector]) => [key, extractText(block, selector)]),
    ));
    global.lastIndex = match.index + match[0].length;
  }
  return records;
}

function extractText(html: string, selector: string): string {
  const pattern = selectorPattern(selector);
  if (!pattern) return 'UNKNOWN';
  const match = pattern.exec(html);
  return match ? textOf(blockAfter(html, match)) || 'UNKNOWN' : 'UNKNOWN';
}

function deterministicEvidenceId(sourceId: string, index: number, name: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([sourceId, index, name]))
    .digest('hex')
    .slice(0, 16);
  return `web-${sourceId}-${digest}`;
}

/** Map an extracted record onto the frozen contract. Missing fields stay UNKNOWN. */
function candidateFromRecord(
  value: unknown,
  source: WebSourceConfig,
  capturedAt: string,
  index: number,
): WebHarvestCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const name = clip(pick(record, 'name', 'title', 'cardName') ?? 'UNKNOWN');
  if (name === 'UNKNOWN' || name === '') return null;
  const rawBasis = clip(pick(record, 'basis') ?? 'UNKNOWN').toUpperCase();
  const rawConfidence = clip(pick(record, 'confidence') ?? 'LOW').toUpperCase();
  const amountRaw = pick(record, 'amount', 'price', 'value');
  const amount = typeof amountRaw === 'number' && Number.isFinite(amountRaw)
    ? amountRaw
    : 'UNKNOWN';
  const observedAt = clip(pick(record, 'observedAt', 'observed_at', 'timestamp') ?? capturedAt);
  const id = `candidate-${createHash('sha256').update(JSON.stringify([source.id, index, name])).digest('hex').slice(0, 16)}`;
  const warnings = Array.isArray(record.warnings)
    ? record.warnings.slice(0, 5).map((w) => clip(w, 120))
    : [];
  return {
    id,
    sourceId: source.id,
    evidenceId: deterministicEvidenceId(source.id, index, name),
    name,
    set: clip(pick(record, 'set') ?? 'UNKNOWN'),
    game: clip(pick(record, 'game') ?? 'UNKNOWN'),
    number: clip(pick(record, 'number', 'cardNumber') ?? 'UNKNOWN'),
    basis: BASIS_VALUES.has(rawBasis) ? rawBasis as WebHarvestCandidate['basis'] : 'UNKNOWN',
    amount,
    currency: amount === 'UNKNOWN' ? 'UNKNOWN' : clip(pick(record, 'currency') ?? 'UNKNOWN'),
    observedAt,
    capturedAt,
    license: clip(pick(record, 'license') ?? source.license ?? 'UNKNOWN'),
    confidence: CONFIDENCE_VALUES.has(rawConfidence)
      ? rawConfidence as WebHarvestCandidate['confidence']
      : 'UNKNOWN',
    warnings,
  };
}

/** Clamp an injected adapter's candidates so no unbounded payload reaches an agent. */
function boundCandidate(
  value: unknown,
  sourceId: string,
  capturedAt: string,
  index: number,
): WebHarvestCandidate | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Record<string, unknown>;
  const name = clip(pick(c, 'name') ?? 'UNKNOWN');
  const rawBasis = clip(pick(c, 'basis') ?? 'UNKNOWN').toUpperCase();
  const rawConfidence = clip(pick(c, 'confidence') ?? 'UNKNOWN').toUpperCase();
  const amountRaw = pick(c, 'amount');
  const amount = typeof amountRaw === 'number' && Number.isFinite(amountRaw)
    ? amountRaw
    : 'UNKNOWN';
  return {
    id: clip(pick(c, 'id') ?? `candidate-${index}`, 120),
    sourceId: clip(pick(c, 'sourceId') ?? sourceId, 80),
    evidenceId: clip(pick(c, 'evidenceId') ?? deterministicEvidenceId(sourceId, index, name), 160),
    name,
    set: clip(pick(c, 'set') ?? 'UNKNOWN'),
    game: clip(pick(c, 'game') ?? 'UNKNOWN'),
    number: clip(pick(c, 'number') ?? 'UNKNOWN'),
    basis: BASIS_VALUES.has(rawBasis) ? rawBasis as WebHarvestCandidate['basis'] : 'UNKNOWN',
    amount,
    currency: clip(pick(c, 'currency') ?? 'UNKNOWN'),
    observedAt: clip(pick(c, 'observedAt') ?? capturedAt),
    capturedAt: clip(pick(c, 'capturedAt') ?? capturedAt),
    license: clip(pick(c, 'license') ?? 'UNKNOWN'),
    confidence: CONFIDENCE_VALUES.has(rawConfidence)
      ? rawConfidence as WebHarvestCandidate['confidence']
      : 'UNKNOWN',
    warnings: Array.isArray(c.warnings) ? c.warnings.slice(0, 5).map((w) => clip(w, 120)) : [],
  };
}

function normalizeHarvest(
  value: unknown,
  sourceId: string,
  capturedAt: string,
): WebHarvestResult {
  const v = (value && typeof value === 'object' ? value : {}) as Partial<WebHarvestResult> & {
    candidates?: unknown[];
  };
  const candidates = (Array.isArray(v.candidates) ? v.candidates.slice(0, 200) : [])
    .map((c, i) => boundCandidate(c, sourceId, capturedAt, i))
    .filter((c): c is WebHarvestCandidate => c !== null);
  const count = (raw: unknown): number =>
    typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
  return {
    sourceId: typeof v.sourceId === 'string' ? clip(v.sourceId, 80) : sourceId,
    fetched: count(v.fetched),
    parsed: count(v.parsed) || candidates.length,
    candidates,
    skippedRobots: v.skippedRobots === true,
    errors: (Array.isArray(v.errors) ? v.errors : []).slice(0, 10).map((e) => clip(e, 120)),
  };
}

/** Minimal injected-fetch harvester; the ingest lane may inject its own adapter. */
async function fetchWebSource(
  source: WebSourceConfig,
  fetchImpl: WebFetch | undefined,
  now: string,
): Promise<WebHarvestResult> {
  const result: WebHarvestResult = {
    sourceId: source.id,
    fetched: 0,
    parsed: 0,
    candidates: [],
    skippedRobots: false,
    errors: [],
  };
  if (typeof fetchImpl !== 'function') {
    result.errors.push('FETCH_NOT_INJECTED');
    return result;
  }
  let response: WebFetchResponse;
  try {
    response = await fetchImpl(source.url);
    result.fetched = 1;
  } catch (error) {
    result.errors.push(`FETCH_FAILED: ${clip(error instanceof Error ? error.message : error, 80)}`);
    return result;
  }
  if (!response || response.ok === false) {
    result.errors.push(`HTTP_${response?.status ?? 'ERROR'}`);
    return result;
  }
  try {
    let payload: unknown;
    if (source.kind === 'html') {
      payload = await response.text();
    } else if (typeof response.json === 'function') {
      payload = await response.json();
    } else {
      payload = JSON.parse(await response.text());
    }
    const values = source.kind === 'html'
      ? htmlRecords(String(payload ?? ''), source.selectors ?? {})
      : readPath(payload, source.recordPath);
    const records = Array.isArray(values)
      ? values
      : values && typeof values === 'object' ? [values] : [];
    result.candidates = records
      .map((record, i) => candidateFromRecord(record, source, now, i))
      .filter((c): c is WebHarvestCandidate => c !== null)
      .slice(0, 200);
    result.parsed = result.candidates.length;
    if (result.candidates.length === 0) result.errors.push('NO_CANDIDATES');
  } catch (error) {
    result.errors.push(`PARSE_FAILED: ${clip(error instanceof Error ? error.message : error, 80)}`);
    result.candidates = [];
    result.parsed = 0;
  }
  return result;
}

function evidenceFromCandidate(c: WebHarvestCandidate): EvidenceItem {
  const confidence = c.confidence === 'HIGH' ? 'HIGH'
    : c.confidence === 'MEDIUM' ? 'MEDIUM' : 'LOW';
  const amount = typeof c.amount === 'number' ? c.amount : null;
  return {
    id: c.evidenceId,
    source: `web:${c.sourceId}`,
    observedAt: c.observedAt,
    capturedAt: c.capturedAt,
    basis: c.basis,
    confidence,
    kind: 'web-candidate',
    amount,
    summary: `WEB PROPOSAL (NOT A FACT): ${c.name} | set=${c.set} game=${c.game} number=${c.number}` +
      ` | basis=${c.basis} | amount=${amount === null ? 'UNKNOWN' : amount} ${c.currency}` +
      ` | observed_at=${c.observedAt} | license=${c.license} | citations=${c.evidenceId}`,
  };
}

/**
 * Tool 2: harvest one enabled allowlist source into a bounded evidence packet.
 * Every returned ID resolves inside that packet; nothing is persisted.
 */
export async function harvestWebSource(
  options: HarvestWebSourceOptions,
): Promise<ToolResult> {
  const tool = 'harvest_web_source';
  const sources = options.sources ?? [];
  const source = options.source ?? sources.find((s) => s && s.id === options.sourceId);
  if (!source) return failure(tool, 'SOURCE_NOT_IN_ALLOWLIST');
  if (source.enabled !== true) return failure(tool, 'SOURCE_DISABLED');

  const now = options.now ? options.now() : 'UNKNOWN';
  let raw: unknown;
  try {
    raw = options.harvest
      ? await options.harvest(source, options.fetchImpl as WebFetch, now)
      : await fetchWebSource(source, options.fetchImpl, now);
  } catch (error) {
    return failure(tool, `HARVEST_FAILED: ${clip(error instanceof Error ? error.message : error, 80)}`);
  }
  const harvest = normalizeHarvest(raw, source.id, now);
  const seen = new Set<string>();
  const candidates = harvest.candidates.filter((c) => {
    if (!c.evidenceId || seen.has(c.evidenceId)) return false;
    seen.add(c.evidenceId);
    return true;
  });
  const packet = buildEvidencePacket({
    items: candidates.map(evidenceFromCandidate),
    maxItems: options.maxItems,
    maxCharsPerItem: options.maxCharsPerItem,
  });
  const cited = candidates.filter((c) => packet.evidenceIds.includes(c.evidenceId));
  const proposals = packet.items.map((item) => ({
    id: `proposal-${item.id}`,
    type: 'WEB_CANDIDATE',
    status: 'HYPOTHESIS',
    targetId: item.id,
    evidenceIds: [item.id],
    source: item.source,
    observed_at: item.observedAt,
    basis: item.basis ?? 'UNKNOWN',
    confidence: item.confidence,
    citations: [item.id],
  }));
  return {
    tool,
    ok: true,
    evidenceIds: packet.evidenceIds,
    data: {
      type: 'WEB_EVIDENCE_PACKET',
      status: 'PROPOSAL',
      canonicalWrites: 0,
      sourceId: source.id,
      observedAt: now,
      harvest: { ...harvest, candidates: cited },
      packet,
      proposals,
    },
  };
}

export interface WebProposalInput {
  packet: EvidencePacket;
  evidenceIds?: unknown;
  source?: string;
  observedAt?: string;
  basis?: string;
  confidence?: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
  name?: string;
}

/** Explicit citation gate for web-derived proposals; no canonical write path. */
export function proposeWebCandidate(input: WebProposalInput): ToolResult {
  const tool = 'propose_web_candidate';
  const rawIds = input.evidenceIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some((id) => typeof id !== 'string')) {
    return failure(tool, 'EVIDENCE_IDS_REQUIRED');
  }
  const ids = [...new Set(rawIds as string[])].sort();
  if (ids.some((id) => !input.packet.evidenceIds.includes(id))) {
    return failure(tool, 'EVIDENCE_ID_NOT_IN_PACKET');
  }
  return {
    tool,
    ok: true,
    evidenceIds: ids,
    data: {
      type: 'WEB_CANDIDATE',
      status: 'PROPOSED',
      canonicalWrites: 0,
      source: input.source ?? 'UNKNOWN',
      observed_at: input.observedAt ?? 'UNKNOWN',
      basis: input.basis ?? 'UNKNOWN',
      confidence: input.confidence ?? 'UNKNOWN',
      name: input.name ?? 'UNKNOWN',
      citations: ids,
      evidenceIds: ids,
    },
  };
}
