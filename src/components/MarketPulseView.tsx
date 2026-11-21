import { useMemo, useState } from 'react';
import {
  ArrowDownUp,
  ChevronRight,
  Plus,
  Search,
} from 'lucide-react';
import type {
  AssetNode,
  GraphStatePayload,
  MarketSegment,
} from '../types/graph.ts';
import {
  VISUAL_THEME_IMAGES,
  formatPct,
  formatUsd,
} from '../utils/visualAssets.ts';

interface MarketPulseViewProps {
  state: GraphStatePayload;
  segmentFilter: MarketSegment | 'ALL';
  franchiseFilter: string;
  onSegmentChange: (seg: MarketSegment | 'ALL') => void;
  onFranchiseChange: (franchise: string) => void;
  onSelectAsset: (assetId: string) => void;
  onOpenAddAsset: () => void;
  onOpenSetupGuide: () => void;
  onNavigateTab: (tab: 'swarm' | 'graphrag' | 'arbitrage') => void;
}

type SortKey = 'topGradeAvg' | 'gradeMultiplier' | 'change30dPct' | 'bestArbSpreadPct' | 'topGradePop';

export function MarketPulseView({
  state,
  segmentFilter,
  franchiseFilter,
  onSegmentChange,
  onFranchiseChange,
  onSelectAsset,
  onOpenAddAsset,
  onOpenSetupGuide,
  onNavigateTab,
}: MarketPulseViewProps) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('topGradeAvg');
  const [sortDesc, setSortDesc] = useState(true);

  const availableFranchises = useMemo(() => {
    const scoped = state.assets.filter(
      (a) => segmentFilter === 'ALL' || a.segment === segmentFilter
    );
    return Array.from(new Set(scoped.map((a) => a.franchise))).sort();
  }, [state.assets, segmentFilter]);

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = state.assets.filter((a) => {
      if (segmentFilter !== 'ALL' && a.segment !== segmentFilter) return false;
      if (franchiseFilter !== 'ALL' && a.franchise !== franchiseFilter) return false;
      if (!q) return true;
      return (
        a.title.toLowerCase().includes(q) ||
        a.franchise.toLowerCase().includes(q) ||
        a.setName.toLowerCase().includes(q) ||
        a.id.toLowerCase().includes(q) ||
        a.subjectName.toLowerCase().includes(q)
      );
    });

    return [...list].sort((a, b) => {
      const va = state.valuations[a.id]?.[sortKey] ?? 0;
      const vb = state.valuations[b.id]?.[sortKey] ?? 0;
      return sortDesc ? vb - va : va - vb;
    });
  }, [state.assets, state.valuations, segmentFilter, franchiseFilter, search, sortKey, sortDesc]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDesc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortDesc(true);
    }
  }

  return (
    <div className="space-y-6">
      {/* Deterministic KPI Strip */}
      <section className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[#1F2937] bg-[#1F2937] sm:grid-cols-2 xl:grid-cols-4">
        <div className="bg-[#11161D] p-5">
          <div className="text-xs font-medium text-[#94A3B8]">
            Canonical Assets Tracked
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold tabular-nums text-[#F1F5F9]">
              {state.kpis.canonicalAssets}
            </span>
            <span className="text-xs text-[#94A3B8]">
              {state.kpis.trackedFranchises.length} franchises & sports
            </span>
          </div>
        </div>

        <div className="bg-[#11161D] p-5">
          <div className="text-xs font-medium text-[#94A3B8]">
            Verified Sold Comps
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold tabular-nums text-[#F1F5F9]">
              {state.kpis.verifiedSales}
            </span>
            <span className="text-xs text-emerald-400">
              {state.marketplaces.length} venues indexed
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => onNavigateTab('arbitrage')}
          className="bg-[#11161D] p-5 text-left transition-colors hover:bg-[#161D27]"
        >
          <div className="text-xs font-medium text-[#94A3B8]">
            Active Arbitrage Spreads
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold tabular-nums text-emerald-400">
              {state.kpis.activeArbitrageCount}
            </span>
            <span className="font-mono text-xs tabular-nums text-[#CBD5E1]">
              Peak +{state.kpis.topArbitrageSpreadPct.toFixed(1)}% net
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigateTab('swarm')}
          className="bg-[#11161D] p-5 text-left transition-colors hover:bg-[#161D27]"
        >
          <div className="text-xs font-medium text-[#94A3B8]">
            Quarantined Outliers
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="font-mono text-2xl font-semibold tabular-nums text-amber-400">
              {state.kpis.quarantinedOutliers}
            </span>
            <span className="text-xs text-[#94A3B8]">
              Excluded from averages
            </span>
          </div>
        </button>
      </section>

      {/* Toolbar: Segment + Dynamic Franchise Filter + Search + Add Canonical Asset */}
      <section className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-md border border-[#1F2937] bg-[#11161D] p-0.5">
            {(
              [
                { id: 'ALL', label: 'All Collectibles' },
                { id: 'TCG', label: 'Trading Card Games' },
                { id: 'SPORTS', label: 'Sports Collectibles' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() => {
                  onSegmentChange(opt.id);
                  onFranchiseChange('ALL');
                }}
                className={`rounded px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 ${
                  segmentFilter === opt.id
                    ? 'bg-[#1F2937] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:text-[#E2E8F0]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <select
            aria-label="Filter by franchise or sport"
            value={franchiseFilter}
            onChange={(e) => onFranchiseChange(e.target.value)}
            className="rounded-md border border-[#1F2937] bg-[#11161D] px-3 py-1.5 text-xs text-[#E2E8F0] focus:border-emerald-500 focus:outline-none"
          >
            <option value="ALL">All Franchises & Sports ({availableFranchises.length})</option>
            {availableFranchises.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:w-64 sm:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#64748B]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search title, franchise, set, or ID..."
              className="w-full rounded-md border border-[#1F2937] bg-[#11161D] py-1.5 pl-8 pr-3 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={onOpenAddAsset}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-[#E2E8F0] transition-colors hover:border-emerald-500/50 hover:text-emerald-300 whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Register Asset</span>
          </button>
        </div>
      </section>

      {/* Watchlist Valuation Matrix */}
      <section className="overflow-hidden rounded-lg border border-[#1F2937] bg-[#11161D]">
        <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-3.5">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              Canonical Valuation Watchlist
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Exact deterministic averages, medians, and grade multipliers computed strictly inside the Knowledge Graph.
            </p>
          </div>
          <span className="font-mono text-xs tabular-nums text-[#94A3B8]">
            {filteredAssets.length} of {state.assets.length} assets
          </span>
        </div>

        {state.assets.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-semibold text-[#F1F5F9]">
              Your self-hosted Knowledge Graph is clean — zero mock data loaded.
            </p>
            <p className="mx-auto mt-1.5 max-w-lg text-xs leading-relaxed text-[#94A3B8]">
              Use the 4-step Setup Guide to register real collectibles, import a JSON catalog, configure Discord/Telegram/Hermes webhooks, and build your semantic vector index.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
              <button
                type="button"
                onClick={onOpenSetupGuide}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 whitespace-nowrap shrink-0"
              >
                <span>Open Setup Guide</span>
              </button>
              <button
                type="button"
                onClick={onOpenAddAsset}
                className="inline-flex items-center gap-1.5 rounded-md border border-[#243040] bg-[#161D27] px-3.5 py-2 text-xs font-medium text-[#E2E8F0] hover:border-emerald-500/50 hover:text-emerald-300 whitespace-nowrap shrink-0"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>Register Collectible</span>
              </button>
            </div>
          </div>
        ) : filteredAssets.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-[#E2E8F0]">
              No collectibles match the current filter.
            </p>
            <p className="mt-1 text-xs text-[#94A3B8]">
              Clear your search filter or register a new canonical TCG or sports collectible node.
            </p>
            <button
              type="button"
              onClick={onOpenAddAsset}
              className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-500"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Register Canonical Asset</span>
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#1F2937] bg-[#0D1117] text-[#94A3B8]">
                  <th className="px-4 py-3 font-medium">Canonical Asset</th>
                  <th className="px-3 py-3 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort('topGradeAvg')}
                      className="inline-flex items-center gap-1 hover:text-[#F1F5F9]"
                    >
                      <span>Top Grade Mean</span>
                      <ArrowDownUp className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="px-3 py-3 text-right font-medium">PSA 9 / Raw</th>
                  <th className="px-3 py-3 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort('gradeMultiplier')}
                      className="inline-flex items-center gap-1 hover:text-[#F1F5F9]"
                    >
                      <span>10/9 Ratio</span>
                      <ArrowDownUp className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="px-3 py-3 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort('topGradePop')}
                      className="inline-flex items-center gap-1 hover:text-[#F1F5F9]"
                    >
                      <span>Top Pop</span>
                      <ArrowDownUp className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="px-3 py-3 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort('change30dPct')}
                      className="inline-flex items-center gap-1 hover:text-[#F1F5F9]"
                    >
                      <span>30d Trend</span>
                      <ArrowDownUp className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="px-3 py-3 text-right font-medium">
                    <button
                      type="button"
                      onClick={() => toggleSort('bestArbSpreadPct')}
                      className="inline-flex items-center gap-1 hover:text-[#F1F5F9]"
                    >
                      <span>Net Arb Edge</span>
                      <ArrowDownUp className="h-3 w-3" />
                    </button>
                  </th>
                  <th className="w-8 px-3 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1F2937]">
                {filteredAssets.map((asset: AssetNode) => {
                  const v = state.valuations[asset.id];
                  if (!v) return null;
                  return (
                    <tr
                      key={asset.id}
                      onClick={() => onSelectAsset(asset.id)}
                      className="cursor-pointer transition-colors hover:bg-[#161D27]"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <img
                            src={VISUAL_THEME_IMAGES[asset.visualTheme]}
                            alt={asset.title}
                            referrerPolicy="no-referrer"
                            className="h-10 w-8 rounded border border-[#243040] object-cover shrink-0"
                          />
                          <div className="min-w-0">
                            <div className="truncate font-medium text-[#F1F5F9]">
                              {asset.title}
                            </div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[#94A3B8]">
                              <span>{asset.franchise}</span>
                              <span aria-hidden="true">·</span>
                              <span>{asset.setName}</span>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono text-[#64748B]">{asset.id}</span>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right whitespace-nowrap">
                        <div className="font-mono font-semibold tabular-nums text-[#F1F5F9]">
                          {formatUsd(v.topGradeAvg)}
                        </div>
                        <div className="font-mono text-[11px] text-[#64748B]">
                          {v.topGradeLabel}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums whitespace-nowrap">
                        <div className="text-[#CBD5E1]">{formatUsd(v.midGradeAvg)}</div>
                        <div className="text-[11px] text-[#64748B]">
                          Raw {formatUsd(v.rawAvg)}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono font-medium tabular-nums text-amber-400 whitespace-nowrap">
                        {v.gradeMultiplier > 0 ? `${v.gradeMultiplier.toFixed(2)}x` : '—'}
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums text-[#CBD5E1] whitespace-nowrap">
                        {v.topGradePop.toLocaleString()}
                      </td>
                      <td
                        className={`px-3 py-3 text-right font-mono font-medium tabular-nums whitespace-nowrap ${
                          v.change30dPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                        }`}
                      >
                        {formatPct(v.change30dPct)}
                      </td>
                      <td className="px-3 py-3 text-right font-mono tabular-nums whitespace-nowrap">
                        {v.bestArbSpreadPct > 0 ? (
                          <span className="font-medium text-emerald-400">
                            +{v.bestArbSpreadPct.toFixed(1)}%
                          </span>
                        ) : (
                          <span className="text-[#64748B]">Balanced</span>
                        )}
                      </td>
                      <td className="px-3 py-3 text-right text-[#64748B]">
                        <ChevronRight className="h-4 w-4" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Bottom Split: Active Market Catalysts & Recent High-Priority Alerts */}
      <section className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-[#1F2937] bg-[#11161D]">
          <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-3.5">
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Active Market Catalyst Nodes
            </h3>
            <button
              type="button"
              onClick={() => onNavigateTab('graphrag')}
              className="text-xs font-medium text-emerald-400 hover:text-emerald-300"
            >
              Explore GraphRAG
            </button>
          </div>
          <div className="divide-y divide-[#1F2937]">
            {state.events.length === 0 ? (
              <div className="px-5 py-6 text-xs text-[#94A3B8]">
                No MarketEvent catalysts ingested yet. Submit a tournament, reprint, or sports milestone in Layer 1 Swarm Studio.
              </div>
            ) : (
              state.events.slice(0, 4).map((ev) => (
                <div key={ev.id} className="px-5 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-medium text-[#F1F5F9]">
                        {ev.title}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[#94A3B8]">
                        {ev.category} · {ev.date} · {ev.impactedAssetIds.length} impacted node(s)
                      </div>
                    </div>
                    <span className="font-mono text-xs font-medium tabular-nums text-amber-400 shrink-0">
                      {formatPct(ev.priceDeltaPct)}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-lg border border-[#1F2937] bg-[#11161D]">
          <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-3.5">
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Top Deterministic Arbitrage & Outlier Alerts
            </h3>
            <button
              type="button"
              onClick={() => onNavigateTab('arbitrage')}
              className="text-xs font-medium text-emerald-400 hover:text-emerald-300"
            >
              Open Alert Swarm
            </button>
          </div>
          <div className="divide-y divide-[#1F2937]">
            {state.triggeredAlerts.length === 0 ? (
              <div className="px-5 py-6 text-xs text-[#94A3B8]">
                No alerts triggered yet. Alerts fire deterministically once verified multi-venue comps or quarantined outliers hit your active rules.
              </div>
            ) : (
              state.triggeredAlerts.slice(0, 4).map((al) => (
                <div key={al.id} className="px-5 py-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-xs font-medium text-[#F1F5F9]">
                        {al.headline}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[#94A3B8]">
                        {al.channel} · {al.ruleName}
                      </div>
                    </div>
                    <span
                      className={`font-mono text-[11px] font-medium shrink-0 ${
                        al.severity === 'CRITICAL'
                          ? 'text-red-400'
                          : al.severity === 'HIGH'
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                      }`}
                    >
                      {al.severity}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
