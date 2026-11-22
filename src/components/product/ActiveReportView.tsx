import { useEffect, useMemo, useState } from 'react';

import type {
  ActiveCard,
  ActiveReport,
  ApiMeta,
  EvidenceRef,
  PriceBand,
} from '../../types/dataProduct.ts';
import {
  ROUTES,
  fetchActiveReport,
  postEnvelope,
} from '../../utils/dataProductApi.ts';
import {
  BasisChip,
  ConfidenceChip,
  EmptyState,
  LoadingState,
  ProductPanel,
} from './ProductPanel.tsx';

const UNKNOWN_TEXT = 'UNKNOWN' as const;

/** Missing values stay UNKNOWN verbatim — never zero, null or a guess. */
function text(value: string | null | undefined): string {
  return value === null || value === undefined || value === '' ? UNKNOWN_TEXT : value;
}

function metric(value: number | typeof UNKNOWN_TEXT | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UNKNOWN_TEXT;
  return String(value);
}

/** Rank deterministically from response data only; no model writes this order. */
function rankCards(cards: ActiveCard[]): ActiveCard[] {
  return [...cards].sort((a, b) => {
    const byObservations = Number(b.observationCount) - Number(a.observationCount);
    if (byObservations !== 0) return byObservations;
    const byRecency = text(b.lastObservedAt).localeCompare(text(a.lastObservedAt));
    if (byRecency !== 0) return byRecency;
    return text(a.name).localeCompare(text(b.name));
  });
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-[#1F2937] bg-[#0D1117] px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-[#64748B]">{label}</div>
      <div className="mt-1 font-mono text-lg text-[#F1F5F9]">{value}</div>
    </div>
  );
}

/** Every figure is accompanied by the source/observed_at supplied by the API. */
function EvidenceCitation({ evidence }: { evidence: EvidenceRef[] }) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return (
      <p className="mt-1 font-mono text-[10px] text-[#64748B]">
        evidence={UNKNOWN_TEXT} · source={UNKNOWN_TEXT} · observed_at={UNKNOWN_TEXT}
      </p>
    );
  }
  return (
    <ul className="mt-1 max-h-24 space-y-0.5 overflow-y-auto">
      {evidence.map((ref, index) => (
        <li
          key={`${text(ref.id)}-${index}`}
          className="font-mono text-[10px] text-[#64748B]"
        >
          evidence={text(ref.id)} · source={text(ref.source)} · observed_at={text(ref.observedAt)} · basis={text(ref.basis)} · currency={text(ref.currency)}
        </li>
      ))}
    </ul>
  );
}

function PriceBandCell({ band }: { band: PriceBand | typeof UNKNOWN_TEXT }) {
  if (band === UNKNOWN_TEXT || !band) {
    return <span className="font-mono text-[10px] text-[#94A3B8]">{UNKNOWN_TEXT}</span>;
  }
  return (
    <span className="font-mono text-[10px] text-[#CBD5E1]">
      {metric(band.low)} / {metric(band.mid)} / {metric(band.high)} {text(band.currency)} · {text(band.basis)}
    </span>
  );
}

function ListCell({ values }: { values: string[] }) {
  if (!Array.isArray(values) || values.length === 0) {
    return <span className="text-[11px] text-[#94A3B8]">{UNKNOWN_TEXT}</span>;
  }
  return (
    <ul className="max-h-24 space-y-0.5 overflow-y-auto text-[11px] text-[#CBD5E1]">
      {values.map((value, index) => (
        <li key={`${index}-${value}`}>{text(value)}</li>
      ))}
    </ul>
  );
}

const cellClass = 'px-2 py-2 text-[11px] text-[#CBD5E1]';
const headClass =
  'px-2 py-2 text-[10px] font-semibold uppercase tracking-wide text-[#94A3B8]';

/**
 * Market Intelligence — one-button insight from the real active trading
 * report. The refresh action runs the discovery sweep, then re-reads the
 * report; no data is invented when the endpoint is unavailable.
 */
