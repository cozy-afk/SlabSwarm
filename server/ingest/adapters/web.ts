// First-party web source adapter. Fetches only operator-allowlisted sources,
// respects robots.txt and a per-source rate limit, extracts deterministically
// (no model inference) and emits raw evidence through the ingest ledger only.
// Canonical cards and observations are never written here.

import type {
  WebHarvestCandidate,
  WebHarvestResult,
  WebSourceConfig,
} from '../../contracts/webHarvest.ts';
import { computeChecksum } from '../evidence.ts';
import { isValidBasis, type WebSourceRegistry } from '../sources.ts';
import type {
  AdapterFetchContext,
  AdapterFetchResult,
  IngestAdapter,
  IngestRepositories,
  RawItem,
} from '../types.ts';

export const WEB_ADAPTER_ID = 'web';
export const USER_AGENT = 'SlabswarmWebHarvester/1.0 (+first-party-public-web)';
export const UNKNOWN = 'UNKNOWN';

export interface WebFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type WebFetchImpl = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<WebFetchResponse>;

export interface WebAdapterOptions {
  registry: WebSourceRegistry;
  fetchImpl: WebFetchImpl;
  /** Explicit subset of sources; defaults to all enabled sources. */
  sources?: WebSourceConfig[];
  now?: () => number;
  userAgent?: string;
}

interface SourceFetchResult {
  sourceId: string;
  fetched: number;
  parsed: number;
  skippedRobots: boolean;
  errors: string[];
}

export interface WebAdapterMeta {
  webResults: SourceFetchResult[];
  parseErrors: Array<{ nativeId: string | null; message: string }>;
}

export interface HarvestWebOptions {
  repos: IngestRepositories;
  registry: WebSourceRegistry;
  fetchImpl: WebFetchImpl;
  sources?: WebSourceConfig[];
  capturedAt?: string;
  now?: () => number;
  userAgent?: string;
}

interface ExtractedRecord {
  nativeId: string;
  name: string;
  set: string;
  game: string;
  number: string;
  basis: WebHarvestCandidate['basis'];
  amount: number | null;
  currency: string;
  observedAt: string;
  confidence: WebHarvestCandidate['confidence'];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
}

export function parseRobots(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let sawRule = false;
  for (const rawLine of String(txt).split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === 'user-agent') {
      if (!current || sawRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRule = false;
      }
      current.agents.push(value.toLowerCase());
    } else if (key === 'allow' || key === 'disallow') {
      if (!current) {
        current = { agents: ['*'], rules: [] };
        groups.push(current);
      }
      sawRule = true;
      // An empty Disallow means "allow everything".
      if (key === 'disallow' && value === '') continue;
      current.rules.push({ allow: key === 'allow', path: value || '/' });
    }
  }
  return groups;
}

export function robotsAllows(txt: string, pathname: string, userAgent: string): boolean {
  const agent = userAgent.toLowerCase();
  const groups = parseRobots(txt).filter((group) =>
    group.agents.some((candidate) =>
      candidate === '*' ? false : agent.includes(candidate) || candidate.includes(agent.split('/')[0]),
    ),
  );
  const applicable = groups.length > 0 ? groups : parseRobots(txt).filter((group) => group.agents.includes('*'));
  let matched: { allow: boolean; path: string } | null = null;
  for (const group of applicable) {
    for (const rule of group.rules) {
      if (!pathname.startsWith(rule.path)) continue;
      if (!matched || rule.path.length > matched.path.length ||
        (rule.path.length === matched.path.length && rule.allow)) {
        matched = rule;
      }
    }
  }
  return matched === null || matched.allow;
}

// ---------------------------------------------------------------------------
// Minimal deterministic HTML reader (no third-party parser, no network)
// ---------------------------------------------------------------------------

interface HtmlNode {
  tag: string;
  attrs: Record<string, string>;
  text: string;
  children: HtmlNode[];
  parent: HtmlNode | null;
}

