import { useMemo, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Code2,
  Database,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { QueryBuilder } from './QueryBuilder.tsx';
import type {
  CypherBuilderResult,
  CypherSubgraphEdge,
  GraphRagQueryResult,
  GraphStatePayload,
  LLMProviderInfo,
  MarketSegment,
  SemanticSearchHit,
  SwarmRoutingConfig,
} from '../types/graph.ts';
import { apiFetch } from '../utils/apiClient.ts';
import { formatCompactUsd, formatPct, formatUsd } from '../utils/visualAssets.ts';

interface GraphRagExplorerViewProps {
  state: GraphStatePayload;
  providers: LLMProviderInfo[];
  routing: SwarmRoutingConfig;
  segmentFilter: MarketSegment | 'ALL';
  focusedAssetId: string | null;
  onSelectAsset: (assetId: string) => void;
  onRefreshState: (nextState: GraphStatePayload) => void;
}

interface VisualNode {
  id: string;
  label: string;
  sublabel: string;
  type: 'ASSET' | 'MARKETPLACE' | 'EVENT';
  x: number;
  y: number;
  segment?: MarketSegment;
}

interface VisualEdge {
  id: string;
  from: string;
  to: string;
  label: string;
  metricText?: string;
  edgeType: 'SOLD_ON' | 'IMPACTED';
}

const PRESET_QUERIES = [
  'Compare PSA 10 to PSA 9 grade multipliers across vintage TCGs vs graded sports rookies.',
  'Which collectibles currently offer the strongest net arbitrage spread between Cardmarket and eBay?',
  'How have recent championship and tournament catalysts impacted graded sports and TCG prices?',
  'Which assets had shill-bid or mislabeled outliers quarantined from their pricing averages?',
];

export function GraphRagExplorerView({
  state,
  providers,
  routing,
  segmentFilter,
  focusedAssetId,
  onSelectAsset,
  onRefreshState,
}: GraphRagExplorerViewProps) {
  const [consoleMode, setConsoleMode] = useState<'QUERY_BUILDER' | 'BRIEFING'>('QUERY_BUILDER');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    focusedAssetId || state.assets[0]?.id || null
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [showEvents, setShowEvents] = useState(true);
  const [showVenues, setShowVenues] = useState(true);
  const [zoom, setZoom] = useState(1);

  // Active Cypher Subgraph Visualization state
  const [cypherResult, setCypherResult] = useState<CypherBuilderResult | null>(null);
  const [vizMode, setVizMode] = useState<'ISOLATE' | 'HIGHLIGHT'>('ISOLATE');

  const activeLlmProvider = providers.find((p) => p.id === routing.graphRagSynthesis);
  const activeProviderLabel = activeLlmProvider?.label || 'Google Gemini';
  const activeModelLabel = activeLlmProvider?.defaultModel || 'gemini-4-hydrogen';

  // GraphRAG Briefing Console state
  const [question, setQuestion] = useState(PRESET_QUERIES[0]);
  const [queryLoading, setQueryLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<GraphRagQueryResult | null>(null);

  // Community Summary refresh state
  const [refreshingCommunityId, setRefreshingCommunityId] = useState<string | null>(null);
  const [communityError, setCommunityError] = useState<string | null>(null);

  // Hybrid Vector Embeddings & Semantic Search state
  const [semanticQuery, setSemanticQuery] = useState('');
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticHits, setSemanticHits] = useState<SemanticSearchHit[]>([]);
  const [semanticMode, setSemanticMode] = useState<string | null>(null);
  const [reindexingVectors, setReindexingVectors] = useState(false);
  const [vectorFeedback, setVectorFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const isSubgraphIsolated = Boolean(cypherResult && vizMode === 'ISOLATE');

  const cypherNodeSets = useMemo(() => {
    if (!cypherResult) return null;
    return {
      assets: new Set(cypherResult.matchedAssetIds),
      marketplaces: new Set(cypherResult.matchedMarketplaceIds),
      events: new Set(cypherResult.matchedEventIds),
      all: new Set([
        ...cypherResult.matchedAssetIds,
        ...cypherResult.matchedMarketplaceIds,
        ...cypherResult.matchedEventIds,
      ]),
      edgePairs: new Set(
        cypherResult.relationships.map((r) => `${r.edgeType}:${r.fromId}->${r.toId}`)
      ),
      edgeMetricMap: new Map(
        cypherResult.relationships.map((r) => [`${r.edgeType}:${r.fromId}->${r.toId}`, r.metricText])
      ),
    };
  }, [cypherResult]);

  // Build deterministic layered graph coordinates (Venues Top, Assets Middle, Events Bottom)
  const { nodes, edges } = useMemo(() => {
    const visualNodes: VisualNode[] = [];
    const visualEdges: VisualEdge[] = [];
    const canvasWidth = 920;

    if (cypherResult && vizMode === 'ISOLATE') {
      const matchedAssetSet = new Set(cypherResult.matchedAssetIds);
      const matchedMarketSet = new Set(cypherResult.matchedMarketplaceIds);
      const matchedEventSet = new Set(cypherResult.matchedEventIds);

      const scopedMarkets = showVenues
        ? state.marketplaces.filter((m) => matchedMarketSet.has(m.id))
        : [];
      const scopedAssets = state.assets.filter((a) => matchedAssetSet.has(a.id));
      const scopedEvents = showEvents
        ? state.events.filter((ev) => matchedEventSet.has(ev.id))
        : [];

      // Top Tier: Matched Marketplaces
      scopedMarkets.forEach((m, idx) => {
        const x = ((idx + 1) / (scopedMarkets.length + 1)) * canvasWidth;
        visualNodes.push({
          id: m.id,
          label: m.name,
          sublabel: `${m.sellerFeePct}% fee`,
          type: 'MARKETPLACE',
          x,
          y: 66,
        });
      });

      // Middle Tier: Matched Canonical Assets
      const stagger = scopedAssets.length > 5;
      scopedAssets.forEach((a, idx) => {
        const x = ((idx + 1) / (scopedAssets.length + 1)) * canvasWidth;
        const y = stagger ? (idx % 2 === 0 ? 202 : 276) : 238;
        const v = state.valuations[a.id];
        visualNodes.push({
          id: a.id,
          label: a.title.length > 20 ? `${a.title.slice(0, 19)}…` : a.title,
          sublabel: `${a.franchise} · ${v ? formatCompactUsd(v.topGradeAvg) : ''}`,
          type: 'ASSET',
          x,
          y,
          segment: a.segment,
        });
      });

      // Bottom Tier: Matched Market Events
      scopedEvents.forEach((ev, idx) => {
        const x = ((idx + 1) / (scopedEvents.length + 1)) * canvasWidth;
        visualNodes.push({
          id: ev.id,
          label: ev.title.length > 26 ? `${ev.title.slice(0, 25)}…` : ev.title,
          sublabel: `${ev.category} · ${formatPct(ev.priceDeltaPct)}`,
          type: 'EVENT',
          x,
          y: 410,
        });
      });

      const renderedIds = new Set(visualNodes.map((n) => n.id));
      for (const rel of cypherResult.relationships) {
        if (rel.edgeType === 'SOLD_ON' && !showVenues) continue;
        if (rel.edgeType === 'IMPACTED' && !showEvents) continue;
        if (!renderedIds.has(rel.fromId) || !renderedIds.has(rel.toId)) continue;
        visualEdges.push({
          id: rel.id,
          from: rel.fromId,
          to: rel.toId,
          label: `${rel.relationLabel} · ${rel.metricText}`,
          metricText: rel.metricText,
          edgeType: rel.edgeType,
        });
      }

      return { nodes: visualNodes, edges: visualEdges };
    }

    // Standard full topology (or Highlight-in-Full mode when a Cypher subgraph is active)
    const scopedAssets = state.assets
      .filter((a) => segmentFilter === 'ALL' || a.segment === segmentFilter)
      .slice(0, 10);

    // Ensure Cypher-matched assets are visible in Highlight mode even if outside top 10 slice
    if (cypherResult && vizMode === 'HIGHLIGHT') {
      const existingIds = new Set(scopedAssets.map((a) => a.id));
      for (const id of cypherResult.matchedAssetIds) {
        if (!existingIds.has(id)) {
          const found = state.assets.find((a) => a.id === id);
          if (found) {
            scopedAssets.push(found);
            existingIds.add(id);
          }
        }
      }
    }

    // Top Tier: Marketplaces
    if (showVenues) {
      const mCount = state.marketplaces.length;
      state.marketplaces.forEach((m, idx) => {
        const x = ((idx + 1) / (mCount + 1)) * canvasWidth;
        visualNodes.push({
          id: m.id,
          label: m.name,
          sublabel: `${m.sellerFeePct}% fee`,
          type: 'MARKETPLACE',
          x,
          y: 66,
        });
      });
    }

    // Middle Tier: Canonical Assets
    const aCount = scopedAssets.length;
    scopedAssets.forEach((a, idx) => {
      const x = ((idx + 1) / (aCount + 1)) * canvasWidth;
      const y = idx % 2 === 0 ? 205 : 275;
      const v = state.valuations[a.id];
      visualNodes.push({
        id: a.id,
        label: a.title.length > 20 ? `${a.title.slice(0, 19)}…` : a.title,
        sublabel: `${a.franchise} · ${v ? formatCompactUsd(v.topGradeAvg) : ''}`,
        type: 'ASSET',
        x,
        y,
        segment: a.segment,
      });
    });

    const assetIdSet = new Set(scopedAssets.map((a) => a.id));

    // Bottom Tier: Market Events
    if (showEvents) {
      const relevantEvents = state.events.filter((ev) =>
        ev.impactedAssetIds.some((id) => assetIdSet.has(id))
      );
      const eCount = relevantEvents.length;
      relevantEvents.forEach((ev, idx) => {
        const x = ((idx + 1) / (eCount + 1)) * canvasWidth;
        visualNodes.push({
          id: ev.id,
          label: ev.title.length > 26 ? `${ev.title.slice(0, 25)}…` : ev.title,
          sublabel: `${ev.category} · ${formatPct(ev.priceDeltaPct)}`,
          type: 'EVENT',
          x,
          y: 410,
        });

        for (const targetAssetId of ev.impactedAssetIds) {
          if (assetIdSet.has(targetAssetId)) {
            const pairKey = `IMPACTED:${ev.id}->${targetAssetId}`;
            const metric =
              cypherNodeSets?.edgeMetricMap.get(pairKey) ||
              `${formatPct(ev.priceDeltaPct)} (${ev.windowDays}d)`;
            visualEdges.push({
              id: `IMP-${ev.id}-${targetAssetId}`,
              from: ev.id,
              to: targetAssetId,
              label: `IMPACTED · ${metric}`,
              metricText: metric,
              edgeType: 'IMPACTED',
            });
          }
        }
      });
    }

    // Aggregate SOLD_ON edges from verified sales
    if (showVenues) {
      const seenPairs = new Map<string, { count: number; total: number }>();
      for (const s of state.sales) {
        if (s.status !== 'VERIFIED' || !assetIdSet.has(s.assetId)) continue;
        const key = `${s.assetId}__${s.marketplaceId}`;
        const cur = seenPairs.get(key) || { count: 0, total: 0 };
        cur.count += 1;
        cur.total += s.priceUsd;
        seenPairs.set(key, cur);
      }
      for (const [pair, stats] of seenPairs.entries()) {
        const [assetId, marketplaceId] = pair.split('__');
        const avg = Math.round(stats.total / stats.count);
        const pairKey = `SOLD_ON:${assetId}->${marketplaceId}`;
        const metric =
          cypherNodeSets?.edgeMetricMap.get(pairKey) ||
          `${stats.count} comp${stats.count === 1 ? '' : 's'} · ${formatCompactUsd(avg)} avg`;
        visualEdges.push({
          id: `SOLD-${pair}`,
          from: assetId,
          to: marketplaceId,
          label: `SOLD_ON · ${metric}`,
          metricText: metric,
          edgeType: 'SOLD_ON',
        });
      }
    }

    return { nodes: visualNodes, edges: visualEdges };
  }, [
    state.assets,
    state.marketplaces,
    state.events,
    state.sales,
    state.valuations,
    segmentFilter,
    showEvents,
    showVenues,
    cypherResult,
    vizMode,
    cypherNodeSets,
  ]);

  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const activeHighlightIds = useMemo(() => {
    const set = new Set<string>();
    if (cypherNodeSets && vizMode === 'HIGHLIGHT') {
      cypherNodeSets.all.forEach((id) => set.add(id));
    }
    if (queryResult && !cypherResult) {
      queryResult.matchedAssetIds.forEach((id) => set.add(id));
      queryResult.matchedEventIds.forEach((id) => set.add(id));
    }
    if (selectedNodeId) {
      set.add(selectedNodeId);
      edges.forEach((e) => {
        if (e.from === selectedNodeId) set.add(e.to);
        if (e.to === selectedNodeId) set.add(e.from);
      });
    }
    return set;
  }, [selectedNodeId, edges, queryResult, cypherNodeSets, cypherResult, vizMode]);

  function handleCypherResult(result: CypherBuilderResult) {
    setCypherResult(result);
    setVizMode('ISOLATE');
    setSelectedEdgeId(null);
    if (result.matchedAssetIds[0]) {
      setSelectedNodeId(result.matchedAssetIds[0]);
    } else if (result.matchedEventIds[0]) {
      setSelectedNodeId(result.matchedEventIds[0]);
    } else if (result.matchedMarketplaceIds[0]) {
      setSelectedNodeId(result.matchedMarketplaceIds[0]);
    }
  }

  function handleClearCypher() {
    setCypherResult(null);
    setSelectedEdgeId(null);
  }

  function handleSelectRelationship(rel: CypherSubgraphEdge) {
    setSelectedEdgeId(rel.id);
    setSelectedNodeId(rel.fromType === 'ASSET' ? rel.fromId : rel.toId);
  }

  async function handleRunQuery(e?: FormEvent, overrideQuestion?: string) {
    if (e) e.preventDefault();
    const q = (overrideQuestion ?? question).trim();
    if (!q) return;
    setQuestion(q);
    setQueryError(null);
    setQueryLoading(true);
    try {
      const res = await apiFetch('/api/graphrag/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'GraphRAG query failed.');
      setQueryResult(json as GraphRagQueryResult);
      if (json.matchedAssetIds?.[0]) {
        setSelectedNodeId(json.matchedAssetIds[0]);
      }
    } catch (err) {
      setQueryError(err instanceof Error ? err.message : 'Query failed.');
    } finally {
      setQueryLoading(false);
    }
  }

  async function handleRefreshCommunity(communityId: string) {
    setCommunityError(null);
    setRefreshingCommunityId(communityId);
    try {
      const res = await apiFetch('/api/graphrag/community-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ communityId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Synthesis failed.');
      if (json.state) onRefreshState(json.state);
    } catch (err) {
      setCommunityError(err instanceof Error ? err.message : 'Unable to refresh summary.');
    } finally {
      setRefreshingCommunityId(null);
    }
  }

  async function handleReindexVectors() {
    setReindexingVectors(true);
    setVectorFeedback(null);
    try {
      const res = await apiFetch('/api/embeddings/reindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceAll: false }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Vector indexing failed.');
      if (json.state) onRefreshState(json.state);
      setVectorFeedback({
        ok: true,
        msg: `Indexed ${json.newlyIndexed} new node(s) (${json.totalIndexed} total vectors via ${json.model}).`,
      });
    } catch (err) {
      setVectorFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Vector reindex failed.',
      });
    } finally {
      setReindexingVectors(false);
    }
  }

  async function handleSemanticSearch(e: FormEvent) {
    e.preventDefault();
    const q = semanticQuery.trim();
    if (!q) return;
    setSemanticLoading(true);
    setVectorFeedback(null);
    try {
      const res = await apiFetch('/api/embeddings/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, topK: 5 }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Semantic search failed.');
      setSemanticHits((json.hits || []) as SemanticSearchHit[]);
      setSemanticMode(json.mode || null);
      if (json.hits?.[0]?.id) {
        setSelectedNodeId(json.hits[0].id);
      }
    } catch (err) {
      setVectorFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Semantic search failed.',
      });
    } finally {
      setSemanticLoading(false);
    }
  }

  const selectedAsset = state.assets.find((a) => a.id === selectedNodeId);
  const selectedVal = selectedAsset ? state.valuations[selectedAsset.id] : null;
  const selectedEvent = state.events.find((e) => e.id === selectedNodeId);
  const selectedMarket = state.marketplaces.find((m) => m.id === selectedNodeId);

  return (
    <div className="space-y-6">
      {/* Layer 2 Console: Query Builder (NL -> Cypher -> Graph) + GraphRAG Briefing */}
      <section className="rounded-lg border border-[#1F2937] bg-[#11161D]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1F2937] px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              {consoleMode === 'QUERY_BUILDER'
                ? 'Layer 2: Natural-Language Cypher Query Builder'
                : 'Layer 2: Multi-Hop GraphRAG Briefing Console'}
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              {consoleMode === 'QUERY_BUILDER'
                ? 'Write a natural-language question to translate into Cypher via the active server LLM and visualize matching node relationships directly in the ontology canvas below.'
                : 'Deterministic graph traversal computes exact medians, ratios, and spreads first; the active server LLM synthesizes the briefing strictly from verified query outputs.'}
            </p>
          </div>

          <div
            role="tablist"
            aria-label="GraphRAG Explorer Console Mode"
            className="inline-flex items-center rounded-md border border-[#1F2937] bg-[#0D1117] p-0.5"
          >
            <button
              type="button"
              role="tab"
              aria-selected={consoleMode === 'QUERY_BUILDER'}
              onClick={() => setConsoleMode('QUERY_BUILDER')}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                consoleMode === 'QUERY_BUILDER'
                  ? 'bg-[#161D27] text-emerald-400'
                  : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>Query Builder</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={consoleMode === 'BRIEFING'}
              onClick={() => setConsoleMode('BRIEFING')}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                consoleMode === 'BRIEFING'
                  ? 'bg-[#161D27] text-emerald-400'
                  : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              <Database className="h-3.5 w-3.5" />
              <span>GraphRAG Briefing</span>
            </button>
          </div>
        </div>

        {/* Mode 1: Natural-Language to Cypher Query Builder Component */}
        {consoleMode === 'QUERY_BUILDER' && (
          <QueryBuilder
            activeProviderId={routing.graphRagSynthesis}
            activeProviderLabel={activeProviderLabel}
            activeModelLabel={activeModelLabel}
            cypherResult={cypherResult}
            vizMode={vizMode}
            selectedEdgeId={selectedEdgeId}
            onResult={handleCypherResult}
            onClear={handleClearCypher}
            onChangeVizMode={setVizMode}
            onSelectRelationship={handleSelectRelationship}
          />
        )}

        {/* Mode 2: Existing Multi-Hop GraphRAG Synthesis Console */}
        {consoleMode === 'BRIEFING' && (
          <div className="space-y-4 p-5">
            <form onSubmit={handleRunQuery} className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#64748B]" />
                <input
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask a multi-hop market question across grades, venues, and catalysts..."
                  className="w-full rounded-md border border-[#243040] bg-[#090C10] py-2 pl-9 pr-3 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={queryLoading}
                className="inline-flex items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <Database className="h-3.5 w-3.5" />
                <span>{queryLoading ? 'Traversing Graph...' : 'Execute GraphRAG'}</span>
              </button>
            </form>

            {/* Preset Multi-Hop Prompts */}
            <div className="flex flex-wrap gap-2">
              {PRESET_QUERIES.map((preset, i) => (
                <button
                  key={i}
                  type="button"
                  disabled={queryLoading}
                  onClick={() => handleRunQuery(undefined, preset)}
                  className="rounded-md border border-[#1F2937] bg-[#0D1117] px-2.5 py-1.5 text-left text-[11px] text-[#94A3B8] transition-colors hover:border-[#334155] hover:text-[#F1F5F9]"
                >
                  {preset}
                </button>
              ))}
            </div>

            {queryError && (
              <div className="flex items-start gap-2 rounded-md border border-red-500/40 bg-red-950/35 px-3.5 py-2.5 text-xs text-red-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
                <span>{queryError}</span>
              </div>
            )}

            {queryResult && (
              <div className="grid grid-cols-1 gap-4 border-t border-[#1F2937] pt-4 lg:grid-cols-12">
                <div className="space-y-3 lg:col-span-7">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-emerald-400">
                      Synthesized Analytical Briefing
                    </span>
                    <span className="font-mono text-[11px] text-[#94A3B8]">
                      {queryResult.providerUsed} · {queryResult.modelUsed} · {queryResult.latencyMs}ms
                    </span>
                  </div>
                  <p className="rounded-md border border-[#1F2937] bg-[#0D1117] p-4 text-xs leading-relaxed text-[#E2E8F0]">
                    {queryResult.synthesis}
                  </p>

                  <div>
                    <div className="text-[11px] font-medium text-[#94A3B8]">
                      Executed Cypher-Equivalent Graph Query
                    </div>
                    <pre className="mt-1.5 overflow-x-auto rounded-md border border-[#1F2937] bg-[#090C10] p-3 font-mono text-[11px] leading-relaxed text-emerald-300/90">
                      {queryResult.cypherQuery}
                    </pre>
                  </div>
                </div>

                <div className="space-y-2 lg:col-span-5">
                  <div className="text-xs font-semibold text-[#F1F5F9]">
                    Deterministic Graph Engine Facts (Zero LLM Math)
                  </div>
                  <div className="divide-y divide-[#1F2937] rounded-md border border-[#1F2937] bg-[#0D1117]">
                    {queryResult.deterministicFacts.map((fact, idx) => (
                      <div key={idx} className="p-3">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-medium text-[#E2E8F0]">
                            {fact.label}
                          </span>
                          <span className="font-mono text-xs font-semibold tabular-nums text-amber-400 shrink-0">
                            {fact.value}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-[#94A3B8]">
                          {fact.context}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Hybrid Vector Index & Semantic Node Retrieval Bar */}
      <section className="rounded-lg border border-[#1F2937] bg-[#11161D] p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5 font-semibold text-[#F1F5F9]">
              <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
              <span>Hybrid Vector Index</span>
            </span>
            <span className="font-mono text-[11px] text-[#94A3B8]">
              {state.vectorIndex.model} · {state.vectorIndex.indexedAssets}/{state.vectorIndex.totalAssets} assets ·{' '}
              {state.vectorIndex.indexedEvents}/{state.vectorIndex.totalEvents} events
            </span>
            <button
              type="button"
              disabled={reindexingVectors || !state.vectorIndex.configured || state.assets.length === 0}
              onClick={handleReindexVectors}
              className="inline-flex items-center gap-1 rounded border border-[#243040] bg-[#161D27] px-2.5 py-1 text-[11px] font-medium text-emerald-300 hover:border-emerald-500/50 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <RefreshCw className={`h-3 w-3 ${reindexingVectors ? 'animate-spin' : ''}`} />
              <span>{reindexingVectors ? 'Embedding...' : 'Reindex Vectors'}</span>
            </button>
          </div>

          <form onSubmit={handleSemanticSearch} className="flex flex-1 items-center gap-2 lg:max-w-md">
            <input
              type="text"
              value={semanticQuery}
              onChange={(e) => setSemanticQuery(e.target.value)}
              placeholder="Semantic search across embedded nodes..."
              className="flex-1 rounded-md border border-[#243040] bg-[#090C10] px-3 py-1.5 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={semanticLoading || !semanticQuery.trim()}
              className="rounded-md border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-[#E2E8F0] hover:border-emerald-500/50 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              {semanticLoading ? 'Searching...' : 'Semantic Find'}
            </button>
          </form>
        </div>

        {vectorFeedback && (
          <div
            className={`mt-2.5 text-xs ${
              vectorFeedback.ok ? 'text-emerald-400' : 'text-red-400'
            }`}
          >
            {vectorFeedback.msg}
          </div>
        )}

        {semanticHits.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#1F2937] pt-3">
            <span className="font-mono text-[11px] text-[#64748B]">
              Matches ({semanticMode}):
            </span>
            {semanticHits.map((hit) => (
              <button
                key={`${hit.kind}-${hit.id}`}
                type="button"
                onClick={() => setSelectedNodeId(hit.id)}
                className={`rounded border px-2.5 py-1 text-[11px] transition-colors ${
                  selectedNodeId === hit.id
                    ? 'border-emerald-500/60 bg-[#161D27] text-emerald-300'
                    : 'border-[#1F2937] bg-[#0D1117] text-[#CBD5E1] hover:border-[#334155]'
                }`}
              >
                <span>{hit.title}</span>
                <span className="ml-1.5 font-mono text-[10px] text-[#64748B]">
                  {(hit.score * 100).toFixed(0)}%
                </span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Interactive SVG Knowledge Graph Canvas + Selected Node Inspector */}
      <section className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        <div className="overflow-hidden rounded-lg border border-[#1F2937] bg-[#11161D] xl:col-span-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1F2937] px-5 py-3.5">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-[#F1F5F9]">
                  Interactive Ontology Topology
                </h3>
                {cypherResult && (
                  <span className="font-mono text-[11px] text-emerald-400">
                    · Cypher Subgraph Active ({edges.length} edges)
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-[#94A3B8]">
                <span className="text-emerald-400">
                  Assets ({nodes.filter((n) => n.type === 'ASSET').length})
                </span>
                <span aria-hidden="true">·</span>
                <span className="text-sky-400">
                  Marketplaces ({nodes.filter((n) => n.type === 'MARKETPLACE').length})
                </span>
                <span aria-hidden="true">·</span>
                <span className="text-amber-400">
                  Market Events ({nodes.filter((n) => n.type === 'EVENT').length})
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {cypherResult && (
                <div className="inline-flex items-center rounded border border-[#1F2937] bg-[#0D1117] p-0.5">
                  <button
                    type="button"
                    onClick={() => setVizMode('ISOLATE')}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                      vizMode === 'ISOLATE'
                        ? 'bg-[#161D27] text-emerald-400'
                        : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    Isolate Subgraph
                  </button>
                  <button
                    type="button"
                    onClick={() => setVizMode('HIGHLIGHT')}
                    className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                      vizMode === 'HIGHLIGHT'
                        ? 'bg-[#161D27] text-emerald-400'
                        : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                    }`}
                  >
                    Highlight in Full
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => setShowVenues((v) => !v)}
                className={`rounded border px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  showVenues
                    ? 'border-[#334155] bg-[#161D27] text-[#F1F5F9]'
                    : 'border-[#1F2937] text-[#64748B]'
                }`}
              >
                SOLD_ON Edges
              </button>
              <button
                type="button"
                onClick={() => setShowEvents((v) => !v)}
                className={`rounded border px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  showEvents
                    ? 'border-[#334155] bg-[#161D27] text-[#F1F5F9]'
                    : 'border-[#1F2937] text-[#64748B]'
                }`}
              >
                IMPACTED Edges
              </button>
              <div className="ml-0.5 inline-flex items-center rounded border border-[#1F2937] bg-[#0D1117]">
                <button
                  type="button"
                  aria-label="Zoom out"
                  onClick={() => setZoom((z) => Math.max(0.75, z - 0.15))}
                  className="p-1.5 text-[#94A3B8] hover:text-[#F1F5F9]"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Reset zoom"
                  onClick={() => setZoom(1)}
                  className="p-1.5 text-[#94A3B8] hover:text-[#F1F5F9]"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Zoom in"
                  onClick={() => setZoom((z) => Math.min(1.4, z + 0.15))}
                  className="p-1.5 text-[#94A3B8] hover:text-[#F1F5F9]"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto bg-[#090C10] p-3">
            {state.assets.length === 0 ? (
              <div className="flex h-[430px] flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="text-xs font-medium text-[#E2E8F0]">
                  Knowledge Graph canvas is empty — {state.marketplaces.length} canonical marketplace venues are ready.
                </p>
                <p className="max-w-md text-[11px] text-[#94A3B8]">
                  Register canonical collectibles in the Setup Guide or via + Register Asset to visualize Asset, Marketplace, and MarketEvent edges.
                </p>
              </div>
            ) : nodes.length === 0 ? (
              <div className="flex h-[430px] flex-col items-center justify-center gap-2 text-center">
                <p className="text-xs font-medium text-[#E2E8F0]">
                  Zero nodes matched the isolated Cypher subgraph.
                </p>
                <button
                  type="button"
                  onClick={handleClearCypher}
                  className="rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-emerald-400 hover:border-emerald-500/60"
                >
                  Restore Full Knowledge Graph
                </button>
              </div>
            ) : (
              <svg
                viewBox="0 0 920 475"
                className="h-[430px] w-full min-w-[740px] select-none"
                style={{
                  transform: `scale(${zoom})`,
                  transformOrigin: 'center center',
                  transition: 'transform 180ms ease-out',
                }}
              >
                <defs>
                  <marker
                    id="arrow-emerald"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#10B981" />
                  </marker>
                  <marker
                    id="arrow-amber"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#F59E0B" />
                  </marker>
                  <marker
                    id="arrow-muted"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="5"
                    markerHeight="5"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1.5 L 10 5 L 0 8.5 z" fill="#334155" />
                  </marker>
                </defs>

                {/* Tier Guide Labels */}
                <text x="16" y="30" fill="#475569" fontSize="10" fontFamily="JetBrains Mono">
                  MARKETPLACE VENUES
                </text>
                <text x="16" y="162" fill="#475569" fontSize="10" fontFamily="JetBrains Mono">
                  CANONICAL COLLECTIBLE ASSETS (TCG &amp; SPORTS)
                </text>
                <text x="16" y="366" fill="#475569" fontSize="10" fontFamily="JetBrains Mono">
                  MARKET CATALYST EVENTS
                </text>

                {/* Directed Edges */}
                {edges.map((edge, idx) => {
                  const a = nodeMap.get(edge.from);
                  const b = nodeMap.get(edge.to);
                  if (!a || !b) return null;

                  const pairKey = `${edge.edgeType}:${edge.from}->${edge.to}`;
                  const isCypherMatchedEdge = Boolean(
                    cypherNodeSets?.edgePairs.has(pairKey)
                  );
                  const isSelectedEdge = selectedEdgeId === edge.id;
                  const touchesSelectedNode =
                    selectedNodeId === edge.from || selectedNodeId === edge.to;

                  const highlighted =
                    isSelectedEdge ||
                    isSubgraphIsolated ||
                    (cypherResult && vizMode === 'HIGHLIGHT'
                      ? isCypherMatchedEdge
                      : touchesSelectedNode);

                  const dimmedEdge =
                    Boolean(cypherResult && vizMode === 'HIGHLIGHT' && !isCypherMatchedEdge);

                  const strokeColor =
                    edge.edgeType === 'IMPACTED'
                      ? highlighted
                        ? '#F59E0B'
                        : '#78350F'
                      : highlighted
                        ? '#10B981'
                        : '#1E293B';

                  const markerEnd =
                    edge.edgeType === 'IMPACTED'
                      ? highlighted
                        ? 'url(#arrow-amber)'
                        : undefined
                      : highlighted
                        ? 'url(#arrow-emerald)'
                        : undefined;

                  // Shorten line ends slightly so arrowheads land right at node borders
                  const dx = b.x - a.x;
                  const dy = b.y - a.y;
                  const dist = Math.hypot(dx, dy) || 1;
                  const padStart = 24;
                  const padEnd = 28;
                  const x1 = a.x + (dx / dist) * padStart;
                  const y1 = a.y + (dy / dist) * padStart;
                  const x2 = b.x - (dx / dist) * padEnd;
                  const y2 = b.y - (dy / dist) * padEnd;

                  // Show crisp inline relationship labels in Isolate mode (or for selected edge)
                  const showInlineLabel =
                    isSelectedEdge ||
                    (isSubgraphIsolated && edges.length <= 14) ||
                    (cypherResult &&
                      vizMode === 'HIGHLIGHT' &&
                      isCypherMatchedEdge &&
                      touchesSelectedNode);

                  // Offset label ratio subtly by index to minimize crossing collisions
                  const t = 0.44 + ((idx % 3) * 0.08);
                  const lx = x1 + (x2 - x1) * t;
                  const ly = y1 + (y2 - y1) * t;
                  const shortEdgeLabel =
                    edge.metricText && edge.metricText.length <= 24
                      ? `${edge.edgeType} · ${edge.metricText}`
                      : edge.edgeType;
                  const labelW = Math.min(180, Math.max(76, shortEdgeLabel.length * 5.6 + 12));

                  return (
                    <g
                      key={edge.id}
                      onClick={() => {
                        setSelectedEdgeId(edge.id);
                        setSelectedNodeId(edge.from);
                      }}
                      className="cursor-pointer"
                    >
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke={strokeColor}
                        strokeWidth={isSelectedEdge ? 2.5 : highlighted ? 1.8 : 1}
                        strokeOpacity={
                          isSelectedEdge
                            ? 1
                            : dimmedEdge
                              ? 0.16
                              : highlighted
                                ? 0.92
                                : 0.45
                        }
                        strokeDasharray={edge.edgeType === 'IMPACTED' ? '4 3' : undefined}
                        markerEnd={markerEnd}
                      />
                      {showInlineLabel && (
                        <g transform={`translate(${lx - labelW / 2}, ${ly - 9})`}>
                          <rect
                            width={labelW}
                            height={17}
                            rx={3}
                            fill="#090C10"
                            fillOpacity={0.92}
                            stroke={
                              edge.edgeType === 'IMPACTED'
                                ? 'rgba(245, 158, 11, 0.45)'
                                : 'rgba(16, 185, 129, 0.45)'
                            }
                            strokeWidth={0.8}
                          />
                          <text
                            x={labelW / 2}
                            y={11.5}
                            textAnchor="middle"
                            fill={edge.edgeType === 'IMPACTED' ? '#FCD34D' : '#6EE7B7'}
                            fontSize="8.5"
                            fontFamily="JetBrains Mono"
                          >
                            {shortEdgeLabel}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}

                {/* Nodes */}
                {nodes.map((node) => {
                  const isSelected = selectedNodeId === node.id;
                  const isCypherMatchedNode = Boolean(cypherNodeSets?.all.has(node.id));
                  const isNeighbor = activeHighlightIds.has(node.id);
                  const dimmed =
                    cypherResult && vizMode === 'HIGHLIGHT'
                      ? !isCypherMatchedNode && !isSelected
                      : !isSubgraphIsolated && Boolean(selectedNodeId) && !isNeighbor;

                  const stroke =
                    node.type === 'ASSET'
                      ? isSelected || (cypherResult && isCypherMatchedNode)
                        ? '#10B981'
                        : '#2D4039'
                      : node.type === 'EVENT'
                        ? isSelected || (cypherResult && isCypherMatchedNode)
                          ? '#F59E0B'
                          : '#57411A'
                        : isSelected || (cypherResult && isCypherMatchedNode)
                          ? '#38BDF8'
                          : '#243547';

                  const fill = isSelected
                    ? '#161D27'
                    : node.type === 'ASSET'
                      ? '#11161D'
                      : '#0D1117';

                  const dotColor =
                    node.type === 'ASSET'
                      ? '#10B981'
                      : node.type === 'EVENT'
                        ? '#F59E0B'
                        : '#38BDF8';

                  const rectW =
                    node.type === 'MARKETPLACE' ? 116 : node.type === 'EVENT' ? 156 : 134;
                  const rectH = 44;

                  return (
                    <g
                      key={node.id}
                      transform={`translate(${node.x - rectW / 2}, ${node.y - rectH / 2})`}
                      onClick={() => {
                        setSelectedNodeId(node.id);
                        setSelectedEdgeId(null);
                      }}
                      className="cursor-pointer"
                      opacity={dimmed ? 0.25 : 1}
                    >
                      <rect
                        width={rectW}
                        height={rectH}
                        rx={6}
                        fill={fill}
                        stroke={stroke}
                        strokeWidth={isSelected ? 1.9 : isCypherMatchedNode ? 1.4 : 1}
                      />
                      <rect x={8} y={10} width={4} height={24} rx={2} fill={dotColor} />
                      <text
                        x={18}
                        y={19}
                        fill="#F1F5F9"
                        fontSize="10.5"
                        fontWeight="600"
                        fontFamily="DM Sans"
                      >
                        {node.label}
                      </text>
                      <text
                        x={18}
                        y={34}
                        fill="#94A3B8"
                        fontSize="9.5"
                        fontFamily="JetBrains Mono"
                      >
                        {node.sublabel}
                      </text>
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        </div>

        {/* Selected Node Neighborhood Inspector */}
        <div className="rounded-lg border border-[#1F2937] bg-[#11161D] xl:col-span-4">
          <div className="border-b border-[#1F2937] px-5 py-3.5">
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Node Neighborhood Inspector
            </h3>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Click any node or edge in the topology canvas to inspect deterministic metrics.
            </p>
          </div>

          <div className="p-5">
            {selectedAsset && selectedVal && (
              <div className="space-y-4">
                <div>
                  <div className="font-mono text-xs text-emerald-400">
                    (:Asset) · {selectedAsset.id}
                  </div>
                  <h4 className="mt-1 text-base font-semibold text-[#F1F5F9]">
                    {selectedAsset.title}
                  </h4>
                  <p className="mt-0.5 text-xs text-[#94A3B8]">
                    {selectedAsset.franchise} · {selectedAsset.setName} ({selectedAsset.releaseYear})
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-3 border-t border-[#1F2937] pt-3 text-xs">
                  <div>
                    <div className="text-[#94A3B8]">{selectedVal.topGradeLabel} Avg</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-[#F1F5F9]">
                      {formatUsd(selectedVal.topGradeAvg)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#94A3B8]">10/9 Multiplier</div>
                    <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums text-amber-400">
                      {selectedVal.gradeMultiplier.toFixed(2)}x
                    </div>
                  </div>
                  <div>
                    <div className="text-[#94A3B8]">Verified Comps</div>
                    <div className="mt-0.5 font-mono text-sm tabular-nums text-[#E2E8F0]">
                      {selectedVal.verifiedSaleCount}
                    </div>
                  </div>
                  <div>
                    <div className="text-[#94A3B8]">Top Pop Count</div>
                    <div className="mt-0.5 font-mono text-sm tabular-nums text-[#E2E8F0]">
                      {selectedVal.topGradePop.toLocaleString()}
                    </div>
                  </div>
                </div>

                <div className="border-t border-[#1F2937] pt-3">
                  <div className="text-xs font-medium text-[#CBD5E1]">
                    Connected Edges ({edges.filter((e) => e.from === selectedAsset.id || e.to === selectedAsset.id).length})
                  </div>
                  <div className="mt-2 space-y-1.5 font-mono text-[11px] text-[#94A3B8]">
                    {edges
                      .filter((e) => e.from === selectedAsset.id || e.to === selectedAsset.id)
                      .map((e) => (
                        <div key={e.id} className="truncate">
                          ({e.from}) -[{e.label}]-&gt; ({e.to})
                        </div>
                      ))}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onSelectAsset(selectedAsset.id)}
                  className="w-full rounded-md border border-[#243040] bg-[#161D27] px-3 py-2 text-xs font-medium text-[#F1F5F9] transition-colors hover:border-emerald-500/60 hover:text-emerald-300"
                >
                  Open Full Asset Valuation Drawer
                </button>
              </div>
            )}

            {selectedEvent && (
              <div className="space-y-3">
                <div className="font-mono text-xs text-amber-400">
                  (:MarketEvent) · {selectedEvent.id}
                </div>
                <h4 className="text-base font-semibold text-[#F1F5F9]">
                  {selectedEvent.title}
                </h4>
                <div className="text-xs text-[#94A3B8]">
                  {selectedEvent.category} · {selectedEvent.date} · {formatPct(selectedEvent.priceDeltaPct)} ({selectedEvent.windowDays}d)
                </div>
                <p className="text-xs leading-relaxed text-[#CBD5E1]">
                  {selectedEvent.summary}
                </p>
                <div className="border-t border-[#1F2937] pt-3">
                  <div className="text-xs font-medium text-[#CBD5E1]">
                    Impacted Canonical Assets
                  </div>
                  <div className="mt-2 space-y-1.5">
                    {selectedEvent.impactedAssetIds.map((aid) => {
                      const a = state.assets.find((x) => x.id === aid);
                      return (
                        <button
                          key={aid}
                          type="button"
                          onClick={() => setSelectedNodeId(aid)}
                          className="block w-full rounded border border-[#1F2937] bg-[#0D1117] px-3 py-2 text-left text-xs text-[#E2E8F0] hover:border-emerald-500/50"
                        >
                          {a?.title || aid}{' '}
                          <span className="font-mono text-[11px] text-[#64748B]">
                            ({aid})
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}

            {selectedMarket && (
              <div className="space-y-3">
                <div className="font-mono text-xs text-sky-400">
                  (:Marketplace) · {selectedMarket.id}
                </div>
                <h4 className="text-base font-semibold text-[#F1F5F9]">
                  {selectedMarket.name}
                </h4>
                <div className="text-xs text-[#94A3B8]">
                  {selectedMarket.region} · {selectedMarket.settlementType} · {selectedMarket.sellerFeePct}% Seller Fee
                </div>
                <div className="border-t border-[#1F2937] pt-3 font-mono text-xs tabular-nums text-[#CBD5E1]">
                  Verified SOLD_ON edges indexed:{' '}
                  {
                    state.sales.filter(
                      (s) =>
                        s.status === 'VERIFIED' &&
                        s.marketplaceId === selectedMarket.id
                    ).length
                  }
                </div>
              </div>
            )}

            {!selectedAsset && !selectedEvent && !selectedMarket && (
              <p className="text-xs text-[#94A3B8]">
                Select any node in the topology canvas to inspect its edges.
              </p>
            )}
          </div>
        </div>
      </section>

      {/* Hierarchical GraphRAG Community Summaries */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Hierarchical GraphRAG Community Summaries
            </h3>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Pre-aggregated market cluster syntheses enabling instant macro market reasoning without scanning raw transaction rows.
            </p>
          </div>
        </div>

        {communityError && (
          <div className="rounded-md border border-red-500/40 bg-red-950/35 px-3.5 py-2 text-xs text-red-200">
            {communityError}
          </div>
        )}

        {state.communities.length === 0 ? (
          <div className="rounded-lg border border-[#1F2937] bg-[#11161D] p-6 text-xs text-[#94A3B8]">
            Community clusters generate automatically once you register TCG or Sports collectibles.
          </div>
        ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {state.communities.map((com) => (
            <div
              key={com.id}
              className="flex flex-col justify-between rounded-lg border border-[#1F2937] bg-[#11161D] p-5"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-[#F1F5F9]">
                      {com.title}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#94A3B8]">
                      {com.eraLabel}
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={refreshingCommunityId !== null}
                    onClick={() => handleRefreshCommunity(com.id)}
                    title="Re-synthesize with active server LLM"
                    className="rounded border border-[#243040] bg-[#161D27] p-1.5 text-[#94A3B8] transition-colors hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-40"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${
                        refreshingCommunityId === com.id ? 'animate-spin' : ''
                      }`}
                    />
                  </button>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2 border-y border-[#1F2937] py-3 font-mono text-xs tabular-nums">
                  <div>
                    <div className="font-sans text-[11px] text-[#94A3B8]">30d Avg</div>
                    <div className="mt-0.5 font-semibold text-emerald-400">
                      {formatPct(com.deterministicStats.avg30dChangePct)}
                    </div>
                  </div>
                  <div>
                    <div className="font-sans text-[11px] text-[#94A3B8]">10/9 Ratio</div>
                    <div className="mt-0.5 font-semibold text-amber-400">
                      {com.deterministicStats.avgGradeMultiplier.toFixed(2)}x
                    </div>
                  </div>
                  <div>
                    <div className="font-sans text-[11px] text-[#94A3B8]">Volume</div>
                    <div className="mt-0.5 font-semibold text-[#F1F5F9]">
                      {formatCompactUsd(com.deterministicStats.totalVerifiedVolumeUsd)}
                    </div>
                  </div>
                </div>

                <p className="mt-3 text-xs leading-relaxed text-[#CBD5E1]">
                  {com.narrative}
                </p>
              </div>

              <div className="mt-4 flex items-center justify-between text-[11px] text-[#64748B]">
                <span>{com.deterministicStats.assetCount} canonical assets</span>
                <span>{com.providerUsed}</span>
              </div>
            </div>
          ))}
        </div>
        )}
      </section>
    </div>
  );
}
