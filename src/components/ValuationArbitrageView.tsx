import { useMemo, useState, type FormEvent } from 'react';
import {
  Bell,
  Code2,
  Plus,
  Send,
  Trash2,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type {
  AlertRule,
  GraphStatePayload,
  MarketSegment,
  TriggeredAlert,
} from '../types/graph.ts';
import { apiFetch } from '../utils/apiClient.ts';
import { formatTimeShort, formatUsd } from '../utils/visualAssets.ts';

interface ValuationArbitrageViewProps {
  state: GraphStatePayload;
  segmentFilter: MarketSegment | 'ALL';
  includeFees: boolean;
  onToggleIncludeFees: (include: boolean) => void;
  onSelectAsset: (assetId: string) => void;
  onRefreshState: (nextState: GraphStatePayload) => void;
}

export function ValuationArbitrageView({
  state,
  segmentFilter,
  includeFees,
  onToggleIncludeFees,
  onSelectAsset,
  onRefreshState,
}: ValuationArbitrageViewProps) {
  const [minSpreadPct, setMinSpreadPct] = useState(5);
  const [expandedAlertId, setExpandedAlertId] = useState<string | null>(null);
  const [dispatchingAlertId, setDispatchingAlertId] = useState<string | null>(null);
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [channelPingFeedback, setChannelPingFeedback] = useState<{
    ok: boolean;
    msg: string;
  } | null>(null);
  const [alertDispatchStatus, setAlertDispatchStatus] = useState<
    Record<string, { ok: boolean; msg: string }>
  >({});

  // New Alert Rule form state
  const [ruleName, setRuleName] = useState('');
  const [ruleMetric, setRuleMetric] =
    useState<AlertRule['metric']>('ARB_SPREAD_PCT');
  const [ruleThreshold, setRuleThreshold] = useState('12');
  const [ruleScope, setRuleScope] = useState<MarketSegment | 'ALL'>('ALL');
  const [ruleChannel, setRuleChannel] =
    useState<AlertRule['channel']>('Discord Webhook');
  const [savingRule, setSavingRule] = useState(false);

  const filteredArb = useMemo(() => {
    return state.arbitrage.filter(
      (a) =>
        (segmentFilter === 'ALL' || a.segment === segmentFilter) &&
        a.netSpreadPct >= minSpreadPct
    );
  }, [state.arbitrage, segmentFilter, minSpreadPct]);

  const multiplierChartData = useMemo(() => {
    return state.assets
      .filter((a) => segmentFilter === 'ALL' || a.segment === segmentFilter)
      .map((a) => {
        const v = state.valuations[a.id];
        return {
          name:
            a.title.length > 16 ? `${a.title.slice(0, 15)}…` : a.title,
          franchise: a.franchise,
          multiplier: v?.gradeMultiplier ?? 0,
          bidAsk: v?.bidAskSpreadPct ?? 0,
        };
      })
      .sort((a, b) => b.multiplier - a.multiplier)
      .slice(0, 8);
  }, [state.assets, state.valuations, segmentFilter]);

  async function handleCreateRule(e: FormEvent) {
    e.preventDefault();
    if (!ruleName.trim()) return;
    setSavingRule(true);
    try {
      const res = await apiFetch('/api/alerts/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ruleName.trim(),
          metric: ruleMetric,
          threshold: Number(ruleThreshold) || 10,
          scopeSegment: ruleScope,
          channel: ruleChannel,
        }),
      });
      const json = await res.json();
      if (res.ok && json.state) {
        onRefreshState(json.state);
        setRuleName('');
      }
    } finally {
      setSavingRule(false);
    }
  }

  async function handleToggleRule(id: string) {
    const res = await apiFetch(`/api/alerts/rules/${id}/toggle`, {
      method: 'PATCH',
    });
    const json = await res.json();
    if (res.ok && json.state) onRefreshState(json.state);
  }

  async function handleDeleteRule(id: string) {
    const res = await apiFetch(`/api/alerts/rules/${id}`, {
      method: 'DELETE',
    });
    const json = await res.json();
    if (res.ok && json.state) onRefreshState(json.state);
  }

  async function handleDispatchAlert(al: TriggeredAlert) {
    setDispatchingAlertId(al.id);
    const targetChannel =
      al.channel === 'Terminal Feed'
        ? state.alertChannels.discord.configured
          ? 'Discord Webhook'
          : state.alertChannels.telegram.configured
            ? 'Telegram Bot'
            : 'Hermes Webhook'
        : al.channel;
    try {
      const res = await apiFetch('/api/alerts/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertId: al.id,
          channel: targetChannel,
          severity: al.severity,
          headline: al.headline,
          detail: al.deterministicDetail,
          payload: al.webhookPayload,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Dispatch failed.');
      if (json.state) onRefreshState(json.state);
      setAlertDispatchStatus((prev) => ({
        ...prev,
        [al.id]: {
          ok: Boolean(json.receipt?.delivered ?? true),
          msg: json.receipt?.detail || `Sent via ${targetChannel}`,
        },
      }));
    } catch (err) {
      setAlertDispatchStatus((prev) => ({
        ...prev,
        [al.id]: {
          ok: false,
          msg: err instanceof Error ? err.message : `${targetChannel} unavailable`,
        },
      }));
    } finally {
      setDispatchingAlertId(null);
    }
  }

  async function handleTestChannel(
    channel: 'Discord Webhook' | 'Telegram Bot' | 'Hermes Webhook'
  ) {
    setTestingChannel(channel);
    setChannelPingFeedback(null);
    try {
      const res = await apiFetch('/api/alerts/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          severity: 'MEDIUM',
          headline: 'SlabGraph Alert Channel Test Ping',
          detail: `Verified live outbound delivery to ${channel}.`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed to test ${channel}.`);
      if (json.state) onRefreshState(json.state);
      setChannelPingFeedback({
        ok: true,
        msg: json.receipt?.detail || `Test delivered to ${channel}.`,
      });
    } catch (err) {
      setChannelPingFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Channel test failed.',
      });
    } finally {
      setTestingChannel(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Cross-Marketplace Arbitrage Scanner */}
      <section className="overflow-hidden rounded-lg border border-[#1F2937] bg-[#11161D]">
        <div className="flex flex-col gap-3 border-b border-[#1F2937] px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              Layer 3: Cross-Marketplace Arbitrage Agent
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Deterministic spread calculation comparing verified SOLD_ON averages across venues.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-4 text-xs">
            <label className="inline-flex cursor-pointer items-center gap-2 text-[#CBD5E1]">
              <input
                type="checkbox"
                checked={includeFees}
                onChange={(e) => onToggleIncludeFees(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-[#334155] bg-[#090C10] accent-emerald-500"
              />
              <span>Deduct Sell-Venue Seller Fees</span>
            </label>
            <div className="flex items-center gap-2 text-[#94A3B8]">
              <span>Min Spread:</span>
              <input
                type="range"
                min={0}
                max={25}
                step={1}
                value={minSpreadPct}
                onChange={(e) => setMinSpreadPct(Number(e.target.value))}
                className="w-24 accent-emerald-500"
              />
              <span className="font-mono tabular-nums text-[#F1F5F9]">
                {minSpreadPct}%
              </span>
            </div>
          </div>
        </div>

        {filteredArb.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#94A3B8]">
            No arbitrage discrepancies exceed +{minSpreadPct}% under the current fee setting. Lower the threshold or ingest fresh multi-venue comps in Layer 1.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#1F2937] bg-[#0D1117] text-[#94A3B8]">
                  <th className="px-4 py-3 font-medium">Asset & Grade</th>
                  <th className="px-3 py-3 font-medium">Buy Venue (Low)</th>
                  <th className="px-3 py-3 font-medium">Sell Venue (High)</th>
                  <th className="px-3 py-3 text-right font-medium">Gross Sell</th>
                  <th className="px-3 py-3 text-right font-medium">Net Proceeds</th>
                  <th className="px-3 py-3 text-right font-medium">Net Edge ($)</th>
                  <th className="px-4 py-3 text-right font-medium">Net Spread</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1F2937]">
                {filteredArb.map((arb) => (
                  <tr
                    key={arb.id}
                    onClick={() => onSelectAsset(arb.assetId)}
                    className="cursor-pointer transition-colors hover:bg-[#161D27]"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#F1F5F9]">
                        {arb.assetTitle}
                      </div>
                      <div className="mt-0.5 text-[11px] text-[#94A3B8]">
                        {arb.franchise} · {arb.grade} · {arb.supportingSales} comps
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-[#E2E8F0]">{arb.buyMarketplaceName}</div>
                      <div className="font-mono text-[11px] tabular-nums text-[#94A3B8]">
                        {formatUsd(arb.buyAvgPrice)}
                      </div>
                    </td>
                    <td className="px-3 py-3">
                      <div className="text-[#E2E8F0]">{arb.sellMarketplaceName}</div>
                      <div className="font-mono text-[11px] tabular-nums text-[#94A3B8]">
                        {arb.sellerFeePct}% fee
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-[#CBD5E1] whitespace-nowrap">
                      {formatUsd(arb.sellAvgPrice)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono tabular-nums text-[#E2E8F0] whitespace-nowrap">
                      {formatUsd(arb.netSellProceeds)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono font-medium tabular-nums text-emerald-400 whitespace-nowrap">
                      +{formatUsd(arb.netProfitUsd)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums text-emerald-400 whitespace-nowrap">
                      +{arb.netSpreadPct.toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Valuation Agent: Grade Multiplier Comparison Chart */}
      <section className="rounded-lg border border-[#1F2937] bg-[#11161D] p-5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Valuation Agent: Top-Grade to PSA 9 Multipliers
            </h3>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Identifies where grading gem-mint scarcity creates outsized return premiums across TCGs and sports cards.
            </p>
          </div>
        </div>
        <div className="mt-4 h-60 w-full">
          {multiplierChartData.length === 0 ? (
            <div className="flex h-full items-center justify-center rounded-md border border-[#1F2937] bg-[#0D1117] px-4 text-center text-xs text-[#94A3B8]">
              Add canonical collectibles with verified PSA 10 &amp; PSA 9 comps to compare grade multipliers across franchises.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={multiplierChartData} margin={{ top: 8, right: 12, left: 0, bottom: 8 }}>
                <CartesianGrid stroke="#1F2937" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="name"
                  stroke="#94A3B8"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke="#94A3B8"
                  fontSize={11}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v) => `${v}x`}
                  width={40}
                />
                <Tooltip
                  cursor={{ fill: '#161D27' }}
                  contentStyle={{
                    backgroundColor: '#0D1117',
                    borderColor: '#243040',
                    borderRadius: '6px',
                    fontSize: '12px',
                    color: '#F1F5F9',
                  }}
                  formatter={(val: unknown) => [`${Number(val).toFixed(2)}x`, 'Top-to-PSA 9 Ratio']}
                />
                <Bar dataKey="multiplier" fill="#F59E0B" radius={[4, 4, 0, 0]} maxBarSize={42} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </section>

      {/* Live Outbound Alert Channels Status & Test Strip */}
      <section className="rounded-lg border border-[#1F2937] bg-[#11161D] p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Live Outbound Alert Channels
            </h3>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Real server-side webhook dispatchers configured via environment variables.
            </p>
          </div>
          <span className="font-mono text-[11px] text-[#94A3B8]">
            {state.alertDeliveries.length} delivery receipt(s) recorded
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
          {(
            [
              { label: 'Discord Webhook' as const, status: state.alertChannels.discord },
              { label: 'Telegram Bot' as const, status: state.alertChannels.telegram },
              { label: 'Hermes Webhook' as const, status: state.alertChannels.hermes },
            ]
          ).map((ch) => (
            <div
              key={ch.label}
              className="flex items-center justify-between gap-3 rounded-md border border-[#1F2937] bg-[#0D1117] px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 text-xs font-medium text-[#F1F5F9]">
                  <span>{ch.label}</span>
                  <span
                    className={`font-mono text-[11px] ${
                      ch.status.configured ? 'text-emerald-400' : 'text-[#64748B]'
                    }`}
                  >
                    {ch.status.configured ? 'Ready' : 'Unset'}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-[#94A3B8]">
                  {ch.status.hint}
                </div>
              </div>
              <button
                type="button"
                disabled={!ch.status.configured || testingChannel !== null}
                onClick={() => handleTestChannel(ch.label)}
                className="inline-flex items-center gap-1 rounded border border-[#243040] bg-[#161D27] px-2.5 py-1.5 text-[11px] font-medium text-[#E2E8F0] hover:border-emerald-500/50 disabled:opacity-40 whitespace-nowrap shrink-0"
              >
                <Send className="h-3 w-3" />
                <span>{testingChannel === ch.label ? 'Sending...' : 'Test Ping'}</span>
              </button>
            </div>
          ))}
        </div>

        {channelPingFeedback && (
          <div
            className={`mt-3 rounded-md border px-3.5 py-2 text-xs ${
              channelPingFeedback.ok
                ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                : 'border-red-500/40 bg-red-950/35 text-red-200'
            }`}
          >
            {channelPingFeedback.msg}
          </div>
        )}
      </section>

      {/* Alerting Swarm: Trigger Rules + Live Webhook Payload Feed */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Rule Builder & Active Rules (5 cols) */}
        <section className="rounded-lg border border-[#1F2937] bg-[#11161D] xl:col-span-5">
          <div className="border-b border-[#1F2937] px-5 py-3.5">
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Alert Agent Trigger Rules
            </h3>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Deterministic thresholds evaluated automatically on every Knowledge Graph mutation.
            </p>
          </div>

          <form onSubmit={handleCreateRule} className="space-y-3 border-b border-[#1F2937] p-5">
            <div>
              <label className="block text-xs font-medium text-[#CBD5E1]">
                Rule Label
              </label>
              <input
                type="text"
                required
                value={ruleName}
                onChange={(e) => setRuleName(e.target.value)}
                placeholder="e.g., Sports Rookie Arbitrage > 14%"
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-1.5 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs text-[#94A3B8]">Graph Condition</label>
                <select
                  value={ruleMetric}
                  onChange={(e) => setRuleMetric(e.target.value as AlertRule['metric'])}
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-1.5 text-xs text-[#F1F5F9]"
                >
                  <option value="ARB_SPREAD_PCT">Net Arbitrage Spread (%)</option>
                  <option value="PRICE_SWING_30D">30-Day Price Swing (%)</option>
                  <option value="CATALYST_IMPACT">Catalyst Impact (%)</option>
                  <option value="OUTLIER_DETECTED">Fraud / Outlier Quarantined</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#94A3B8]">Threshold</label>
                <input
                  type="number"
                  min={1}
                  value={ruleThreshold}
                  onChange={(e) => setRuleThreshold(e.target.value)}
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-1.5 font-mono text-xs text-[#F1F5F9]"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label className="block text-xs text-[#94A3B8]">Market Scope</label>
                <select
                  value={ruleScope}
                  onChange={(e) => setRuleScope(e.target.value as MarketSegment | 'ALL')}
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-1.5 text-xs text-[#F1F5F9]"
                >
                  <option value="ALL">All Collectibles</option>
                  <option value="TCG">Trading Card Games</option>
                  <option value="SPORTS">Sports Collectibles</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#94A3B8]">Dispatch Channel</label>
                <select
                  value={ruleChannel}
                  onChange={(e) => setRuleChannel(e.target.value as AlertRule['channel'])}
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-1.5 text-xs text-[#F1F5F9]"
                >
                  <option value="Discord Webhook">Discord Webhook</option>
                  <option value="Telegram Bot">Telegram Bot</option>
                  <option value="Hermes Webhook">Hermes Webhook</option>
                  <option value="Terminal Feed">Terminal Feed</option>
                </select>
              </div>
            </div>

            <button
              type="submit"
              disabled={savingRule}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>{savingRule ? 'Saving...' : 'Create Alert Rule'}</span>
            </button>
          </form>

          <div className="divide-y divide-[#1F2937]">
            {state.alertRules.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-[#F1F5F9]">
                    {r.name}
                  </div>
                  <div className="mt-0.5 text-[11px] text-[#94A3B8]">
                    {r.channel} · Scope: {r.scopeSegment} · Threshold: {r.threshold}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleToggleRule(r.id)}
                    className={`rounded border px-2.5 py-1 text-[11px] font-medium ${
                      r.active
                        ? 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300'
                        : 'border-[#243040] text-[#64748B]'
                    }`}
                  >
                    {r.active ? 'Active' : 'Paused'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${r.name}`}
                    onClick={() => handleDeleteRule(r.id)}
                    className="rounded p-1.5 text-[#64748B] hover:bg-[#161D27] hover:text-red-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Live Triggered Alert Feed (7 cols) */}
        <section className="rounded-lg border border-[#1F2937] bg-[#11161D] xl:col-span-7">
          <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Bell className="h-4 w-4 text-amber-400" />
              <h3 className="text-sm font-semibold text-[#F1F5F9]">
                Triggered Actionable Alerts ({state.triggeredAlerts.length})
              </h3>
            </div>
            <span className="text-xs text-[#94A3B8]">
              Click any alert to preview webhook JSON
            </span>
          </div>

          <div className="divide-y divide-[#1F2937]">
            {state.triggeredAlerts.length === 0 ? (
              <div className="p-8 text-center text-xs text-[#94A3B8]">
                No rules are currently triggered. Activate or add a rule to monitor live graph states.
              </div>
            ) : (
              state.triggeredAlerts.map((al) => {
                const isExpanded = expandedAlertId === al.id;
                return (
                  <div key={al.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs">
                          <span
                            className={`font-mono font-semibold ${
                              al.severity === 'CRITICAL'
                                ? 'text-red-400'
                                : al.severity === 'HIGH'
                                  ? 'text-emerald-400'
                                  : 'text-amber-400'
                            }`}
                          >
                            {al.severity}
                          </span>
                          <span aria-hidden="true" className="text-[#475569]">·</span>
                          <span className="font-medium text-[#F1F5F9]">
                            {al.headline}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
                          {al.deterministicDetail}
                        </p>
                        <div className="mt-1.5 text-[11px] text-[#64748B]">
                          Dispatch target: {al.channel} · Rule: {al.ruleName}
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          disabled={dispatchingAlertId === al.id}
                          onClick={() => handleDispatchAlert(al)}
                          className="inline-flex items-center gap-1 rounded border border-[#243040] bg-[#161D27] px-2.5 py-1 text-[11px] text-emerald-300 hover:border-emerald-500/50 disabled:opacity-40 whitespace-nowrap"
                        >
                          <Send className="h-3 w-3" />
                          <span>
                            {dispatchingAlertId === al.id
                              ? 'Dispatching...'
                              : al.channel === 'Terminal Feed'
                                ? 'Dispatch Live'
                                : `Send to ${al.channel.split(' ')[0]}`}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedAlertId(isExpanded ? null : al.id)
                          }
                          className="inline-flex items-center gap-1 rounded border border-[#243040] bg-[#161D27] px-2.5 py-1 text-[11px] text-[#CBD5E1] hover:border-emerald-500/50 whitespace-nowrap"
                        >
                          <Code2 className="h-3 w-3" />
                          <span>{isExpanded ? 'Hide Payload' : 'Webhook JSON'}</span>
                        </button>
                      </div>
                    </div>

                    {alertDispatchStatus[al.id] && (
                      <div
                        className={`mt-2 text-[11px] ${
                          alertDispatchStatus[al.id].ok
                            ? 'text-emerald-400'
                            : 'text-red-400'
                        }`}
                      >
                        {alertDispatchStatus[al.id].msg}
                      </div>
                    )}

                    {isExpanded && (
                      <pre className="mt-3 overflow-x-auto rounded border border-[#1F2937] bg-[#090C10] p-3 font-mono text-[11px] text-emerald-300/90">
                        {JSON.stringify(al.webhookPayload, null, 2)}
                      </pre>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {state.alertDeliveries.length > 0 && (
            <div className="border-t border-[#1F2937] bg-[#0D1117] px-5 py-3.5">
              <div className="text-[11px] font-semibold text-[#CBD5E1]">
                Recent Delivery Receipts
              </div>
              <div className="mt-2 space-y-1.5">
                {state.alertDeliveries.slice(0, 5).map((rec) => (
                  <div
                    key={rec.id}
                    className="flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]"
                  >
                    <span className="truncate text-[#CBD5E1]">
                      {rec.channel} · {rec.headline}
                    </span>
                    <span
                      className={
                        rec.delivered ? 'text-emerald-400 shrink-0' : 'text-red-400 shrink-0'
                      }
                    >
                      {rec.delivered ? `HTTP ${rec.httpStatus}` : 'FAILED'} · {formatTimeShort(rec.timestamp)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
