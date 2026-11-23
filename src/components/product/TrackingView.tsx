import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { ConfidenceBand, MarketBasis } from '../../types/dataProduct.ts';
import { apiFetch } from '../../utils/apiClient.ts';
import {
  BasisChip,
  ConfidenceChip,
  EmptyState,
  InlineNotice,
  LoadingState,
  ProductPanel,
} from './ProductPanel.tsx';

/**
 * Task 17 — watchlist, alert rules and portfolio tracking.
 *
 * All figures come from the operator-gated /api/tracking endpoints. FMV is
 * SOLD_DERIVED with explicit source; realized and unrealized rows name the
 * bases they used. Missing fees, shipping and dates stay UNKNOWN. Fee and tax
 * outputs are ESTIMATE artifacts with visible assumptions. Alerts are stored
 * rules plus in-app state: there is no external delivery path in this task.
 */

type Value = number | 'UNKNOWN';
interface Valuation {
  value: Value;
  currency: string;
  basis: string;
  source: string;
  confidence: string;
  sampleSize: number;
  asOf: string;
  warnings: string[];
}
interface WatchRow {
  id: string;
  targetId: string;
  grade: string;
  addedAt: string;
  basis: string;
  source: string;
  currency: string;
  valuation: Valuation;
  identity: { name: string; set: string; facets: { game: string; set: string; number: string } };
  warnings: string[];
}
interface UnrealizedRow {
  holdingId: string;
  assetId: string;
  unrealized: Value;
  value: Value;
  currency: string;
  basis: string;
  source: string;
  acquiredAt: string;
  fees: Value;
  shipping: Value;
  feeTreatment: string;
  warnings: string[];
}
interface RealizedRow {
  saleId: string;
  holdingId: string;
  assetId: string;
  gain: Value;
  currency: string;
  basis: string;
  source: string;
  soldAt: string;
  acquiredAt: string;
  fees: Value;
  shipping: Value;
  feeTreatment: string;
  warnings: string[];
}
interface RuleRow {
  id: string;
  targetId: string;
  metric: string;
  threshold: number;
  basis: string;
  active: boolean;
}
interface AlertRow {
  id: string;
  ruleId: string;
  targetId: string;
  status: string;
  value: Value;
  basis: string;
  source: string;
  acknowledged: boolean;
  triggeredAt: string;
  detail: string;
}
interface Estimate {
  kind: 'ESTIMATE';
  basis: string;
  estimate: Value;
  currency: string;
  assumptions: string[];
  warnings: string[];
}
interface Summary {
  watchlist: WatchRow[];
  holdings: Array<{ id: string; assetId: string; quantity: number; unitCost: Value; acquiredAt: string }>;
  sales: Array<{ id: string; holdingId: string; soldAt: string }>;
  unrealized: UnrealizedRow[];
  realized: RealizedRow[];
  totals: { unrealizedGain: Value; realizedGain: Value; currency: string; basis: string; source: string };
  rules: RuleRow[];
  alerts: AlertRow[];
  warnings: string[];
}

const UNKNOWN_TEXT = 'UNKNOWN';
const ESTIMATE_TEXT = 'ESTIMATE';

function display(value: unknown): string {
  return value === undefined || value === null || value === '' ? UNKNOWN_TEXT : String(value);
}

function assumptionsFrom(text: string): string[] {
  return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json() as { data?: T; error?: string; meta?: { warnings?: string[] } };
  if (!response.ok || json.data === undefined) {
    throw new Error(json.error || `Tracking request failed (${response.status})`);
  }
  return json.data;
}

