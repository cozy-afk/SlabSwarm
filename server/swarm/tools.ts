/**
 * Phase 4 — INTELLIGENCE lane, Task 1: swarm v2 tool registry.
 *
 * Tools are the ONLY surface agents may use. Every tool call is allowlisted,
 * every tool result is a structured envelope carrying evidence IDs, and every
 * evidence ID must resolve inside a bounded evidence packet assembled by
 * deterministic code. Agents propose; they never write canonical facts.
 */

import { createHash } from 'node:crypto';

/** The complete, closed tool allowlist for the swarm. */
export const REGISTERED_TOOLS = [
  'query_graph',
  'get_market_observations',
  'get_comps',
  'get_event_history',
  'get_factor_scores',
  'search_sources',
  'run_deterministic_baseline',
  'run_simulation',
  'backtest_forecast',
  'propose_alias',
  'propose_factor',
  'propose_forecast',
] as const;

export type ToolName = (typeof REGISTERED_TOOLS)[number];

const ALLOWLIST: ReadonlySet<string> = new Set<string>(REGISTERED_TOOLS);

export function isRegisteredTool(name: string): name is ToolName {
  return ALLOWLIST.has(name);
}

/** A single bounded evidence fact handed to an agent. */
export interface EvidenceItem {
  id: string;
  source: string;
  observedAt: string;
  capturedAt: string;
  summary: string;
  basis?: string;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  kind?: string;
  amount?: number | null;
}

export interface EvidencePacket {
  items: EvidenceItem[];
  evidenceIds: string[];
  digest: string;
  truncated: boolean;
  totalAvailable: number;
}

export interface EvidencePacketInput {
  items: EvidenceItem[];
  maxItems?: number;
  maxCharsPerItem?: number;
}

/**
 * Build a bounded, ordered, content-addressed evidence packet. Ordering and
 * truncation are deterministic; the digest lets a run record prove exactly
 * which facts an agent saw.
 */
export function buildEvidencePacket(input: EvidencePacketInput): EvidencePacket {
  const maxItems = input.maxItems ?? 12;
  const maxChars = input.maxCharsPerItem ?? 2000;
  const ordered = [...input.items]
    .filter((i) => typeof i?.id === 'string' && i.id.length > 0)
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, maxItems)
    .map((i) => ({
      ...i,
      summary: String(i.summary ?? '').slice(0, maxChars),
      basis: i.basis ?? 'UNKNOWN',
      amount: i.amount ?? null,
    }));
  const canonical = JSON.stringify(ordered);
  return {
    items: ordered,
    evidenceIds: ordered.map((i) => i.id),
    digest: createHash('sha256').update(canonical).digest('hex'),
    truncated: input.items.length > ordered.length ||
      input.items.some((i) => String(i.summary ?? '').length > maxChars),
    totalAvailable: input.items.length,
  };
}

export interface ToolCall {
  tool: string;
  args?: Record<string, unknown>;
}

/** Optional deterministic evaluators injected by the controller/orchestrator. */
export interface ToolContext {
  packet: EvidencePacket;
  simulationRunner?: (args: Record<string, unknown>, packet: EvidencePacket) => unknown;
  backtestRunner?: (args: Record<string, unknown>, packet: EvidencePacket) => unknown;
}

export interface ToolResult {
  tool: string;
  ok: boolean;
  evidenceIds: string[];
  data: unknown;
  error?: string;
}

function fail(tool: string, error: string): ToolResult {
  return { tool, ok: false, evidenceIds: [], data: {}, error };
}

