import { useState } from 'react';

import type { ForecastReport } from '../../types/dataProduct.ts';
import {
  ROUTES,
  buildRoute,
  postEnvelope,
  useEnvelope,
} from '../../utils/dataProductApi.ts';
import {
  ConfidenceChip,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  ProductPanel,
  ProvenanceLine,
} from './ProductPanel.tsx';

/**
 * Forecast Lab / Forecast Report — price bands, drivers, invalidators and
 * confidence at 7/30/90 day horizons. A forecast is a HYPOTHESIS until it is
 * scored against real trading-card outcomes.
 */
export function ForecastLabView() {
  const forecasts = useEnvelope<ForecastReport[]>(ROUTES.forecasts);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const detail = useEnvelope<ForecastReport>(
    selectedId ? buildRoute(ROUTES.forecastById, { id: selectedId }) : null
  );

  async function runAction(kind: 'score' | 'backtest') {
    const report = detail.data;
    if (!selectedId || !report) return;
    setBusy(kind);
    setNotice(null);
    const path = buildRoute(
      kind === 'score' ? ROUTES.forecastScore : ROUTES.forecastBacktest,
      { id: selectedId }
    );
    try {
      const envelope = await postEnvelope<ForecastReport>(path, {
        horizonDays: report.horizonDays,
        targetId: report.targetId,
      });
      setNotice(
        kind === 'score'
          ? 'Forecast scored against realized outcomes.'
          : 'Backtest complete. Learning promotion still requires the benchmark gate.'
      );
      if (envelope.data) detail.reload();
      forecasts.reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Action failed.');
    } finally {
      setBusy(null);
    }
  }

  const rows = forecasts.data ?? [];
  const detailReport = detail.data;

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Forecast lab"
        title="Trading Card Forecast Report"
        description="Scenario price bands, demand and supply pressure, drivers and invalidators for trading cards and sets. Every forecast is scored against real outcomes at 7, 30 and 90 days."
        endpoints={[ROUTES.forecasts, ROUTES.forecastById]}
      >
        <InlineNotice>
          Forecasts are hypotheses, never sales evidence. Bands are computed by
          deterministic code; models may propose or explain them but cannot write
          canonical facts.
        </InlineNotice>
        {forecasts.loading ? (
          <LoadingState />
        ) : forecasts.error ? (
          <ErrorState message={forecasts.error} onRetry={forecasts.reload} />
        ) : rows.length === 0 ? (
          <EmptyState message="No forecasts have been generated for the trading-card catalog yet." />
        ) : (
          <ul className="grid gap-2 md:grid-cols-2">
            {rows.map((forecast) => (
              <li key={forecast.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(forecast.id)}
                  className={`w-full rounded border px-3 py-2 text-left ${
                    selectedId === forecast.id
                      ? 'border-emerald-500/60 bg-emerald-950/20'
                      : 'border-[#1F2937] bg-[#090C10] hover:border-[#243040]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-[#E2E8F0]">
                      {forecast.targetName || forecast.targetId}
                    </span>
                    <span className="font-mono text-[10px] text-[#64748B]">
                      {forecast.targetId}
                    </span>
                    <ConfidenceChip value={forecast.confidence} />
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-[#64748B]">
                    {forecast.horizonDays}d · {forecast.scenario} · {forecast.status}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
      </ProductPanel>

      {selectedId && (
        <ProductPanel
          eyebrow="Forecast detail"
          title={`Report ${selectedId}`}
          description="The full hypothesis, its supporting evidence ids, and the deterministic scoring actions that turn it into a measured result."
          endpoints={[
            buildRoute(ROUTES.forecastById, { id: selectedId }),
            buildRoute(ROUTES.forecastScore, { id: selectedId }),
            buildRoute(ROUTES.forecastBacktest, { id: selectedId }),
          ]}
        >
          {detail.loading ? (
            <LoadingState />
          ) : detail.error ? (
            <ErrorState message={detail.error} onRetry={detail.reload} />
          ) : !detailReport ? (
            <EmptyState message="No forecast report available." />
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                {(['low', 'base', 'high'] as const).map((band) => (
                  <div
                    key={band}
                    className="rounded border border-[#1F2937] bg-[#090C10] p-3"
                  >
                    <div className="text-[10px] uppercase tracking-wider text-[#64748B]">
                      {band}
                    </div>
                    <div className="mt-1 font-mono text-sm text-[#E2E8F0]">
                      {detailReport.priceBands[band] ?? 'UNKNOWN'}{' '}
                      {detailReport.priceBands.currency}
                    </div>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
                  <h3 className="text-xs font-semibold text-[#E2E8F0]">Drivers</h3>
                  <p className="mt-1 text-[11px] text-[#CBD5E1]">
                    {detailReport.drivers.length
                      ? detailReport.drivers.join(' · ')
                      : 'UNKNOWN'}
                  </p>
                  <h3 className="mt-3 text-xs font-semibold text-[#E2E8F0]">
                    Invalidators
                  </h3>
                  <p className="mt-1 text-[11px] text-[#CBD5E1]">
                    {detailReport.invalidators.length
                      ? detailReport.invalidators.join(' · ')
                      : 'UNKNOWN'}
                  </p>
                </div>
                <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
                  <h3 className="text-xs font-semibold text-[#E2E8F0]">
                    Pressure & status
                  </h3>
                  <p className="mt-1 font-mono text-[11px] text-[#CBD5E1]">
                    demand={detailReport.demandPressure} · supply=
                    {detailReport.supplyPressure} · status={detailReport.status}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-[#64748B]">
                    evidence={detailReport.evidenceIds.length}
                  </p>
                  <ProvenanceLine provenance={detailReport.provenance} />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => runAction('score')}
                  className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {busy === 'score' ? 'Scoring…' : 'Score Forecast'}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => runAction('backtest')}
                  className="rounded-md border border-[#243040] px-3 py-1.5 text-xs text-[#CBD5E1] disabled:opacity-50"
                >
                  {busy === 'backtest' ? 'Backtesting…' : 'Run Backtest'}
                </button>
                {notice && <span className="text-[11px] text-[#94A3B8]">{notice}</span>}
              </div>
            </div>
          )}
        </ProductPanel>
      )}
    </div>
  );
}
