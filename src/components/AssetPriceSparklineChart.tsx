import { useMemo, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { TrendingDown, TrendingUp } from 'lucide-react';
import type {
  AssetValuation,
  ListingSaleNode,
  MarketEventNode,
  MarketplaceNode,
} from '../types/graph.ts';
import { formatCompactUsd, formatPct, formatUsd } from '../utils/visualAssets.ts';

type SeriesMode = 'TOP_GRADE' | 'MID_GRADE' | 'RAW' | 'VERIFIED_SALES';
type DensityMode = 'CHART' | 'SPARKLINE';

interface AssetPriceSparklineChartProps {
  valuation: AssetValuation;
  sales: ListingSaleNode[];
  events: MarketEventNode[];
  marketplaces: MarketplaceNode[];
}

interface ChartDatum {
  date: string;
  price: number;
  secondaryPrice?: number;
  eventTitle?: string;
  venueName?: string;
  gradeLabel?: string;
  saleId?: string;
}

const SERIES_META: Record<
  SeriesMode,
  { stroke: string; gradientId: string; accentText: string }
> = {
  TOP_GRADE: {
    stroke: '#10B981',
    gradientId: 'slabGradTop',
    accentText: 'text-emerald-400',
  },
  MID_GRADE: {
    stroke: '#F59E0B',
    gradientId: 'slabGradMid',
    accentText: 'text-amber-400',
  },
  RAW: {
    stroke: '#38BDF8',
    gradientId: 'slabGradRaw',
    accentText: 'text-sky-400',
  },
  VERIFIED_SALES: {
    stroke: '#10B981',
    gradientId: 'slabGradSales',
    accentText: 'text-emerald-400',
  },
};

export function AssetPriceSparklineChart({
  valuation,
  sales,
  events,
  marketplaces,
}: AssetPriceSparklineChartProps) {
  const [seriesMode, setSeriesMode] = useState<SeriesMode>('TOP_GRADE');
  const [densityMode, setDensityMode] = useState<DensityMode>('CHART');

  const marketplaceMap = useMemo(
    () => new Map(marketplaces.map((m) => [m.id, m.name])),
    [marketplaces]
  );

  const verifiedSales = useMemo(
    () =>
      sales
        .filter((s) => s.status === 'VERIFIED')
        .sort((a, b) => a.date.localeCompare(b.date)),
    [sales]
  );

  const chartData = useMemo<ChartDatum[]>(() => {
    if (seriesMode === 'VERIFIED_SALES') {
      return verifiedSales.map((s) => ({
        date: s.date.slice(5), // MM-DD for crisp axis labels
        price: s.priceUsd,
        venueName: marketplaceMap.get(s.marketplaceId) || s.marketplaceId,
        gradeLabel: s.grade,
        saleId: s.id,
      }));
    }

    return valuation.history.map((pt) => ({
      date: pt.date,
      price:
        seriesMode === 'TOP_GRADE'
          ? pt.psa10
          : seriesMode === 'MID_GRADE'
            ? pt.psa9
            : pt.raw,
      eventTitle: pt.eventTitle,
    }));
  }, [seriesMode, verifiedSales, valuation.history, marketplaceMap]);

  const stats = useMemo(() => {
    if (chartData.length === 0) {
      return { low: 0, high: 0, first: 0, last: 0, deltaPct: 0 };
    }
    const prices = chartData.map((d) => d.price);
    const low = Math.min(...prices);
    const high = Math.max(...prices);
    const first = prices[0];
    const last = prices[prices.length - 1];
    const deltaPct = first > 0 ? ((last - first) / first) * 100 : 0;
    return { low, high, first, last, deltaPct };
  }, [chartData]);

  const catalystPoints = useMemo(
    () => chartData.filter((d) => Boolean(d.eventTitle)),
    [chartData]
  );

  const seriesMeta = SERIES_META[seriesMode];
  const isPositive = stats.deltaPct >= 0;
  const activeStroke =
    seriesMode === 'TOP_GRADE' || seriesMode === 'VERIFIED_SALES'
      ? isPositive
        ? '#10B981'
        : '#EF4444'
      : seriesMeta.stroke;

  const seriesLabel =
    seriesMode === 'TOP_GRADE'
      ? valuation.topGradeLabel
      : seriesMode === 'MID_GRADE'
        ? 'PSA 9'
        : seriesMode === 'RAW'
          ? 'Raw NM'
          : 'Verified SOLD_ON Comps';

  return (
    <section className="border-t border-[#1F2937] pt-5">
      {/* Header & Controls */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Historical Price Trend
            </h3>
            <span className="font-mono text-[11px] text-[#64748B]">
              · {seriesLabel}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2.5 font-mono text-[11px] tabular-nums text-[#94A3B8]">
            <span
              className={`inline-flex items-center gap-1 font-medium ${
                isPositive ? 'text-emerald-400' : 'text-red-400'
              }`}
            >
              {isPositive ? (
                <TrendingUp className="h-3 w-3" />
              ) : (
                <TrendingDown className="h-3 w-3" />
              )}
              <span>{formatPct(stats.deltaPct)} period</span>
            </span>
            <span aria-hidden="true">·</span>
            <span>Low {formatUsd(stats.low)}</span>
            <span aria-hidden="true">·</span>
            <span>High {formatUsd(stats.high)}</span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Grade / Source Series Switcher */}
          <div
            role="tablist"
            aria-label="Price History Series"
            className="inline-flex items-center rounded border border-[#1F2937] bg-[#11161D] p-0.5"
          >
            {(
              [
                { id: 'TOP_GRADE', label: valuation.topGradeLabel },
                { id: 'MID_GRADE', label: 'PSA 9' },
                { id: 'RAW', label: 'Raw' },
                { id: 'VERIFIED_SALES', label: 'Comps' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.id}
                type="button"
                role="tab"
                aria-selected={seriesMode === opt.id}
                onClick={() => setSeriesMode(opt.id)}
                className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                  seriesMode === opt.id
                    ? 'bg-[#161D27] text-emerald-400'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* Detailed Chart vs Compact Sparkline Toggle */}
          <div
            role="group"
            aria-label="Chart Density"
            className="inline-flex items-center rounded border border-[#1F2937] bg-[#11161D] p-0.5"
          >
            <button
              type="button"
              onClick={() => setDensityMode('CHART')}
              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                densityMode === 'CHART'
                  ? 'bg-[#161D27] text-[#F1F5F9]'
                  : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              Chart
            </button>
            <button
              type="button"
              onClick={() => setDensityMode('SPARKLINE')}
              className={`rounded px-2 py-1 text-[11px] font-medium transition-colors whitespace-nowrap shrink-0 ${
                densityMode === 'SPARKLINE'
                  ? 'bg-[#161D27] text-[#F1F5F9]'
                  : 'text-[#94A3B8] hover:text-[#F1F5F9]'
              }`}
            >
              Sparkline
            </button>
          </div>
        </div>
      </div>

      {/* Visualization Surface */}
      <div className="mt-3 rounded-lg border border-[#1F2937] bg-[#11161D] p-3">
        {chartData.length === 0 ? (
          <div className="flex h-32 items-center justify-center text-xs text-[#94A3B8]">
            No verified historical price points recorded for this series yet.
          </div>
        ) : densityMode === 'SPARKLINE' ? (
          <div className="space-y-2">
            <div className="h-24 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={chartData}
                  margin={{ top: 6, right: 6, left: 6, bottom: 2 }}
                >
                  <defs>
                    <linearGradient
                      id={`${seriesMeta.gradientId}-spark`}
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="5%" stopColor={activeStroke} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={activeStroke} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Tooltip
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const pt = payload[0].payload as ChartDatum;
                      return (
                        <div className="rounded border border-[#243040] bg-[#0D1117] px-2.5 py-1.5 text-[11px] text-[#F1F5F9]">
                          <div className="font-mono text-[#94A3B8]">{pt.date}</div>
                          <div className="mt-0.5 font-mono font-semibold tabular-nums text-emerald-400">
                            {formatUsd(pt.price)}
                          </div>
                          {pt.venueName && (
                            <div className="text-[10px] text-[#CBD5E1]">
                              {pt.venueName} · {pt.gradeLabel}
                            </div>
                          )}
                          {pt.eventTitle && (
                            <div className="mt-0.5 text-[10px] text-amber-400">
                              Catalyst: {pt.eventTitle}
                            </div>
                          )}
                        </div>
                      );
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke={activeStroke}
                    strokeWidth={2}
                    fill={`url(#${seriesMeta.gradientId}-spark)`}
                    dot={seriesMode === 'VERIFIED_SALES' ? { r: 2.5, fill: activeStroke } : false}
                    activeDot={{ r: 4, fill: activeStroke, stroke: '#0D1117', strokeWidth: 1.5 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="flex items-center justify-between border-t border-[#1F2937] pt-2 font-mono text-[11px] tabular-nums text-[#94A3B8]">
              <span>
                Start {chartData[0].date}: {formatUsd(stats.first)}
              </span>
              <span>
                Latest {chartData[chartData.length - 1].date}:{' '}
                <span className="text-[#F1F5F9]">{formatUsd(stats.last)}</span>
              </span>
            </div>
          </div>
        ) : (
          <div className="h-52 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartData}
                margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
              >
                <defs>
                  <linearGradient id={seriesMeta.gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={activeStroke} stopOpacity={0.26} />
                    <stop offset="95%" stopColor={activeStroke} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1F2937" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  stroke="#64748B"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#64748B"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  domain={['auto', 'auto']}
                  tickFormatter={(v) => formatCompactUsd(Number(v))}
                  width={56}
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const pt = payload[0].payload as ChartDatum;
                    return (
                      <div className="max-w-[240px] rounded-md border border-[#243040] bg-[#0D1117] px-3 py-2 text-xs text-[#F1F5F9]">
                        <div className="flex items-center justify-between gap-3">
                          <span className="font-mono text-[11px] text-[#94A3B8]">
                            {pt.date}
                          </span>
                          <span className="font-mono font-semibold tabular-nums text-[#F1F5F9]">
                            {formatUsd(pt.price)}
                          </span>
                        </div>
                        {pt.venueName && (
                          <div className="mt-1 text-[11px] text-[#CBD5E1]">
                            {pt.venueName} · {pt.gradeLabel}
                          </div>
                        )}
                        {pt.saleId && (
                          <div className="font-mono text-[10px] text-[#64748B]">
                            Edge {pt.saleId}
                          </div>
                        )}
                        {pt.eventTitle && (
                          <div className="mt-1.5 border-t border-[#1F2937] pt-1 text-[11px] text-amber-400">
                            MarketEvent: {pt.eventTitle}
                          </div>
                        )}
                      </div>
                    );
                  }}
                />
                {seriesMode === 'TOP_GRADE' && valuation.movingAvg30d > 0 && (
                  <ReferenceLine
                    y={valuation.movingAvg30d}
                    stroke="#475569"
                    strokeDasharray="4 4"
                    label={{
                      value: '30d MA',
                      position: 'insideTopRight',
                      fill: '#64748B',
                      fontSize: 10,
                    }}
                  />
                )}
                {catalystPoints.map((pt) => (
                  <ReferenceLine
                    key={pt.date}
                    x={pt.date}
                    stroke="#F59E0B"
                    strokeOpacity={0.55}
                    strokeDasharray="3 3"
                  />
                ))}
                <Area
                  type="monotone"
                  dataKey="price"
                  stroke={activeStroke}
                  strokeWidth={2}
                  fill={`url(#${seriesMeta.gradientId})`}
                  dot={
                    seriesMode === 'VERIFIED_SALES'
                      ? { r: 3, fill: activeStroke, stroke: '#0D1117', strokeWidth: 1 }
                      : false
                  }
                  activeDot={{
                    r: 4.5,
                    fill: activeStroke,
                    stroke: '#0D1117',
                    strokeWidth: 1.5,
                  }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Deterministic Moving Averages & Graph Provenance Footer */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#1F2937] pt-2.5 font-mono text-[11px] tabular-nums text-[#94A3B8]">
          <span>
            7d MA {formatUsd(valuation.movingAvg7d)} · 30d MA {formatUsd(valuation.movingAvg30d)} · 90d MA{' '}
            {formatUsd(valuation.movingAvg90d)}
          </span>
          <span className="text-[#64748B]">
            {verifiedSales.length} verified comps · {events.length} event catalyst
            {events.length === 1 ? '' : 's'}
          </span>
        </div>
      </div>
    </section>
  );
}
