import { useState } from 'react';
import {
  AlertTriangle,
  ArrowUpRight,
  Calendar,
  Layers,
  ShieldCheck,
  X,
} from 'lucide-react';
import { AssetPriceSparklineChart } from './AssetPriceSparklineChart.tsx';
import type {
  AssetNode,
  AssetValuation,
  ListingSaleNode,
  MarketEventNode,
  MarketplaceNode,
} from '../types/graph.ts';
import {
  VISUAL_THEME_IMAGES,
  formatPct,
  formatUsd,
} from '../utils/visualAssets.ts';

interface AssetDetailDrawerProps {
  asset: AssetNode | null;
  valuation: AssetValuation | null;
  sales: ListingSaleNode[];
  events: MarketEventNode[];
  marketplaces: MarketplaceNode[];
  onClose: () => void;
  onInspectInGraph: (assetId: string) => void;
}

export function AssetDetailDrawer({
  asset,
  valuation,
  sales,
  events,
  marketplaces,
  onClose,
  onInspectInGraph,
}: AssetDetailDrawerProps) {
  const [imgFailed, setImgFailed] = useState(false);

  if (!asset || !valuation) return null;

  const marketplaceMap = new Map(marketplaces.map((m) => [m.id, m.name]));
  const assetSales = sales.filter((s) => s.assetId === asset.id);
  const assetEvents = events.filter((e) => e.impactedAssetIds.includes(asset.id));

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/65 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <aside
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-[#1F2937] bg-[#0D1117] text-[#F1F5F9]"
        onClick={(e) => e.stopPropagation()}
        aria-label={`${asset.title} intelligence drawer`}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-[#1F2937] bg-[#0D1117]/95 px-6 py-4 backdrop-blur-sm">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-xs text-[#94A3B8]">
              <span>{asset.segment === 'SPORTS' ? 'Sports Collectibles' : 'Trading Card Games'}</span>
              <span aria-hidden="true">/</span>
              <span>{asset.franchise}</span>
              <span aria-hidden="true">/</span>
              <span className="font-mono text-[#CBD5E1]">{asset.id}</span>
            </div>
            <h2 className="mt-1 truncate text-lg font-semibold text-[#F1F5F9]">
              {asset.title}
            </h2>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onInspectInGraph(asset.id)}
              className="inline-flex items-center gap-1.5 rounded-md border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-[#E2E8F0] transition-colors hover:border-emerald-500/50 hover:text-emerald-300 whitespace-nowrap shrink-0"
            >
              <span>Inspect Graph</span>
              <ArrowUpRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close detail drawer"
              className="rounded-md p-2 text-[#94A3B8] transition-colors hover:bg-[#161D27] hover:text-[#F1F5F9]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-6 p-6">
          {/* Header Split: Graded Slab Visual + Canonical Ontology Specs */}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-[152px_1fr]">
            <div className="aspect-[3/4] overflow-hidden rounded-lg border border-[#1F2937] bg-[#11161D]">
              {!imgFailed ? (
                <img
                  src={VISUAL_THEME_IMAGES[asset.visualTheme]}
                  alt={`${asset.title} graded archival slab`}
                  referrerPolicy="no-referrer"
                  onError={() => setImgFailed(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center bg-gradient-to-br from-[#11161D] to-[#1A2433] p-4 text-center">
                  <Layers className="h-6 w-6 text-emerald-400" />
                  <span className="mt-2 text-xs font-medium text-[#CBD5E1]">
                    {asset.title}
                  </span>
                  <span className="mt-1 font-mono text-[11px] text-[#94A3B8]">
                    {asset.cardNumber}
                  </span>
                </div>
              )}
            </div>

            <div className="flex flex-col justify-between space-y-4">
              <div>
                <p className="text-sm text-[#94A3B8]">
                  {asset.setName} · {asset.releaseYear} · {asset.cardNumber} · {asset.variant}
                </p>
                <div className="mt-3 grid grid-cols-2 gap-3 border-t border-[#1F2937] pt-3">
                  <div>
                    <div className="text-xs text-[#94A3B8]">{valuation.topGradeLabel} Mean</div>
                    <div className="mt-0.5 font-mono text-2xl font-semibold tabular-nums text-[#F1F5F9]">
                      {formatUsd(valuation.topGradeAvg)}
                    </div>
                    <div
                      className={`mt-0.5 font-mono text-xs tabular-nums ${
                        valuation.change30dPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                      }`}
                    >
                      {formatPct(valuation.change30dPct)} (30d)
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-[#94A3B8]">Top-to-PSA 9 Multiplier</div>
                    <div className="mt-0.5 font-mono text-2xl font-semibold tabular-nums text-amber-400">
                      {valuation.gradeMultiplier.toFixed(2)}x
                    </div>
                    <div className="mt-0.5 font-mono text-xs tabular-nums text-[#94A3B8]">
                      Pop {valuation.topGradePop.toLocaleString()} · {valuation.gemRatePct}% gem
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 border-t border-[#1F2937] pt-3 text-xs">
                <div>
                  <span className="text-[#94A3B8]">PSA 9 Mean</span>
                  <div className="mt-0.5 font-mono font-medium tabular-nums text-[#E2E8F0]">
                    {formatUsd(valuation.midGradeAvg)}
                  </div>
                </div>
                <div>
                  <span className="text-[#94A3B8]">Raw NM Mean</span>
                  <div className="mt-0.5 font-mono font-medium tabular-nums text-[#E2E8F0]">
                    {formatUsd(valuation.rawAvg)}
                  </div>
                </div>
                <div>
                  <span className="text-[#94A3B8]">Best Net Arb</span>
                  <div className="mt-0.5 font-mono font-medium tabular-nums text-emerald-400">
                    {valuation.bestArbSpreadPct > 0
                      ? `+${valuation.bestArbSpreadPct.toFixed(1)}%`
                      : 'Balanced'}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Historical Price Trend & Sparkline Component */}
          <AssetPriceSparklineChart
            valuation={valuation}
            sales={assetSales}
            events={assetEvents}
            marketplaces={marketplaces}
          />

          {/* Linked Market_Event Catalyst Nodes */}
          <section className="border-t border-[#1F2937] pt-5">
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Impacting Market Events ({assetEvents.length})
            </h3>
            {assetEvents.length === 0 ? (
              <p className="mt-2 text-xs text-[#94A3B8]">
                No catalyst event edges currently link to this canonical asset.
              </p>
            ) : (
              <div className="mt-3 divide-y divide-[#1F2937] rounded-lg border border-[#1F2937] bg-[#11161D]">
                {assetEvents.map((ev) => (
                  <div key={ev.id} className="p-3.5">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-sm font-medium text-[#F1F5F9]">
                          {ev.title}
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-xs text-[#94A3B8]">
                          <Calendar className="h-3 w-3" />
                          <span>{ev.date}</span>
                          <span aria-hidden="true">·</span>
                          <span>{ev.category}</span>
                          <span aria-hidden="true">·</span>
                          <span>{ev.windowDays}d impact window</span>
                        </div>
                      </div>
                      <span
                        className={`font-mono text-xs font-medium tabular-nums shrink-0 ${
                          ev.priceDeltaPct >= 0 ? 'text-amber-400' : 'text-red-400'
                        }`}
                      >
                        {formatPct(ev.priceDeltaPct)}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-relaxed text-[#CBD5E1]">
                      {ev.summary}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* SOLD_ON Edge Ledger (Verified vs Quarantined) */}
          <section className="border-t border-[#1F2937] pt-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#F1F5F9]">
                Marketplace Comps Ledger ({assetSales.length} edges)
              </h3>
              <span className="text-xs text-[#94A3B8]">
                {valuation.verifiedSaleCount} verified · {valuation.quarantinedCount} quarantined
              </span>
            </div>
            <div className="mt-3 overflow-x-auto rounded-lg border border-[#1F2937] bg-[#11161D]">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-[#1F2937] text-[#94A3B8]">
                    <th className="px-3 py-2.5 font-medium">Date</th>
                    <th className="px-3 py-2.5 font-medium">Venue & Grade</th>
                    <th className="px-3 py-2.5 font-medium">Audit Status</th>
                    <th className="px-3 py-2.5 text-right font-medium">Realized</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1F2937]">
                  {assetSales.map((s) => (
                    <tr key={s.id} className="hover:bg-[#161D27]/70">
                      <td className="px-3 py-2.5 font-mono tabular-nums text-[#94A3B8] whitespace-nowrap">
                        {s.date}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="text-[#E2E8F0]">
                          {marketplaceMap.get(s.marketplaceId) || s.marketplaceId} · {s.grade}
                        </div>
                        <div className="mt-0.5 max-w-xs truncate text-[11px] text-[#64748B]">
                          {s.rawTitle}
                        </div>
                        {s.outlierReason && (
                          <div className="mt-1 text-[11px] text-red-400">
                            Reason: {s.outlierReason}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">
                        {s.status === 'VERIFIED' ? (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <ShieldCheck className="h-3.5 w-3.5" />
                            <span>Verified</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-400">
                            <AlertTriangle className="h-3.5 w-3.5" />
                            <span>Quarantined</span>
                          </span>
                        )}
                      </td>
                      <td
                        className={`px-3 py-2.5 text-right font-mono font-medium tabular-nums whitespace-nowrap ${
                          s.status === 'QUARANTINED'
                            ? 'text-[#64748B] line-through'
                            : 'text-[#F1F5F9]'
                        }`}
                      >
                        {formatUsd(s.priceUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}
