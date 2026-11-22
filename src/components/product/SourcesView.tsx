import { useState, type FormEvent } from 'react';

import type { EvidenceRecordView, ObservationView } from '../../types/dataProduct.ts';
import {
  ROUTES,
  buildRoute,
  postEnvelope,
  useEnvelope,
} from '../../utils/dataProductApi.ts';
import {
  BasisChip,
  EmptyState,
  ErrorState,
  InlineNotice,
  LoadingState,
  ProductPanel,
  ProvenanceLine,
} from './ProductPanel.tsx';

const INGEST_ROUTE = buildRoute(ROUTES.ingest, { source: 'manual' });

/**
 * Sources — immutable raw evidence and normalized observations for trading
 * cards. Corrections append; missing shipping, fees, FX, grade or condition
 * remain UNKNOWN rather than becoming zero.
 */
export function SourcesView() {
  const evidence = useEnvelope<EvidenceRecordView[]>(ROUTES.evidence);
  const observations = useEnvelope<ObservationView[]>(ROUTES.observations);
  const [sourceId, setSourceId] = useState('manual-note');
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function handleIngest(event: FormEvent) {
    event.preventDefault();
    if (!rawText.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      await postEnvelope(INGEST_ROUTE, {
        sourceId,
        rawText,
        capturedAt: new Date().toISOString(),
      });
      setNotice('Evidence appended. Raw evidence is immutable; corrections append.');
      setRawText('');
      evidence.reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Ingest failed.');
    } finally {
      setBusy(false);
    }
  }

  const records = evidence.data ?? [];
  const obs = observations.data ?? [];

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Evidence layer"
        title="Sources & Raw Evidence"
        description="Immutable raw payloads and first-party market observations for trading-card research. Every record carries a source, observed_at, captured_at, lineage and confidence. Corrections append — raw evidence is never rewritten."
        endpoints={[ROUTES.evidence, ROUTES.observations, INGEST_ROUTE]}
      >
        <InlineNotice>
          Basis is explicit: SOLD / ASKING / OFFER / GUIDE / CLAIM / POPULATION /
          UNKNOWN. Missing shipping, fees, FX, grade or condition stays UNKNOWN —
          never zero.
        </InlineNotice>
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">
              Raw evidence records ({records.length})
            </h3>
            {evidence.loading ? (
              <LoadingState />
            ) : evidence.error ? (
              <ErrorState message={evidence.error} onRetry={evidence.reload} />
            ) : records.length === 0 ? (
              <EmptyState message="No evidence ingested yet for this trading-card catalog." />
            ) : (
              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {records.map((record) => (
                  <li
                    key={record.id}
                    className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-xs text-[#E2E8F0]">
                        {record.sourceId} / {record.sourceRecordId}
                      </span>
                      <span className="font-mono text-[10px] text-[#64748B]">
                        {record.parseStatus}
                      </span>
                    </div>
                    <ProvenanceLine provenance={record.provenance} />
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">
              Normalized observations ({obs.length})
            </h3>
            {observations.loading ? (
              <LoadingState />
            ) : observations.error ? (
              <ErrorState message={observations.error} onRetry={observations.reload} />
            ) : obs.length === 0 ? (
              <EmptyState message="No normalized market observations are available." />
            ) : (
              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {obs.map((item) => (
                  <li
                    key={item.id}
                    className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-[11px] text-[#CBD5E1]">
                        {item.targetIdentityRef}
                      </span>
                      <BasisChip basis={item.basis} />
                    </div>
                    <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                      amount={item.amount ?? 'UNKNOWN'} {item.currency} · status=
                      {item.status}
                    </p>
                    <ProvenanceLine provenance={item.provenance} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </ProductPanel>

      <ProductPanel
        eyebrow="Append-only ingest"
        title="Register a New Source"
        description="Add a trading-card listing, sale record, price guide entry or manual note. The adapter stores raw bytes; normalization is a separate, inspectable step."
        endpoints={[INGEST_ROUTE]}
      >
        <form onSubmit={handleIngest} className="grid gap-3 sm:grid-cols-[180px_1fr_auto]">
          <input
            aria-label="Source id"
            value={sourceId}
            onChange={(e) => setSourceId(e.target.value)}
            className="rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs"
            placeholder="Source id"
          />
          <input
            aria-label="Raw source text"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            className="rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs"
            placeholder="Raw trading-card listing, sale or note"
          />
          <button
            type="submit"
            disabled={busy || !rawText.trim()}
            className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Appending…' : 'Append Evidence'}
          </button>
        </form>
        {notice && <p className="mt-2 text-[11px] text-[#94A3B8]">{notice}</p>}
      </ProductPanel>
    </div>
  );
}