export class HtmlParseError extends Error {
  constructor() {
    super('HTML_PARSE_FAILED');
    this.name = 'HtmlParseError';
  }
}

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([:\w-]+)\s*=\s*"([^"]*)"|([:\w-]+)\s*=\s*'([^']*)'|([:\w-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    const key = (match[1] ?? match[3] ?? match[5]).toLowerCase();
    attrs[key] = match[2] ?? match[4] ?? '';
  }
  return attrs;
}

function parseHtml(html: string): HtmlNode {
  if (typeof html !== 'string' || html.trim() === '') throw new HtmlParseError();
  const root: HtmlNode = { tag: '#root', attrs: {}, text: '', children: [], parent: null };
  const stack: HtmlNode[] = [root];
  const re = /<!--[\s\S]*?-->|<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const token = match[0];
    if (token.startsWith('<!--') || token.startsWith('<script') || token.startsWith('<style')) continue;
    if (match[3] !== undefined) {
      stack[stack.length - 1].text += match[3];
      continue;
    }
    const tag = match[1].toLowerCase();
    if (token.startsWith('</')) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        if (stack[index].tag === tag) {
          stack.length = index;
          break;
        }
      }
      continue;
    }
    const parent = stack[stack.length - 1];
    const node: HtmlNode = {
      tag,
      attrs: parseAttributes(match[2] ?? ''),
      text: '',
      children: [],
      parent,
    };
    parent.children.push(node);
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token)) stack.push(node);
  }
  return root;
}

interface SimpleSelector {
  tag?: string;
  id?: string;
  classes: string[];
  attrs: Array<{ key: string; value?: string }>;
}

function parseSimpleSelector(input: string): SimpleSelector {
  const selector: SimpleSelector = { classes: [], attrs: [] };
  let rest = input.trim();
  const tagMatch = rest.match(/^([a-zA-Z][\w-]*)/);
  if (tagMatch) {
    selector.tag = tagMatch[1].toLowerCase();
    rest = rest.slice(tagMatch[1].length);
  }
  const tokenRe = /([.#])([\w-]+)|\[([:\w-]+)(?:=["']?([^\]"']*)["']?)?\]/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(rest)) !== null) {
    if (match[1] === '.') selector.classes.push(match[2]);
    else if (match[1] === '#') selector.id = match[2];
    else selector.attrs.push({ key: match[3].toLowerCase(), value: match[4] });
  }
  return selector;
}

function matchesSimple(node: HtmlNode, selector: SimpleSelector): boolean {
  if (selector.tag && node.tag !== selector.tag) return false;
  if (selector.id && node.attrs.id !== selector.id) return false;
  const classes = (node.attrs.class ?? '').split(/\s+/).filter(Boolean);
  if (!selector.classes.every((name) => classes.includes(name))) return false;
  for (const attr of selector.attrs) {
    if (!(attr.key in node.attrs)) return false;
    if (attr.value !== undefined && node.attrs[attr.key] !== attr.value) return false;
  }
  return true;
}

function matchesSelector(node: HtmlNode, selector: string): boolean {
  const parts = selector.trim().split(/\s+/).filter(Boolean).map(parseSimpleSelector);
  if (parts.length === 0) return false;
  if (!matchesSimple(node, parts[parts.length - 1])) return false;
  let ancestor = node.parent;
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    let found = false;
    while (ancestor) {
      if (matchesSimple(ancestor, parts[index])) {
        found = true;
        ancestor = ancestor.parent;
        break;
      }
      ancestor = ancestor.parent;
    }
    if (!found) return false;
  }
  return true;
}

function descendants(node: HtmlNode): HtmlNode[] {
  const out: HtmlNode[] = [];
  const visit = (parent: HtmlNode) => {
    for (const child of parent.children) {
      out.push(child);
      visit(child);
    }
  };
  visit(node);
  return out;
}

function textContent(node: HtmlNode): string {
  return `${node.text}${node.children.map(textContent).join('')}`.replace(/\s+/g, ' ').trim();
}

