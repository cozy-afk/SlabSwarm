import { useEffect, useState } from 'react';

import {
  ROUTES,
  fetchWebHarvestQueue,
  fetchWebSources,
  reviewWebCandidate,
  type ReviewAction,
  type ReviewCandidateView,
  type ReviewStatus,
  type WebSourceConfigView,
  type WebHarvestQueueResponse,
} from '../../utils/dataProductApi.ts';
import {
  BasisChip,
  ConfidenceChip,
  EmptyState,
  InlineNotice,
  LoadingState,
  ProductPanel,
} from './ProductPanel.tsx';

const UNKNOWN_TEXT = 'UNKNOWN';

const EMPTY_COUNTS: Record<ReviewStatus, number> = {
  PENDING: 0,
  APPROVED: 0,
  REJECTED: 0,
};

/**
 * Web Sources — operator-configured sources and the harvested candidate queue.
 * Candidates stay proposals until an operator approves them; the server writes
 * first-party catalog facts only on approval. Missing values print UNKNOWN,
 * never zero, and errors are shown as plain text from the API.
 */
export function WebSourcesView() {
  const [sources, setSources] = useState<WebSourceConfigView[]>([]);
  const [candidates, setCandidates] = useState<ReviewCandidateView[]>([]);
  const [counts, setCounts] = useState<Record<ReviewStatus, number>>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([fetchWebSources(), fetchWebHarvestQueue()])
      .then(([sourcesEnvelope, queueEnvelope]: [
        Awaited<ReturnType<typeof fetchWebSources>>,
        Awaited<ReturnType<typeof fetchWebHarvestQueue>>,
      ]) => {
        if (cancelled) return;
        setSources(sourcesEnvelope.data.sources);
        setCandidates(queueEnvelope.data.candidates);
        setCounts(queueEnvelope.data.counts);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setSources([]);
        setCandidates([]);
        setLoadError(err instanceof Error ? err.message : 'Could not load web sources.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadNonce]);

  const queue = {
    candidates,
    counts,
    loading,
    error: loadError,
    reload: () => setReloadNonce((value) => value + 1),
  };

  async function submitReview(
    candidate: ReviewCandidateView,
    options: { action: ReviewAction; note?: string },
  ): Promise<void> {
    const { action, note } = options;
    setBusyId(candidate.id);
    setReviewError(null);
    setNotice(null);
    try {
      await reviewWebCandidate(candidate.id, action, note);
      setNotice(`${candidate.name} ${action === 'APPROVE' ? 'approved' : 'rejected'}.`);
      queue.reload();
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'Review action failed.');
    } finally {
      setBusyId(null);
    }
  }

  function amountText(candidate: ReviewCandidateView): string {
    return candidate.amount === 'UNKNOWN'
      ? UNKNOWN_TEXT
      : `${candidate.amount} ${candidate.currency}`;
  }

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Ingest governance"
        title="Web Sources & Review Queue"
        description="Operator-configured public sources and harvested candidates waiting for review. Candidates are proposals with immutable evidence; only an APPROVE action writes a first-party LOW-confidence catalog card and an evidence-backed observation."
        endpoints={[
          ROUTES.webSources,
          ROUTES.webHarvestQueue,
          ROUTES.webHarvestReview,
        ]}
      >
        <InlineNotice>
          Basis is explicit and missing values stay UNKNOWN — never zero. Raw
          evidence is immutable; corrections append. TCGAPIs is a schema
          reference only, never this catalog's source.
        </InlineNotice>

        {queue.error && <p role="alert" className="text-xs text-red-300">{queue.error}</p>}
        {reviewError && <p role="alert" className="text-xs text-red-300">{reviewError}</p>}
        {notice && <p className="text-xs text-emerald-300">{notice}</p>}

        {queue.loading ? (
          <LoadingState />
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">
                Configured sources ({sources.length})
              </h3>
              {sources.length === 0 ? (
                <EmptyState message="No public sources are configured in the allowlist." />
              ) : (
                <ul className="max-h-72 space-y-2 overflow-y-auto">
                  {sources.map((source) => (
                    <li
                      key={source.id}
                      className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-[#E2E8F0]">
                          {source.name}
                        </span>
                        <span className="font-mono text-[10px] text-[#64748B]">
                          {source.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        id={source.id} · kind={source.kind} · license={source.license}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">
                Review queue — pending {queue.counts.PENDING}, approved{' '}
                {queue.counts.APPROVED}, rejected {queue.counts.REJECTED}
              </h3>
              {queue.candidates.length === 0 ? (
                <EmptyState message="No harvested candidates are waiting for review." />
              ) : (
                <ul className="max-h-96 space-y-2 overflow-y-auto">
                  {queue.candidates.map((candidate) => (
                    <li
                      key={candidate.id}
                      className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-[#E2E8F0]">
                          {candidate.name}
                        </span>
                        <span className="font-mono text-[10px] text-[#64748B]">
                          {candidate.status}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        set={candidate.set} · game={candidate.game} · number={candidate.number}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        basis={candidate.basis} · currency={candidate.currency} · amount={amountText(candidate)}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        observed_at={candidate.observedAt} · captured_at={candidate.capturedAt}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        source={candidate.sourceId} · evidence={candidate.evidenceId} · id={candidate.id}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        confidence={candidate.confidence} · warnings={candidate.warnings.join(' / ')}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <BasisChip basis={candidate.basis} />
                        <ConfidenceChip value={candidate.confidence} />
                        <button
                          type="button"
                          aria-label="Approve candidate"
                          disabled={busyId !== null || candidate.status !== 'PENDING'}
                          onClick={() => void submitReview(candidate, { action: 'APPROVE' })}
                          className="rounded-md bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          aria-label="Reject candidate"
                          disabled={busyId !== null || candidate.status !== 'PENDING'}
                          onClick={() => void submitReview(candidate, { action: 'REJECT' })}
                          className="rounded-md border border-[#243040] px-3 py-1.5 text-[11px] font-medium text-[#CBD5E1] disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </ProductPanel>
    </div>
  );
}