export function ActiveReportView() {
  const [report, setReport] = useState<ActiveReport | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  async function loadReport() {
    setLoading(true);
    setError(null);
    try {
      const envelope = await fetchActiveReport();
      setReport(envelope.data);
      setMeta(envelope.meta);
    } catch (err) {
      setReport(null);
      setMeta(null);
      setError(err instanceof Error ? err.message : 'Request failed.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadReport();
  }, []);

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      await postEnvelope(ROUTES.discoverySweep, { scope: 'TRADING_CARDS' });
      await loadReport();
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : 'Refresh failed.');
    } finally {
      setRefreshing(false);
    }
  }

  const cards = useMemo(() => rankCards(report?.cards ?? []), [report]);
  const summaryEvidence = useMemo(() => {
    const seen = new Set<string>();
    return (report?.cards ?? [])
      .flatMap((card) => (Array.isArray(card.evidence) ? card.evidence : []))
      .filter((ref) => {
        const key = `${text(ref.id)}|${text(ref.source)}|${text(ref.observedAt)}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [report]);

  return (
    <ProductPanel
      eyebrow="Intelligence"
      title="Active Trading Report"
      description="The real 'what is actively trading' view, derived from first-party evidence. Summary first, then active cards ranked by observation count. Every figure carries the source and observed_at returned by the API; missing values stay UNKNOWN. Basis is explicit."
      endpoints={[ROUTES.activeReport, ROUTES.discoverySweep]}
    >
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={refreshing || loading}
          onClick={() => {
            void refresh();
          }}
          className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : loading ? 'Loading…' : 'Refresh'}
        </button>
        <span className="text-[11px] text-[#64748B]">
          One action: run the discovery sweep, then reload the report.
        </span>
        {refreshError && (
          <p role="alert" className="text-xs text-amber-300">
            {refreshError}
          </p>
        )}
      </div>

      {loading && !report ? (
        <div className="mt-4">
          <LoadingState label="Loading the active trading report…" />
        </div>
      ) : error ? (
        <div className="mt-4">
          <p role="alert" className="text-xs text-amber-300">
            {error}
          </p>
          <button
            type="button"
            onClick={() => {
              void loadReport();
            }}
            className="mt-2 rounded border border-[#243040] px-2 py-1 text-[11px] text-[#CBD5E1]"
          >
            Retry
          </button>
        </div>
      ) : !report ? (
        <div className="mt-4">
          <EmptyState message="No report returned by the endpoint. Run a discovery sweep to derive one from evidence." />
        </div>
      ) : (
        <>
          <section
            aria-label="Report summary"
            className="mt-4 rounded-md border border-[#1F2937] bg-[#090C10] p-4"
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-xs font-semibold text-[#E2E8F0]">Summary</h3>
              <span className="font-mono text-[10px] text-[#64748B]">
                generated_at={text(report.generatedAt)} · contract={text(meta?.contractVersion)}
              </span>
            </div>
            <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Evidence records" value={metric(report.summary.totalEvidence)} />
              <Stat label="Market observations" value={metric(report.summary.totalObservations)} />
              <Stat label="Cards observed" value={metric(report.summary.cardsObserved)} />
              <Stat
                label="Data sufficiency"
                value={
                  report.summary.insufficientEvidence
                    ? 'INSUFFICIENT EVIDENCE'
                    : 'SUFFICIENT EVIDENCE'
                }
              />
            </div>
            <div className="mt-3 border-t border-[#1F2937] pt-3">
              <p className="text-[11px] text-[#94A3B8]">
                Freshness window (observed_at):{' '}
                <span className="font-mono text-[#CBD5E1]">
                  {text(report.summary.oldestObservationAt)} →{' '}
                  {text(report.summary.newestObservationAt)}
                </span>
              </p>
              <EvidenceCitation evidence={summaryEvidence} />
            </div>
          </section>

          <section aria-label="Ranked active cards" className="mt-5">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-xs font-semibold text-[#E2E8F0]">
                Active cards, ranked by observation count
              </h3>
              <p className="text-[11px] text-[#64748B]">
                Drivers and invalidators are hypothesis outputs, never sales evidence.
              </p>
            </div>
            {cards.length === 0 ? (
              <EmptyState message="No active cards in this report. Run a discovery sweep to derive them from evidence." />
            ) : (
              <div className="overflow-x-auto rounded-md border border-[#1F2937]">
                <table className="w-full min-w-[1280px] border-collapse bg-[#0D1117] text-left">
                  <thead className="bg-[#11161D]">
                    <tr>
                      <th scope="col" className={headClass}>#</th>
                      <th scope="col" className={headClass}>Name</th>
                      <th scope="col" className={headClass}>Set</th>
                      <th scope="col" className={headClass}>Game</th>
                      <th scope="col" className={headClass}>Basis</th>
                      <th scope="col" className={headClass}>Currency</th>
                      <th scope="col" className={headClass}>Observations</th>
                      <th scope="col" className={headClass}>Last observed at</th>
                      <th scope="col" className={headClass}>Momentum (7d / 30d)</th>
                      <th scope="col" className={headClass}>Price band</th>
                      <th scope="col" className={headClass}>Drivers (hypothesis)</th>
                      <th scope="col" className={headClass}>Invalidators (hypothesis)</th>
                      <th scope="col" className={headClass}>Evidence count</th>
                      <th scope="col" className={headClass}>Confidence</th>
                      <th scope="col" className={headClass}>Freshness</th>
                      <th scope="col" className={headClass}>Source · observed_at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cards.map((card, index) => (
                      <tr key={card.id} className="border-t border-[#1F2937] align-top">
                        <td className="px-2 py-2 font-mono text-[11px] text-[#64748B]">
                          {index + 1}
                        </td>
                        <td className={`${cellClass} font-medium text-[#F1F5F9]`}>
                          {text(card.name)}
                        </td>
                        <td className={cellClass}>{text(card.set)}</td>
                        <td className={cellClass}>{text(card.game)}</td>
                        <td className="px-2 py-2">
                          <BasisChip basis={card.basis} />
                        </td>
                        <td className={`${cellClass} font-mono`}>{text(card.currency)}</td>
                        <td className={`${cellClass} font-mono`}>
                          {metric(card.observationCount)}
                        </td>
                        <td className={`${cellClass} font-mono`}>
                          {text(card.lastObservedAt)}
                        </td>
                        <td className={`${cellClass} font-mono`}>
                          7d {metric(card.momentum7d)} · 30d {metric(card.momentum30d)}
                        </td>
                        <td className={cellClass}>
                          <PriceBandCell band={card.priceBand} />
                        </td>
                        <td className={cellClass}>
                          <ListCell values={card.drivers} />
                        </td>
                        <td className={cellClass}>
                          <ListCell values={card.invalidators} />
                        </td>
                        <td className={`${cellClass} font-mono`}>
                          {metric(card.evidence?.length)}
                        </td>
                        <td className="px-2 py-2">
                          <ConfidenceChip value={card.confidence} />
                        </td>
                        <td className={`${cellClass} font-mono`}>{text(card.freshness)}</td>
                        <td className="px-2 py-2">
                          <EvidenceCitation evidence={card.evidence} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </ProductPanel>
  );
}
