import { useState, type FormEvent } from 'react';

import type { LearningStateView } from '../../types/dataProduct.ts';
import {
  ROUTES,
  postEnvelope,
  useEnvelope,
} from '../../utils/dataProductApi.ts';
import {
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  ProductPanel,
} from './ProductPanel.tsx';

/**
 * Learning — source trust, factor weights and calibration learned from scored
 * trading-card forecasts. Promotion happens only through benchmark gates.
 */
export function LearningView() {
  const state = useEnvelope<LearningStateView>(ROUTES.learningState);
  const [forecastId, setForecastId] = useState('');
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submitFeedback(event: FormEvent) {
    event.preventDefault();
    setBusy('feedback');
    setNotice(null);
    try {
      await postEnvelope(ROUTES.learningFeedback, {
        forecastId: forecastId.trim(),
        outcome: outcome.trim(),
      });
      setNotice('Feedback recorded. Weights change only after the benchmark gate passes.');
      setOutcome('');
      state.reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Feedback failed.');
    } finally {
      setBusy(null);
    }
  }

  async function runCycle() {
    setBusy('cycle');
    setNotice(null);
    try {
      await postEnvelope(ROUTES.learningRunCycle, { domain: 'TRADING_CARDS' });
      setNotice('Learning cycle completed against scored trading-card outcomes.');
      state.reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Learning cycle failed.');
    } finally {
      setBusy(null);
    }
  }

  const data = state.data;

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Learning"
        title="Learning & Calibration"
        description="Measured trading-card forecast outcomes refine source trust, factor weights and calibration. Learning promotes rules only through benchmark gates — no model writes canonical facts directly."
        endpoints={[ROUTES.learningState]}
      >
        {state.loading ? (
          <LoadingState />
        ) : state.error ? (
          <ErrorState message={state.error} onRetry={state.reload} />
        ) : !data ? (
          <EmptyState message="No learning state is available yet. Score forecasts first." />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
              <h3 className="text-xs font-semibold text-[#E2E8F0]">Source trust</h3>
              {data.sourceTrust.length === 0 ? (
                <p className="mt-1 text-[11px] text-[#64748B]">UNKNOWN</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {data.sourceTrust.map((entry) => (
                    <li
                      key={entry.sourceId}
                      className="flex justify-between font-mono text-[10px] text-[#CBD5E1]"
                    >
                      <span className="truncate">{entry.sourceId}</span>
                      <span>{entry.trustTier}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
              <h3 className="text-xs font-semibold text-[#E2E8F0]">Factor weights</h3>
              {data.factorWeights.length === 0 ? (
                <p className="mt-1 text-[11px] text-[#64748B]">UNKNOWN</p>
              ) : (
                <ul className="mt-2 space-y-1">
                  {data.factorWeights.map((entry) => (
                    <li
                      key={entry.factor}
                      className="flex justify-between font-mono text-[10px] text-[#CBD5E1]"
                    >
                      <span className="truncate">{entry.factor}</span>
                      <span>{entry.weight}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
              <h3 className="text-xs font-semibold text-[#E2E8F0]">Calibration</h3>
              <p className="mt-1 font-mono text-[10px] text-[#CBD5E1]">
                bins={data.calibration.bins} · lastScoredAt=
                {data.calibration.lastScoredAt ?? 'UNKNOWN'}
              </p>
              <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                benchmarkGate={data.benchmarkGate}
              </p>
            </div>
            <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
              <h3 className="text-xs font-semibold text-[#E2E8F0]">Promoted rules</h3>
              <p className="mt-1 text-[11px] text-[#CBD5E1]">
                {data.promotedRules.length
                  ? data.promotedRules.join(' · ')
                  : 'No rules promoted.'}
              </p>
            </div>
          </div>
        )}
      </ProductPanel>

      <ProductPanel
        eyebrow="Feedback loop"
        title="Outcome Feedback & Learning Cycle"
        description="Record a realized trading-card outcome against a scored forecast, then run a bounded learning cycle. Promotion remains gated by benchmarks."
        endpoints={[ROUTES.learningFeedback, ROUTES.learningRunCycle]}
      >
        <InlineNotice>
          Every forecast is scored against real outcomes before it can influence
          learning. Missing outcome data stays UNKNOWN and is excluded from
          weight updates.
        </InlineNotice>
        <form onSubmit={submitFeedback} className="flex flex-wrap gap-2">
          <input
            aria-label="Forecast id"
            value={forecastId}
            onChange={(e) => setForecastId(e.target.value)}
            placeholder="Forecast id"
            className="flex-1 rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs"
          />
          <input
            aria-label="Realized outcome"
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="Realized outcome"
            className="flex-1 rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs"
          />
          <button
            type="submit"
            disabled={busy !== null || !forecastId.trim()}
            className="rounded-md border border-[#243040] px-3 py-2 text-xs text-[#CBD5E1] disabled:opacity-50"
          >
            {busy === 'feedback' ? 'Recording…' : 'Record Outcome'}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={runCycle}
            className="rounded-md bg-emerald-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy === 'cycle' ? 'Running…' : 'Run Learning Cycle'}
          </button>
        </form>
        {notice && <p className="mt-2 text-[11px] text-[#94A3B8]">{notice}</p>}
      </ProductPanel>
    </div>
  );
}