function findFirst(scope: HtmlNode, selector: string): string {
  const nodes = descendants(scope);
  if (matchesSelector(scope, selector)) nodes.unshift(scope);
  for (const node of nodes) {
    if (!matchesSelector(node, selector)) continue;
    const value = textContent(node);
    if (value !== '') return value;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Deterministic field extraction
// ---------------------------------------------------------------------------

const CONFIDENCE_VALUES = new Set(['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN']);

function pick(raw: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function knownString(
  raw: Record<string, unknown>,
  keys: string[],
  warnings: string[],
  label: string,
): string {
  const value = pick(raw, keys);
  if (typeof value === 'string' && value.trim() !== '') return value;
  warnings.push(`${label}_UNKNOWN`);
  return UNKNOWN;
}

function knownObservedAt(raw: Record<string, unknown>, warnings: string[]): string {
  const value = pick(raw, ['observedAt', 'observed_at', 'date', 'timestamp', 'last_updated']);
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))) {
    return value;
  }
  warnings.push('OBSERVED_AT_UNKNOWN');
  return UNKNOWN;
}

function knownAmount(raw: Record<string, unknown>, warnings: string[]): number | null {
  const value = pick(raw, ['amount', 'price', 'priceUsd', 'listedPrice', 'marketPrice', 'value']);
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(/[,\s]/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  warnings.push('AMOUNT_UNKNOWN');
  return null;
}

function knownCurrency(raw: Record<string, unknown>, warnings: string[]): string {
  const value = pick(raw, ['currency', 'currencyCode']);
  if (typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) && !/^XXX$/i.test(value)) return value;
  warnings.push('CURRENCY_UNKNOWN');
  return UNKNOWN;
}

function knownBasis(raw: Record<string, unknown>, warnings: string[]): WebHarvestCandidate['basis'] {
  const value = pick(raw, ['basis', 'marketBasis', 'priceBasis']);
  if (isValidBasis(value)) return value as WebHarvestCandidate['basis'];
  warnings.push(value === undefined ? 'BASIS_UNKNOWN' : 'BASIS_INVALID');
  return UNKNOWN;
}

function toExtractedRecord(
  raw: Record<string, unknown>,
  source: WebSourceConfig,
): ExtractedRecord {
  const warnings: string[] = [];
  const fields = {
    name: knownString(raw, ['name', 'title', 'productName', 'cardName'], warnings, 'NAME'),
    set: knownString(raw, ['set', 'setName', 'set_name', 'expansion'], warnings, 'SET'),
    game: knownString(raw, ['game', 'gameName', 'game_name'], warnings, 'GAME'),
    number: knownString(raw, ['number', 'cardNumber', 'collectorNumber'], warnings, 'NUMBER'),
    basis: knownBasis(raw, warnings),
    amount: knownAmount(raw, warnings),
    currency: knownCurrency(raw, warnings),
    observedAt: knownObservedAt(raw, warnings),
  };
  const confidenceValue = pick(raw, ['confidence']);
  const confidence = typeof confidenceValue === 'string' && CONFIDENCE_VALUES.has(confidenceValue)
    ? confidenceValue as WebHarvestCandidate['confidence']
    : UNKNOWN as WebHarvestCandidate['confidence'];
  const nativeId = `web:${source.id}:${computeChecksum({ ...fields, sourceUrl: source.url })}`;
  return { ...fields, nativeId, confidence, warnings };
}

function resolvePath(value: unknown, parts: string[]): unknown {
  if (parts.length === 0) return value;
  if (Array.isArray(value)) {
    const mapped = value.map((item) => resolvePath(item, parts)).filter((item) => item !== undefined);
    return mapped;
  }
  if (value !== null && typeof value === 'object') {
    return resolvePath((value as Record<string, unknown>)[parts[0]], parts.slice(1));
  }
  return undefined;
}

function extractJsonRecords(body: string, source: WebSourceConfig): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error('JSON_PARSE_FAILED');
  }
  const parts = (source.recordPath ?? '').split(/[.\/]+/).filter((part) => part !== '');
  const resolved = resolvePath(parsed, parts);
  const records = Array.isArray(resolved)
    ? resolved
    : resolved !== null && typeof resolved === 'object' ? [resolved] : [];
  return records.filter((record): record is Record<string, unknown> =>
    record !== null && typeof record === 'object' && !Array.isArray(record),
  );
}

