import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Check,
  Code2,
  Copy,
  Play,
  Search,
  Terminal,
  X,
} from 'lucide-react';
import type {
  CypherBuilderResult,
  CypherSubgraphEdge,
  LLMProviderId,
} from '../types/graph.ts';
import { apiFetch } from '../utils/apiClient.ts';

export interface QueryBuilderProps {
  activeProviderId: LLMProviderId;
  activeProviderLabel: string;
  activeModelLabel: string;
  cypherResult: CypherBuilderResult | null;
  vizMode: 'ISOLATE' | 'HIGHLIGHT';
  selectedEdgeId: string | null;
  onResult: (result: CypherBuilderResult) => void;
  onClear: () => void;
  onChangeVizMode: (mode: 'ISOLATE' | 'HIGHLIGHT') => void;
  onSelectRelationship: (relationship: CypherSubgraphEdge) => void;
}

const CYPHER_NL_PRESETS = [
  'Show all TCG cards sold on Cardmarket and eBay with a cross-venue arbitrage spread above 10%.',
  'Find collectibles with a PSA 10 to 9 grade multiplier above 4x and the catalyst events that impacted them.',
  'Visualize sports collectibles impacted by championship or milestone events and their auction venues.',
  'Show all assets with quarantined shill-bid or mislabeled outliers and their marketplaces.',
];

const STARTER_CYPHER = `MATCH (a:Asset {segment: 'TCG'})-[r:SOLD_ON]->(m:Marketplace)
WHERE a.gradeMultiplier >= 3.0
RETURN a, r, m`;