export function TrackingView() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [busy, setBusy] = useState(false);

  const [watchTarget, setWatchTarget] = useState('');
  const [watchGrade, setWatchGrade] = useState('');
  const [holdAsset, setHoldAsset] = useState('');
  const [holdCost, setHoldCost] = useState('');
  const [holdBasis, setHoldBasis] = useState('PURCHASE_INVOICE');
  const [holdSource, setHoldSource] = useState('operator-entry');
  const [holdAcquired, setHoldAcquired] = useState('');
  const [holdFees, setHoldFees] = useState('');
  const [holdShipping, setHoldShipping] = useState('');
  const [saleHolding, setSaleHolding] = useState('');
  const [saleProceeds, setSaleProceeds] = useState('');
  const [saleBasis, setSaleBasis] = useState('SALE_CONTRACT');
  const [saleSource, setSaleSource] = useState('operator-entry');
  const [saleDate, setSaleDate] = useState('');
  const [ruleTarget, setRuleTarget] = useState('');
  const [ruleMetric, setRuleMetric] = useState('FMV_BELOW');
  const [ruleThreshold, setRuleThreshold] = useState('100');
  const [feeBasis, setFeeBasis] = useState('OPERATOR_FEE_TABLE_2026');
  const [feeAssumptions, setFeeAssumptions] = useState('Marketplace fee 10%.\nBuyer pays shipping.');
  const [feePrice, setFeePrice] = useState('');
  const [feeRate, setFeeRate] = useState('0.10');
  const [processingRate, setProcessingRate] = useState('0.03');
  const [shippingReserve, setShippingReserve] = useState('');
  const [taxBasis, setTaxBasis] = useState('OPERATOR_TAX_RATE_2026');
  const [taxAssumptions, setTaxAssumptions] = useState('Flat 20% estimate.\nNo filing obligation is determined here.');
  const [taxGain, setTaxGain] = useState('');
  const [taxRate, setTaxRate] = useState('0.20');
  const [feeResult, setFeeResult] = useState<Estimate | null>(null);
  const [taxResult, setTaxResult] = useState<Estimate | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch('/api/tracking/summary')
      .then(async (response) => {
        const json = await response.json() as { data?: Summary; error?: string };
        if (!response.ok || !json.data) throw new Error(json.error || 'Tracking summary unavailable.');
        if (!cancelled) setSummary(json.data);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setSummary(null);
          setError(cause instanceof Error ? cause.message : 'Could not load the tracking summary.');
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  async function submit(path: string, body: unknown, onDone?: () => void): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await postJson(path, body);
      onDone?.();
      reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tracking write failed.');
    } finally {
      setBusy(false);
    }
  }

  function addWatch(e: FormEvent) {
    e.preventDefault();
    if (!watchTarget.trim()) return;
    void submit('/api/tracking/watchlist', {
      targetId: watchTarget.trim(),
      ...(watchGrade.trim() ? { grade: watchGrade.trim() } : {}),
    }, () => setWatchTarget(''));
  }

  function addHolding(e: FormEvent) {
    e.preventDefault();
    if (!holdAsset.trim()) return;
    void submit('/api/tracking/holdings', {
      assetId: holdAsset.trim(),
      quantity: 1,
      unitCost: holdCost.trim() === '' ? UNKNOWN_TEXT : Number(holdCost),
      costBasis: holdBasis.trim(),
      costSource: holdSource.trim(),
      ...(holdAcquired ? { acquiredAt: holdAcquired } : {}),
      ...(holdFees.trim() ? { fees: Number(holdFees) } : {}),
      ...(holdShipping.trim() ? { shipping: Number(holdShipping) } : {}),
    }, () => setHoldCost(''));
  }

  function addSale(e: FormEvent) {
    e.preventDefault();
    if (!saleHolding) return;
    void submit('/api/tracking/sales', {
      holdingId: saleHolding,
      quantity: 1,
      unitProceeds: saleProceeds.trim() === '' ? UNKNOWN_TEXT : Number(saleProceeds),
      proceedsBasis: saleBasis.trim(),
      proceedsSource: saleSource.trim(),
      ...(saleDate ? { soldAt: saleDate } : {}),
    }, () => setSaleProceeds(''));
  }

  function addRule(e: FormEvent) {
    e.preventDefault();
    if (!ruleTarget.trim()) return;
    void submit('/api/tracking/alerts/rules', {
      targetId: ruleTarget.trim(),
      metric: ruleMetric,
      threshold: Number(ruleThreshold),
    });
  }

  async function runEstimate(path: string, body: unknown, setResult: (value: Estimate) => void) {
    setBusy(true);
    setError(null);
    try {
      setResult(await postJson<Estimate>(path, body));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Estimate failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Free data foundation"
        title="Watchlist, alerts & portfolio"
        description="Evidence-backed positions and watch targets. Every mark names its basis and source; absent fees, shipping and dates remain UNKNOWN rather than zero."
        endpoints={[
          '/api/tracking/summary',
          '/api/tracking/watchlist',
          '/api/tracking/holdings',
          '/api/tracking/alerts/rules',
        ]}
      >
        <InlineNotice>
          All values here are read-only projections of first-party SOLD
          evidence. No model writes a canonical fact. Alerts are stored rules
          plus in-app state: no external delivery is performed in this task.
        </InlineNotice>
        {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
        {loading && <div className="mt-4"><LoadingState label="Loading tracking summary…" /></div>}
        {!loading && summary && (
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <div className="rounded-md border border-[#243040] bg-[#090C10] p-3">
              <div className="text-[11px] text-[#94A3B8]">Unrealized (gross basis)</div>
              <div className="font-mono text-lg text-[#F1F5F9]">{display(summary.totals.unrealizedGain)}</div>
              <div className="mt-1 text-[10px] text-[#64748B]">{display(summary.totals.currency)} · {display(summary.totals.basis)}</div>
            </div>
            <div className="rounded-md border border-[#243040] bg-[#090C10] p-3">
              <div className="text-[11px] text-[#94A3B8]">Realized (gross basis)</div>
              <div className="font-mono text-lg text-[#F1F5F9]">{display(summary.totals.realizedGain)}</div>
              <div className="mt-1 text-[10px] text-[#64748B]">{display(summary.totals.basis)}</div>
            </div>
            <div className="rounded-md border border-[#243040] bg-[#090C10] p-3">
              <div className="text-[11px] text-[#94A3B8]">Tracking source</div>
              <div className="break-all font-mono text-xs text-[#7DD3FC]">{display(summary.totals.source)}</div>
              <div className="mt-1 text-[10px] text-[#64748B]">Two currencies are never summed; no FX conversion is applied.</div>
            </div>
          </div>
        )}
        {!loading && summary?.warnings.map((warning) => (
          <p key={warning} className="mt-2 text-[11px] text-[#94A3B8]">• {warning}</p>
        ))}
      </ProductPanel>

      <ProductPanel
        eyebrow="Watchlist"
        title="Tracked identities and SOLD_DERIVED marks"
        description="Catalog facets come from the identity read model. FMV is derived from explicit SOLD comps; when there are none, the value stays UNKNOWN."
        endpoints={['/api/tracking/watchlist', '/api/tracking/valuation/:targetId']}
      >
        <form onSubmit={addWatch} className="flex flex-wrap gap-2">
          <input aria-label="Watch target id" value={watchTarget} onChange={(e) => setWatchTarget(e.target.value)}
            placeholder="Canonical asset id" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
          <input aria-label="Watch grade" value={watchGrade} onChange={(e) => setWatchGrade(e.target.value)}
            placeholder="Grade (optional)" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
          <button type="submit" disabled={busy} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">Add target</button>
        </form>
        {summary && summary.watchlist.length === 0 && <EmptyState message="No watch targets yet." />}
        {summary?.watchlist.map((item) => (
          <div key={item.id} className="mt-3 rounded-md border border-[#243040] bg-[#090C10] p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-[#F1F5F9]">{item.identity.name}</span>
              <BasisChip basis={item.basis as MarketBasis} />
              <ConfidenceChip value={item.valuation.confidence as ConfidenceBand} />
              <span className="font-mono text-xs text-[#F1F5F9]">{display(item.valuation.value)} {display(item.valuation.currency)}</span>
            </div>
            <p className="mt-1 font-mono text-[11px] text-[#7DD3FC]">
              source={display(item.source)} · facets={display(item.identity.facets.game)}/{display(item.identity.facets.set)}/{display(item.identity.facets.number)} · grade={display(item.grade)}
            </p>
            {item.warnings.map((warning) => <p key={warning} className="mt-1 text-[10px] text-[#94A3B8]">{warning}</p>)}
          </div>
        ))}
      </ProductPanel>

      <ProductPanel
        eyebrow="Portfolio"
        title="Holdings, unrealized and realized results"
        description="Each result names the FMV/purchase-cost or sale-proceeds/purchase-cost basis it used. Fees, shipping and dates are copied verbatim or reported as UNKNOWN."
        endpoints={['/api/tracking/holdings', '/api/tracking/sales']}
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <form onSubmit={addHolding} className="space-y-2">
            <p className="text-xs font-semibold text-[#E2E8F0]">Add holding</p>
            <input aria-label="Holding asset id" value={holdAsset} onChange={(e) => setHoldAsset(e.target.value)}
              placeholder="Canonical asset id" className="w-full rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
            <div className="grid grid-cols-2 gap-2">
              <input aria-label="Unit cost" value={holdCost} onChange={(e) => setHoldCost(e.target.value)} placeholder="Unit cost (blank = UNKNOWN)" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Cost basis label" value={holdBasis} onChange={(e) => setHoldBasis(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Cost source" value={holdSource} onChange={(e) => setHoldSource(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Acquired date" type="date" value={holdAcquired} onChange={(e) => setHoldAcquired(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Fees" value={holdFees} onChange={(e) => setHoldFees(e.target.value)} placeholder="Fees (blank = UNKNOWN)" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Shipping" value={holdShipping} onChange={(e) => setHoldShipping(e.target.value)} placeholder="Shipping (blank = UNKNOWN)" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
            </div>
            <button type="submit" disabled={busy} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">Add holding</button>
          </form>
          <form onSubmit={addSale} className="space-y-2">
            <p className="text-xs font-semibold text-[#E2E8F0]">Record a sale</p>
            <select aria-label="Sale holding" value={saleHolding} onChange={(e) => setSaleHolding(e.target.value)} className="w-full rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs">
              <option value="">Select holding…</option>
              {summary?.holdings.map((holding) => <option key={holding.id} value={holding.id}>{holding.id} — {holding.assetId}</option>)}
            </select>
            <div className="grid grid-cols-2 gap-2">
              <input aria-label="Unit proceeds" value={saleProceeds} onChange={(e) => setSaleProceeds(e.target.value)} placeholder="Unit proceeds (blank = UNKNOWN)" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Proceeds basis label" value={saleBasis} onChange={(e) => setSaleBasis(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Proceeds source" value={saleSource} onChange={(e) => setSaleSource(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Sold date" type="date" value={saleDate} onChange={(e) => setSaleDate(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
            </div>
            <button type="submit" disabled={busy} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">Record sale</button>
          </form>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-[#64748B]">
              <tr><th className="p-2">Type</th><th className="p-2">Asset</th><th className="p-2">Result</th><th className="p-2">Basis / source</th><th className="p-2">Fees / shipping / dates</th></tr>
            </thead>
            <tbody>
              {summary?.unrealized.map((row) => (
                <tr key={`u-${row.holdingId}`} className="border-t border-[#1F2937] align-top">
                  <td className="p-2">UNREALIZED</td>
                  <td className="p-2 font-mono">{row.assetId}</td>
                  <td className="p-2 font-mono">{display(row.unrealized)} {display(row.currency)}</td>
                  <td className="p-2 font-mono text-[10px]">{row.basis}<br />{row.source}</td>
                  <td className="p-2 text-[10px]">fees={display(row.fees)} · shipping={display(row.shipping)} · acquiredAt={display(row.acquiredAt)} · {row.feeTreatment}</td>
                </tr>
              ))}
              {summary?.realized.map((row) => (
                <tr key={`r-${row.saleId}`} className="border-t border-[#1F2937] align-top">
                  <td className="p-2">REALIZED</td>
                  <td className="p-2 font-mono">{row.assetId}</td>
                  <td className="p-2 font-mono">{display(row.gain)} {display(row.currency)}</td>
                  <td className="p-2 font-mono text-[10px]">{row.basis}<br />{row.source}</td>
                  <td className="p-2 text-[10px]">fees={display(row.fees)} · shipping={display(row.shipping)} · soldAt={display(row.soldAt)} · acquiredAt={display(row.acquiredAt)} · {row.feeTreatment}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {summary && summary.unrealized.length === 0 && summary.realized.length === 0 && <EmptyState message="No positions or sales recorded." />}
        </div>
      </ProductPanel>

      <ProductPanel
        eyebrow="Alerts"
        title="Stored rules and in-app alert state"
        description="Rules compare SOLD_DERIVED metrics against operator thresholds. A rule never fires on an UNKNOWN value or a different basis."
        endpoints={['/api/tracking/alerts/rules', '/api/tracking/alerts/evaluate']}
      >
        <form onSubmit={addRule} className="flex flex-wrap gap-2">
          <input aria-label="Alert target id" value={ruleTarget} onChange={(e) => setRuleTarget(e.target.value)} placeholder="Canonical asset id" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
          <select aria-label="Alert metric" value={ruleMetric} onChange={(e) => setRuleMetric(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs">
            <option value="FMV_BELOW">FMV_BELOW</option>
            <option value="FMV_ABOVE">FMV_ABOVE</option>
            <option value="FMV_DROP_PCT">FMV_DROP_PCT</option>
            <option value="SOLD_COMP_COUNT_BELOW">SOLD_COMP_COUNT_BELOW</option>
          </select>
          <input aria-label="Alert threshold" value={ruleThreshold} onChange={(e) => setRuleThreshold(e.target.value)} className="w-24 rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
          <button type="submit" disabled={busy} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">Add rule</button>
          <button type="button" disabled={busy} onClick={() => void submit('/api/tracking/alerts/evaluate', {})} className="rounded border border-[#243040] px-3 py-1.5 text-xs text-[#E2E8F0]">Evaluate</button>
        </form>
        {summary?.alerts.map((alert) => (
          <div key={alert.id} className="mt-3 rounded-md border border-[#243040] bg-[#090C10] p-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono text-[#F1F5F9]">{alert.targetId}</span>
              <span className={alert.status === 'TRIGGERED' ? 'text-amber-300' : 'text-[#94A3B8]'}>{alert.status}</span>
              <span className="font-mono">{display(alert.value)}</span>
              <BasisChip basis={alert.basis as MarketBasis} />
              <span className="font-mono text-[10px] text-[#7DD3FC]">source={display(alert.source)}</span>
              {alert.status === 'TRIGGERED' && !alert.acknowledged && (
                <button type="button" disabled={busy} onClick={() => void submit(`/api/tracking/alerts/${encodeURIComponent(alert.id)}/ack`, {})}
                  className="rounded border border-emerald-500/50 px-2 py-1 text-[10px] text-emerald-300">Acknowledge</button>
              )}
              {alert.acknowledged && <span className="text-[10px] text-emerald-400">acknowledged</span>}
            </div>
            <p className="mt-1 text-[10px] text-[#94A3B8]">{alert.detail}</p>
          </div>
        ))}
        {summary && summary.alerts.length === 0 && <EmptyState message="No alert states evaluated yet." />}
      </ProductPanel>

      <ProductPanel
        eyebrow="Calculators"
        title="Fee and tax estimates (assumptions visible)"
        description="Both artifacts are labelled ESTIMATE, carry an operator-supplied basis label and print every assumption. They are not facts, quotes, or determined obligations."
        endpoints={['/api/tracking/fees/estimate', '/api/tracking/tax/estimate']}
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-xs font-semibold text-[#E2E8F0]">Fee schedule estimate</p>
            <input aria-label="Fee basis label" value={feeBasis} onChange={(e) => setFeeBasis(e.target.value)} className="w-full rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
            <div className="grid grid-cols-2 gap-2">
              <input aria-label="Estimate price" value={feePrice} onChange={(e) => setFeePrice(e.target.value)} placeholder="Sale price" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Marketplace fee rate" value={feeRate} onChange={(e) => setFeeRate(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Processing fee rate" value={processingRate} onChange={(e) => setProcessingRate(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Shipping reserve" value={shippingReserve} onChange={(e) => setShippingReserve(e.target.value)} placeholder="Shipping reserve" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
            </div>
            <textarea aria-label="Fee assumptions" value={feeAssumptions} onChange={(e) => setFeeAssumptions(e.target.value)} rows={3} className="w-full rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
            <button type="button" disabled={busy} onClick={() => void runEstimate('/api/tracking/fees/estimate', {
              price: feePrice.trim() === '' ? UNKNOWN_TEXT : Number(feePrice),
              marketplaceFeeRate: Number(feeRate),
              processingFeeRate: Number(processingRate),
              shippingReserve: shippingReserve.trim() === '' ? UNKNOWN_TEXT : Number(shippingReserve),
              basisLabel: feeBasis,
              assumptions: assumptionsFrom(feeAssumptions),
            }, setFeeResult)} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">Estimate fees</button>
            {feeResult && (
              <div className="rounded-md border border-amber-500/30 bg-amber-950/20 p-3 text-xs">
                <div className="font-semibold text-amber-200">{ESTIMATE_TEXT} · {feeResult.basis}</div>
                <div className="font-mono text-lg text-[#F1F5F9]">{display(feeResult.estimate)} {display(feeResult.currency)}</div>
                {feeResult.assumptions.map((assumption) => <p key={assumption} className="mt-1 text-[10px] text-[#94A3B8]">• {assumption}</p>)}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <p className="text-xs font-semibold text-[#E2E8F0]">Tax estimate</p>
            <input aria-label="Tax basis label" value={taxBasis} onChange={(e) => setTaxBasis(e.target.value)} className="w-full rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
            <div className="grid grid-cols-2 gap-2">
              <input aria-label="Estimated gain" value={taxGain} onChange={(e) => setTaxGain(e.target.value)} placeholder="Gain" className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
              <input aria-label="Tax rate" value={taxRate} onChange={(e) => setTaxRate(e.target.value)} className="rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
            </div>
            <textarea aria-label="Tax assumptions" value={taxAssumptions} onChange={(e) => setTaxAssumptions(e.target.value)} rows={3} className="w-full rounded border border-[#243040] bg-[#090C10] px-2 py-1.5 text-xs" />
            <button type="button" disabled={busy} onClick={() => void runEstimate('/api/tracking/tax/estimate', {
              gain: taxGain.trim() === '' ? UNKNOWN_TEXT : Number(taxGain),
              rate: Number(taxRate),
              basisLabel: taxBasis,
              assumptions: assumptionsFrom(taxAssumptions),
            }, setTaxResult)} className="rounded bg-emerald-600 px-3 py-1.5 text-xs text-white disabled:opacity-50">Estimate tax</button>
            {taxResult && (
              <div className="rounded-md border border-amber-500/30 bg-amber-950/20 p-3 text-xs">
                <div className="font-semibold text-amber-200">{ESTIMATE_TEXT} · {taxResult.basis}</div>
                <div className="font-mono text-lg text-[#F1F5F9]">{display(taxResult.estimate)} {display(taxResult.currency)}</div>
                {taxResult.assumptions.map((assumption) => <p key={assumption} className="mt-1 text-[10px] text-[#94A3B8]">• {assumption}</p>)}
              </div>
            )}
          </div>
        </div>
        <InlineNotice>
          ASSUMED_FEE_SCHEDULE and ASSUMED_TAX_RATE are calculator labels,
          not canonical market bases. Blank inputs stay UNKNOWN; no result is
          treated as a fact.
        </InlineNotice>
      </ProductPanel>
    </div>
  );
}