/** Extract a monetary amount from a raw fact; null means UNKNOWN, never zero. */
function amountOf(item: EvidenceItem): number | null {
  if (typeof item.amount === 'number' && Number.isFinite(item.amount)) return item.amount;
  const match = item.summary.match(/\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function factorScore(id: string, factor: string): number {
  const digest = createHash('sha256').update(`${id}|${factor}`).digest();
  return Number((digest.readUInt32BE(0) / 0xffffffff).toFixed(6));
}

/**
 * Invoke one allowlisted tool. Evidence requirements are enforced here, not
 * delegated to the model: an unbacked or out-of-packet citation is a hard
 * error, and the resulting envelope echoes exactly the cited IDs.
 */
export function invokeTool(call: ToolCall, ctx: ToolContext): ToolResult {
  const tool = call.tool;
  if (!isRegisteredTool(tool)) return fail(tool, 'TOOL_NOT_REGISTERED');

  const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
    ? call.args
    : {};
  const rawIds = args.evidenceIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0 || rawIds.some((id) => typeof id !== 'string')) {
    return fail(tool, 'EVIDENCE_IDS_REQUIRED');
  }
  const requested = [...new Set(rawIds as string[])].sort();
  if (requested.some((id) => !ctx.packet.evidenceIds.includes(id))) {
    return fail(tool, 'EVIDENCE_ID_NOT_IN_PACKET');
  }

  const cited = ctx.packet.items.filter((i) => requested.includes(i.id));
  const ok = (data: unknown): ToolResult => ({ tool, ok: true, evidenceIds: requested, data });
  const query = typeof args.query === 'string' ? args.query.toLowerCase() : '';

  switch (tool) {
    case 'query_graph':
      return ok({
        nodes: cited.map((i) => ({ id: i.id, kind: i.kind ?? 'OBSERVATION', source: i.source })),
        edges: [],
        basis: 'UNKNOWN',
      });
    case 'get_market_observations':
      return ok({
        items: cited.map((i) => ({
          id: i.id,
          basis: i.basis ?? 'UNKNOWN',
          amount: amountOf(i),
          currency: i.amount === undefined ? 'UNKNOWN' : 'USD',
          observedAt: i.observedAt,
          capturedAt: i.capturedAt,
          source: i.source,
        })),
      });
    case 'get_comps': {
      const sold = cited.filter((i) => i.basis === 'SOLD' && amountOf(i) !== null);
      return ok({
        items: sold.map((i) => ({ id: i.id, basis: 'SOLD', amount: amountOf(i) })),
        ...(sold.length === 0 ? { reason: 'NO_SOLD_EVIDENCE' } : {}),
      });
    }
    case 'get_event_history':
      return ok({
        items: cited
          .filter((i) => i.kind === 'event' || /announc|reprint|event/i.test(i.summary))
          .map((i) => ({ id: i.id, observedAt: i.observedAt, summary: i.summary })),
      });
    case 'get_factor_scores': {
      const factor = typeof args.factor === 'string' ? args.factor : 'momentum';
      return ok({
        factor,
        scores: cited.map((i) => ({ evidenceId: i.id, score: factorScore(i.id, factor) })),
      });
    }
    case 'search_sources':
      return ok({
        items: cited
          .filter((i) => query === '' || i.summary.toLowerCase().includes(query) || i.source.toLowerCase().includes(query))
          .map((i) => ({ id: i.id, source: i.source, summary: i.summary })),
      });
    case 'run_deterministic_baseline': {
      const amounts = cited
        .filter((i) => i.basis === 'SOLD')
        .map(amountOf)
        .filter((n): n is number => n !== null)
        .sort((a, b) => a - b);
      const mid = Math.floor(amounts.length / 2);
      const baseline = amounts.length === 0
        ? null
        : amounts.length % 2 === 1
          ? amounts[mid]
          : Number(((amounts[mid - 1] + amounts[mid]) / 2).toFixed(6));
      return ok({ baseline, basis: 'SOLD', count: amounts.length });
    }
    case 'run_simulation':
      return ok(ctx.simulationRunner
        ? ctx.simulationRunner(args, ctx.packet)
        : { deferred: true, reason: 'NO_SIMULATION_RUNNER_CONFIGURED' });
    case 'backtest_forecast':
      return ok(ctx.backtestRunner
        ? ctx.backtestRunner(args, ctx.packet)
        : { deferred: true, reason: 'NO_BACKTEST_RUNNER_CONFIGURED' });
    case 'propose_alias':
      return ok({
        type: 'ALIAS',
        status: 'PROPOSED',
        evidenceIds: requested,
        canonical: typeof args.canonical === 'string' ? args.canonical : null,
      });
    case 'propose_factor':
      return ok({
        type: 'FACTOR',
        status: 'PROPOSED',
        evidenceIds: requested,
        factor: typeof args.factor === 'string' ? args.factor : 'momentum',
      });
    case 'propose_forecast':
      return ok({
        type: 'FORECAST',
        status: 'PROPOSED',
        evidenceIds: requested,
        targetId: typeof args.targetId === 'string' ? args.targetId : 'unresolved',
        horizonDays: [7, 30, 90].includes(args.horizonDays as number) ? args.horizonDays : 30,
      });
  }
}