export function QueryBuilder({
  activeProviderId,
  activeProviderLabel,
  activeModelLabel,
  cypherResult,
  vizMode,
  selectedEdgeId,
  onResult,
  onClear,
  onChangeVizMode,
  onSelectRelationship,
}: QueryBuilderProps) {
  const [nlQuery, setNlQuery] = useState(CYPHER_NL_PRESETS[0]);
  const [editableCypher, setEditableCypher] = useState(cypherResult?.cypherQuery ?? '');
  const [showManualEditor, setShowManualEditor] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [runningCypher, setRunningCypher] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (cypherResult) {
      setEditableCypher(cypherResult.cypherQuery);
    }
  }, [cypherResult]);

  async function handleTranslateNaturalLanguage(e?: FormEvent, overridePrompt?: string) {
    if (e) e.preventDefault();
    const prompt = (overridePrompt ?? nlQuery).trim();
    if (!prompt) return;

    setNlQuery(prompt);
    setError(null);
    setTranslating(true);
    try {
      const res = await apiFetch('/api/graphrag/cypher-builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          naturalLanguage: prompt,
          providerOverride: activeProviderId,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Natural-language to Cypher translation failed.');
      }
      const result = json as CypherBuilderResult;
      setEditableCypher(result.cypherQuery);
      onResult(result);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to translate natural-language question into Cypher.'
      );
    } finally {
      setTranslating(false);
    }
  }

  async function handleExecuteCypher(overrideCypher?: string) {
    const raw = (overrideCypher ?? editableCypher).trim();
    if (!raw) return;

    setError(null);
    setRunningCypher(true);
    try {
      const res = await apiFetch('/api/graphrag/cypher-builder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'execute_cypher',
          rawCypher: raw,
          naturalLanguage: nlQuery,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Cypher execution failed.');
      }
      onResult(json as CypherBuilderResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cypher execution failed.');
    } finally {
      setRunningCypher(false);
    }
  }

  function handleClearAll() {
    setError(null);
    setEditableCypher('');
    setShowManualEditor(false);
    onClear();
  }

  async function handleCopyCypher() {
    const text = editableCypher || cypherResult?.cypherQuery;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard may be restricted in sandboxed iframes
    }
  }

  const busy = translating || runningCypher;
  const editorVisible = Boolean(cypherResult) || showManualEditor;

  return (
    <div className="space-y-4 p-5">
      {/* Natural-Language Question Input */}
      <div className="space-y-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#94A3B8]">
          <span>
            Active LLM Translator:{' '}
            <span className="font-mono text-[#E2E8F0]">
              {activeProviderLabel} · {activeModelLabel}
            </span>
          </span>
          {!editorVisible && (
            <button
              type="button"
              onClick={() => {
                setEditableCypher(STARTER_CYPHER);
                setShowManualEditor(true);
              }}
              className="inline-flex items-center gap-1 font-mono text-[11px] text-emerald-400 hover:text-emerald-300"
            >
              <Terminal className="h-3 w-3" />
              <span>Write Raw Cypher</span>
            </button>
          )}
        </div>

        <form
          onSubmit={handleTranslateNaturalLanguage}
          className="flex flex-col gap-2 sm:flex-row"
        >
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B]" />
            <input
              type="text"
              value={nlQuery}
              onChange={(e) => setNlQuery(e.target.value)}
              aria-label="Natural language graph question"
              placeholder="Ask a natural-language question (e.g. Show TCG cards sold on Cardmarket and eBay with >10% arbitrage spread)..."
              className="w-full rounded-md border border-[#243040] bg-[#090C10] py-2 pl-9 pr-3 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Code2 className="h-3.5 w-3.5" />
            <span>
              {translating ? 'Converting to Cypher...' : 'Convert to Cypher & Visualize'}
            </span>
          </button>
        </form>

        {/* Curated Natural-Language Relationship Examples */}
        <div className="flex flex-wrap gap-2">
          {CYPHER_NL_PRESETS.map((preset, idx) => (
            <button
              key={idx}
              type="button"
              disabled={busy}
              onClick={() => handleTranslateNaturalLanguage(undefined, preset)}
              className="rounded-md border border-[#1F2937] bg-[#0D1117] px-2.5 py-1.5 text-left text-[11px] text-[#94A3B8] transition-colors hover:border-[#334155] hover:text-[#F1F5F9] disabled:opacity-50"
            >
              {preset}
            </button>
          ))}
        </div>
      </div>

      {/* Inline Error Banner */}
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-red-500/40 bg-red-950/35 px-3.5 py-2.5 text-xs text-red-200"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => handleTranslateNaturalLanguage()}
            className="font-medium text-red-200 underline decoration-red-400/60 underline-offset-2 hover:text-white whitespace-nowrap shrink-0"
          >
            Retry
          </button>
        </div>
      )}

      {/* Generated / Editable Cypher Editor + Matched Relationships */}
      {editorVisible && (
        <div className="grid grid-cols-1 gap-4 border-t border-[#1F2937] pt-4 lg:grid-cols-12">
          <div className="space-y-2.5 lg:col-span-7">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-semibold text-emerald-400">
                  {cypherResult ? 'Generated Cypher Query' : 'Cypher Query Editor'}
                </span>
                {cypherResult && (
                  <span className="font-mono text-[11px] text-[#64748B]">
                    {cypherResult.providerUsed} · {cypherResult.modelUsed} · {cypherResult.latencyMs}ms
                  </span>
                )}
              </div>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleCopyCypher}
                  className="inline-flex items-center gap-1 rounded border border-[#243040] bg-[#0D1117] px-2.5 py-1 text-[11px] font-medium text-[#CBD5E1] transition-colors hover:border-[#334155] hover:text-[#F1F5F9] whitespace-nowrap shrink-0"
                >
                  {copied ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <Copy className="h-3 w-3" />
                  )}
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
                <button
                  type="button"
                  disabled={busy || !editableCypher.trim()}
                  onClick={() => handleExecuteCypher()}
                  className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-950/30 px-2.5 py-1 text-[11px] font-medium text-emerald-300 transition-colors hover:border-emerald-400 hover:bg-emerald-950/50 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  <Play className="h-3 w-3" />
                  <span>{runningCypher ? 'Running...' : 'Run Cypher'}</span>
                </button>
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="inline-flex items-center gap-1 rounded border border-[#243040] bg-[#0D1117] px-2 py-1 text-[11px] font-medium text-[#94A3B8] transition-colors hover:border-[#334155] hover:text-[#F1F5F9] whitespace-nowrap shrink-0"
                >
                  <X className="h-3 w-3" />
                  <span>Clear</span>
                </button>
              </div>
            </div>

            <textarea
              value={editableCypher}
              onChange={(e) => setEditableCypher(e.target.value)}
              rows={6}
              spellCheck={false}
              aria-label="Editable Cypher Query"
              className="w-full resize-y rounded-md border border-[#1F2937] bg-[#090C10] p-3 font-mono text-[11px] leading-relaxed text-emerald-300/95 focus:border-emerald-500 focus:outline-none"
            />

            {cypherResult ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#94A3B8]">
                <span>{cypherResult.explanation}</span>
                <div className="flex items-center gap-3">
                  <span className="font-mono tabular-nums text-[#CBD5E1]">
                    {cypherResult.matchedAssetIds.length} assets ·{' '}
                    {cypherResult.matchedMarketplaceIds.length} venues ·{' '}
                    {cypherResult.matchedEventIds.length} events ·{' '}
                    {cypherResult.relationships.length} edges
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      onChangeVizMode(vizMode === 'ISOLATE' ? 'HIGHLIGHT' : 'ISOLATE')
                    }
                    className="font-mono text-[11px] text-emerald-400 hover:text-emerald-300 whitespace-nowrap shrink-0"
                  >
                    {vizMode === 'ISOLATE' ? 'Show in Full Graph' : 'Isolate Subgraph'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="text-[11px] text-[#94A3B8]">
                Edit node labels (<span className="font-mono text-[#CBD5E1]">:Asset</span>,{' '}
                <span className="font-mono text-[#CBD5E1]">:Marketplace</span>,{' '}
                <span className="font-mono text-[#CBD5E1]">:MarketEvent</span>) or{' '}
                <span className="font-mono text-[#CBD5E1]">WHERE</span> thresholds and click{' '}
                <span className="text-emerald-400">Run Cypher</span> to update the node visualization below.
              </div>
            )}
          </div>

          {/* Matched Node Relationships List */}
          <div className="space-y-2 lg:col-span-5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-[#F1F5F9]">
                Matched Node Relationships ({cypherResult?.relationships.length ?? 0})
              </span>
              <span className="text-[11px] text-[#64748B]">Click row to focus canvas</span>
            </div>

            <div className="max-h-[214px] overflow-y-auto rounded-md border border-[#1F2937] bg-[#0D1117]">
              {!cypherResult ? (
                <div className="p-4 text-xs text-[#94A3B8]">
                  Run a natural-language translation or execute custom Cypher to list matching directed edges and render them in the topology canvas below.
                </div>
              ) : cypherResult.relationships.length === 0 ? (
                <div className="p-4 text-xs text-[#94A3B8]">
                  No graph edges matched the current Cypher predicates. Loosen a{' '}
                  <span className="font-mono text-[#E2E8F0]">WHERE</span> threshold above and click Run Cypher.
                </div>
              ) : (
                <div className="divide-y divide-[#1F2937]">
                  {cypherResult.relationships.map((rel) => {
                    const isEdgeSelected = selectedEdgeId === rel.id;
                    return (
                      <button
                        key={rel.id}
                        type="button"
                        onClick={() => onSelectRelationship(rel)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left transition-colors ${
                          isEdgeSelected ? 'bg-[#161D27]' : 'hover:bg-[#131922]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[11px] font-medium text-[#E2E8F0]">
                            {rel.fromLabel}{' '}
                            <span
                              className={`font-mono text-[10px] ${
                                rel.edgeType === 'IMPACTED'
                                  ? 'text-amber-400'
                                  : 'text-emerald-400'
                              }`}
                            >
                              -[:{rel.relationLabel}]-&gt;
                            </span>{' '}
                            {rel.toLabel}
                          </div>
                        </div>
                        <span className="shrink-0 font-mono text-[11px] tabular-nums text-[#94A3B8]">
                          {rel.metricText}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
