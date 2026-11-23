import { useState, type FormEvent } from 'react';

import type { EvidenceRecordView, ObservationView } from '../../types/dataProduct.ts';
import {
  ROUTES,
  buildRoute,
  fetchFreeFeeds,
  harvestFreeFeed,
  postEnvelope,
  useEnvelope,
  type FreeFeedHarvestResponse,
  type FreeFeedView,
  type FreeFeedsResponse,
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
const UNKNOWN_TEXT = 'UNKNOWN';

/**
 * Sources — immutable raw evidence and normalized observations for trading
 * cards. Corrections append; missing shipping, fees, FX, grade or condition
 * remain UNKNOWN rather than becoming zero.
 */
export function SourcesView() {
  const evidence = useEnvelope<EvidenceRecordView[]>(ROUTES.evidence);
  const observations = useEnvelope<ObservationView[]>(ROUTES.observations);
  const feeds = useEnvelope<FreeFeedsResponse>(ROUTES.freeFeeds);
  const [sourceId, setSourceId] = useState('manual-note');
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [harvestResults, setHarvestResults] = useState<Record<string, FreeFeedHarvestResponse>>({});
  const [harvestErrors, setHarvestErrors] = useState<Record<string, string>>({});
  const [harvesting, setHarvesting] = useState<string | null>(null);

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

  async function handleHarvest(feed: FreeFeedView) {
    setHarvesting(feed.sourceId);
    setHarvestErrors((prev) => ({ ...prev, [feed.sourceId]: '' }));
    try {
      const response = await harvestFreeFeed(feed.sourceId);
      const result = response.data;
      setHarvestResults((prev) => ({ ...prev, [feed.sourceId]: result }));
      if (result.errors.length > 0) {
        setHarvestErrors((prev) => ({ ...prev, [feed.sourceId]: result.errors.join('; ') }));
      }
      // A harvest appends evidence and candidates; refresh both existing lists.
      evidence.reload();
      observations.reload();
    } catch (err) {
      setHarvestErrors((prev) => ({
        ...prev,
        [feed.sourceId]: err instanceof Error ? err.message : 'Harvest failed.',
      }));
    } finally {
      setHarvesting(null);
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
        eyebrow="Free data foundation"
        title="Free Feed Harvests"
        description="Operator-controlled harvests from the four documented public catalog feeds. Each run appends immutable raw evidence and candidate observations with explicit basis and attribution; no catalog price is ever a SOLD sale."
        endpoints={[ROUTES.freeFeeds, ROUTES.freeFeedsHarvest]}
      >
        <InlineNotice>
          Keys are read server-side only; public feed metadata never includes a
          key value. Last harvest counts and errors appear below as plain text.
        </InlineNotice>
        {feeds.loading ? (
          <LoadingState />
        ) : feeds.error ? (
          <ErrorState message={feeds.error} onRetry={feeds.reload} />
        ) : !feeds.data ? (
          <EmptyState message="No free feeds are configured for this catalog." />
        ) : (
          <ul className="space-y-2">
            {feeds.data.feeds.map((feed) => {
              const result = harvestResults[feed.sourceId];
              const counts = result?.counts;
              return (
                <li
                  key={feed.sourceId}
                  className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs text-[#E2E8F0]">
                      {feed.sourceId} · {feed.vertical}
                    </span>
                    <button
                      type="button"
                      aria-label={`Harvest ${feed.sourceId}`}
                      onClick={() => handleHarvest(feed)}
                      disabled={harvesting === feed.sourceId}
                      className="rounded-md bg-emerald-600 px-3 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                    >
                      {harvesting === feed.sourceId ? 'Harvesting…' : 'Harvest'}
                    </button>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                    license={feed.license} · attribution={feed.attribution}
                  </p>
                  <p className="mt-1 font-mono text-[10px] text-[#64748B]">
                    rateLimitMs={feed.rateLimitMs} · attributionRequired=
                    {feed.attributionRequired ? 'true' : 'false'} · dailyRequestLimit=
                    {feed.dailyRequestLimit ?? UNKNOWN_TEXT}
                  </p>
                  {counts && result && (
                    <>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        last harvest: fetched={counts.fetched} created={counts.created}
                        duplicates={counts.duplicates} failed={counts.failed}
                        candidates={counts.candidates}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        status={result.status} · runId={result.runId}
                      </p>
                    </>
                  )}
                  {!counts && (
                    <p className="mt-1 font-mono text-[10px] text-[#64748B]">
                      last harvest: status={UNKNOWN_TEXT}
                    </p>
                  )}
                  {harvestErrors[feed.sourceId] && (
                    <p role="alert" className="mt-1 text-[11px] text-rose-400">
                      {harvestErrors[feed.sourceId]}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
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
