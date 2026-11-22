import { useState, type FormEvent } from 'react';

import type {
  CompView,
  Finding,
  MarketSnapshot,
  PriceSummary,
} from '../../types/dataProduct.ts';
import {
  ROUTES,
  buildRoute,
  postEnvelope,
  useEnvelope,
} from '../../utils/dataProductApi.ts';
import {
  BasisChip,
  ConfidenceChip,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  ProductPanel,
  ProvenanceLine,
} from './ProductPanel.tsx';

/**
 * Market Intelligence — evidence-first findings about actively trading cards,
 * plus price / comps / market snapshots keyed by a resolved card id.
 * Discovery sweeps and legacy harvests are explicit operator actions.
 */
export function MarketIntelligenceView() {
  const findings = useEnvelope<Finding[]>(ROUTES.findings);
  const [targetId, setTargetId] = useState('');
  const [activeTarget, setActiveTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const targetPath = activeTarget
    ? buildRoute(ROUTES.pricing, { id: activeTarget })
    : null;
  const compsPath = activeTarget
    ? buildRoute(ROUTES.comps, { id: activeTarget })
    : null;
  const marketPath = activeTarget
    ? buildRoute(ROUTES.market, { id: activeTarget })
    : null;
  const pricing = useEnvelope<PriceSummary>(targetPath);
  const comps = useEnvelope<CompView[]>(compsPath);
  const market = useEnvelope<MarketSnapshot>(marketPath);

  async function runAction(kind: 'sweep' | 'harvest') {
    setBusy(kind);
    setNotice(null);
    const path =
      kind === 'sweep' ? ROUTES.discoverySweep : ROUTES.harvestLegacy;
    try {
      await postEnvelope(path, { scope: 'TRADING_CARDS' });
      setNotice(
        kind === 'sweep'
          ? 'Discovery sweep queued. Findings are derived from first-party evidence only.'
          : 'Legacy harvest queued. Imported records stay raw and immutable.'
      );
      findings.reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  function handleTarget(event: FormEvent) {
    event.preventDefault();
    setActiveTarget(targetId.trim() || null);
  }

  const rows = findings.data ?? [];

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Intelligence"
        title="Market Intelligence & Findings"
        description="What is actively trading, derived from first-party trading-card evidence. Findings carry explicit basis, confidence and evidence ids; simulations are hypotheses and are never sales evidence."
        endpoints={[
          ROUTES.findings,
          ROUTES.discoverySweep,
          ROUTES.harvestLegacy,
        ]}
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => runAction('sweep')}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy === 'sweep' ? 'Sweeping…' : 'Run Discovery Sweep'}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => runAction('harvest')}
            className="rounded-md border border-[#243040] px-3 py-1.5 text-xs text-[#CBD5E1] disabled:opacity-50"
          >
            {busy === 'harvest' ? 'Harvesting…' : 'Harvest Legacy Evidence'}
          </button>
          {notice && <span className="text-[11px] text-[#94A3B8]">{notice}</span>}
        </div>

        <div className="mt-4">
          {findings.loading ? (
            <LoadingState />
          ) : findings.error ? (
            <ErrorState message={findings.error} onRetry={findings.reload} />
          ) : rows.length === 0 ? (
            <EmptyState message="No findings yet. Run a discovery sweep over the trading-card evidence lake." />
          ) : (
            <ul className="grid gap-2 md:grid-cols-2">
              {rows.map((finding) => (
                <li
                  key={finding.id}
                  className="rounded border border-[#1F2937] bg-[#090C10] p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-medium text-[#E2E8F0]">
                      {finding.title}
                    </span>
                    <ConfidenceChip value={finding.confidence} />
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-[#94A3B8]">
                    {finding.summary}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-[#64748B]">
                    {finding.type} · target={finding.targetId} · evidence=
                    {finding.evidenceIds.length}
                  </p>
                  <ProvenanceLine provenance={finding.provenance} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </ProductPanel>

      <ProductPanel
        eyebrow="Price & comps"
        title="Card Price, Comps & Market Snapshot"
        description="Inspect price summaries, eligible sold comps and market momentum for one resolved trading card. Missing fees or shipping are UNKNOWN, so values are never silently understated."
        endpoints={[ROUTES.pricing, ROUTES.comps, ROUTES.market]}
      >
        <form onSubmit={handleTarget} className="flex gap-2">
          <input
            aria-label="Resolved trading card id"
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
            placeholder="Resolved card id"
            className="flex-1 rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs"
          />
          <button
            type="submit"
            className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white"
          >
            Inspect
          </button>
        </form>

        {!activeTarget ? (
          <div className="mt-4">
            <EmptyState message="Enter a resolved trading-card id to load pricing, comps and market data." />
          </div>
        ) : (
          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
              <h3 className="text-xs font-semibold text-[#E2E8F0]">Price summary</h3>
              {pricing.loading ? (
                <LoadingState />
              ) : pricing.error ? (
                <ErrorState message={pricing.error} onRetry={pricing.reload} />
              ) : !pricing.data ? (
                <EmptyState message="No price summary available." />
              ) : (
                <>
                  <div className="mt-2 flex items-center justify-between">
                    <BasisChip basis={pricing.data.basis} />
                    <span className="font-mono text-[10px] text-[#64748B]">
                      n={pricing.data.sampleSize}
                    </span>
                  </div>
                  <p className="mt-2 font-mono text-xs text-[#CBD5E1]">
                    {pricing.data.low ?? 'UNKNOWN'} /{' '}
                    {pricing.data.median ?? 'UNKNOWN'} /{' '}
                    {pricing.data.high ?? 'UNKNOWN'} {pricing.data.currency}
                  </p>
                  <ProvenanceLine provenance={pricing.data.provenance} />
                </>
              )}
            </div>

            <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
              <h3 className="text-xs font-semibold text-[#E2E8F0]">Eligible comps</h3>
              {comps.loading ? (
                <LoadingState />
              ) : comps.error ? (
                <ErrorState message={comps.error} onRetry={comps.reload} />
              ) : (comps.data ?? []).length === 0 ? (
                <EmptyState message="No qualifying sold comps." />
              ) : (
                <ul className="mt-2 max-h-52 space-y-2 overflow-y-auto">
                  {(comps.data ?? []).map((comp) => (
                    <li key={comp.id} className="border-t border-[#1F2937] pt-2">
                      <div className="flex items-center justify-between">
                        <BasisChip basis={comp.basis} />
                        <span className="font-mono text-[10px] text-[#CBD5E1]">
                          {comp.amount ?? 'UNKNOWN'} {comp.currency}
                        </span>
                      </div>
                      <ProvenanceLine provenance={comp.provenance} />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
              <h3 className="text-xs font-semibold text-[#E2E8F0]">Market snapshot</h3>
              {market.loading ? (
                <LoadingState />
              ) : market.error ? (
                <ErrorState message={market.error} onRetry={market.reload} />
              ) : !market.data ? (
                <EmptyState message="No market snapshot available." />
              ) : (
                <>
                  <p className="mt-2 font-mono text-[11px] text-[#CBD5E1]">
                    asks={market.data.askCount ?? 'UNKNOWN'} · sold30d=
                    {market.data.soldCount30d ?? 'UNKNOWN'} · momentum=
                    {market.data.momentum}
                  </p>
                  <ProvenanceLine provenance={market.data.provenance} />
                </>
              )}
            </div>
          </div>
        )}
      </ProductPanel>

      <p className="text-[11px] text-[#64748B]">
        Simulated scenarios are hypotheses, never sales evidence. Only observed
        first-party market observations inform these summaries.
      </p>
    </div>
  );
}