function extractHtmlRecords(body: string, source: WebSourceConfig): Record<string, unknown>[] {
  const root = parseHtml(body);
  const selectors = source.selectors ?? {};
  const recordSelector = selectors.record ?? selectors.records;
  const scopes = recordSelector
    ? descendants(root).filter((node) => matchesSelector(node, recordSelector))
    : [root];
  return scopes.map((scope) => {
    const record: Record<string, unknown> = {};
    for (const [field, selector] of Object.entries(selectors)) {
      if (field === 'record' || field === 'records') continue;
      record[field] = findFirst(scope, selector) || UNKNOWN;
    }
    return record;
  });
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function createWebSourceAdapter(options: WebAdapterOptions): IngestAdapter {
  const registry = options.registry;
  const fetchImpl = options.fetchImpl;
  const now = options.now ?? (() => Date.now());
  const userAgent = options.userAgent ?? USER_AGENT;
  return {
    id: WEB_ADAPTER_ID,
    sourceId: WEB_ADAPTER_ID,
    async fetch(ctx: AdapterFetchContext): Promise<AdapterFetchResult> {
      const sources = (options.sources ?? registry.enabled()).filter((source) => source.enabled);
      const items: RawItem[] = [];
      const results: SourceFetchResult[] = [];
      const parseErrors: Array<{ nativeId: string | null; message: string }> = [];

      for (const source of sources) {
        const result: SourceFetchResult = {
          sourceId: source.id,
          fetched: 0,
          parsed: 0,
          skippedRobots: false,
          errors: [],
        };
        if (!registry.tryAcquire(source.id, now())) {
          result.errors.push('RATE_LIMITED');
          results.push(result);
          continue;
        }
        if (source.respectRobots) {
          const robotsUrl = new URL('/robots.txt', source.url).toString();
          try {
            const response = await fetchImpl(robotsUrl, {
              headers: { 'user-agent': userAgent, accept: 'text/plain' },
            });
            if (response.status === 404) {
              // Absence of robots.txt means no restrictions.
            } else if (!response.ok) {
              result.errors.push(`ROBOTS_UNAVAILABLE_HTTP_${response.status}`);
              result.skippedRobots = true;
              results.push(result);
              continue;
            } else {
              const txt = await response.text();
              if (!robotsAllows(txt, new URL(source.url).pathname, userAgent)) {
                result.skippedRobots = true;
                results.push(result);
                continue;
              }
            }
          } catch {
            result.errors.push('ROBOTS_FETCH_FAILED');
            result.skippedRobots = true;
            results.push(result);
            continue;
          }
        }

        try {
          const response = await fetchImpl(source.url, {
            headers: {
              'user-agent': userAgent,
              accept: source.kind === 'json' ? 'application/json' : 'text/html',
            },
          });
          if (!response.ok) {
            result.errors.push(`HTTP_${response.status}`);
            parseErrors.push({ nativeId: source.id, message: `HTTP_${response.status}` });
            results.push(result);
            continue;
          }
          result.fetched = 1;
          let body: string;
          try {
            body = await response.text();
          } catch {
            const code = source.kind === 'html' ? 'HTML_PARSE_FAILED' : 'JSON_PARSE_FAILED';
            result.errors.push(code);
            parseErrors.push({ nativeId: source.id, message: code });
            results.push(result);
            continue;
          }
          let records: Record<string, unknown>[];
          try {
            records = source.kind === 'json'
              ? extractJsonRecords(body, source)
              : extractHtmlRecords(body, source);
          } catch (error) {
            const code = error instanceof HtmlParseError ? 'HTML_PARSE_FAILED' :
              (error instanceof Error && error.message === 'JSON_PARSE_FAILED'
                ? 'JSON_PARSE_FAILED' : 'EXTRACTION_FAILED');
            result.errors.push(code);
            parseErrors.push({ nativeId: source.id, message: code });
            results.push(result);
            continue;
          }
          if (records.length === 0) {
            result.errors.push('NO_RECORDS_FOUND');
            results.push(result);
            continue;
          }
          for (const record of records) {
            const extracted = toExtractedRecord(record, source);
            const payload: Record<string, unknown> = {
              source: WEB_ADAPTER_ID,
              webSourceId: source.id,
              webSourceName: source.name,
              license: source.license,
              provenanceNote: source.provenanceNote ?? null,
              targetIdentityRef: extracted.nativeId,
              name: extracted.name,
              set: extracted.set,
              game: extracted.game,
              number: extracted.number,
              basis: extracted.basis,
              price: extracted.amount,
              currency: extracted.currency,
              observedAt: extracted.observedAt,
              confidence: extracted.confidence,
              warnings: extracted.warnings,
              rawBody: body,
            };
            items.push({
              nativeId: extracted.nativeId,
              observedAt: extracted.observedAt,
              payload,
              sourceUri: source.url,
              checksum: computeChecksum(payload),
              mimeType: source.kind === 'json' ? 'application/json' : 'text/html',
            });
          }
          result.parsed = records.length;
          results.push(result);
        } catch {
          result.errors.push('FETCH_FAILED');
          parseErrors.push({ nativeId: source.id, message: 'FETCH_FAILED' });
          results.push(result);
        }
      }

      return { items, meta: { webResults: results, parseErrors } as unknown as Record<string, unknown> };
    },
  };
}

// ---------------------------------------------------------------------------
// Harvest orchestration: ledger evidence only, no canonical writes
// ---------------------------------------------------------------------------

export async function harvestWebSources(options: HarvestWebOptions): Promise<WebHarvestResult[]> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const adapter = createWebSourceAdapter(options);
  const fetched = await adapter.fetch({
    mode: 'backfill',
    since: null,
    cursor: null,
    capturedAt,
    options: {},
  });
  const meta = fetched.meta as unknown as WebAdapterMeta | undefined;
  const perSource = meta?.webResults ?? [];
  const results: WebHarvestResult[] = [];
  const evidenceRepo = options.repos.evidence;

  for (const sourceResult of perSource) {
    const source = (options.sources ?? options.registry.enabled()).find(
      (candidate) => candidate.id === sourceResult.sourceId,
    ) ?? options.registry.getInternal(sourceResult.sourceId);
    const candidates: WebHarvestCandidate[] = [];
    if (!source) {
      results.push({ ...sourceResult, candidates });
      continue;
    }
    const sourceItems = fetched.items.filter(
      (item) => (item.payload as Record<string, unknown>).webSourceId === source.id,
    );
    for (const item of sourceItems) {
      const payload = item.payload as Record<string, unknown>;
      const checksum = item.checksum ?? computeChecksum(payload);
      try {
        const record = (await evidenceRepo.createIdempotent({
          sourceId: `web:${source.id}`,
          sourceRecordId: item.nativeId,
          sourceUri: item.sourceUri ?? null,
          capturedAt,
          observedAt: item.observedAt,
          checksum,
          mimeType: item.mimeType ?? 'application/json',
          license: source.license,
          rawRef: `ingest://web/${encodeURIComponent(source.id)}/${encodeURIComponent(item.nativeId)}/${checksum}`,
          parsedPayload: payload,
          trustTier: 'UNKNOWN',
          parseStatus: 'PARSED',
          lineage: [WEB_ADAPTER_ID, `web:${source.id}`, source.id],
        })).record;
        const amount = payload.price;
        candidates.push({
          id: `whc:${item.nativeId}`,
          sourceId: source.id,
          evidenceId: record.id,
          name: String(payload.name ?? UNKNOWN),
          set: String(payload.set ?? UNKNOWN) as WebHarvestCandidate['set'],
          game: String(payload.game ?? UNKNOWN) as WebHarvestCandidate['game'],
          number: String(payload.number ?? UNKNOWN) as WebHarvestCandidate['number'],
          basis: payload.basis as WebHarvestCandidate['basis'],
          amount: typeof amount === 'number' ? amount : UNKNOWN as WebHarvestCandidate['amount'],
          currency: String(payload.currency ?? UNKNOWN) as WebHarvestCandidate['currency'],
          observedAt: String(payload.observedAt ?? UNKNOWN),
          capturedAt,
          license: source.license,
          confidence: payload.confidence as WebHarvestCandidate['confidence'],
          warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
        });
      } catch {
        sourceResult.errors.push('EVIDENCE_WRITE_FAILED');
      }
    }
    results.push({ ...sourceResult, candidates });
  }
  return results;
}
