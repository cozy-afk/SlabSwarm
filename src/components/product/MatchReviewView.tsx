import { useEffect, useState } from 'react';

import {
  ROUTES,
  fetchMatchCorrections,
  fetchMatchQueue,
  reviewMatchCandidate,
  type MatchAction,
  type MatchCandidateView,
  type MatchCorrectionView,
  type MatchStatus,
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
const EMPTY_COUNTS: Record<MatchStatus, number> = {
  PENDING: 0, APPROVED: 0, REJECTED: 0,
};

/**
 * Match QA — internal review of listing-title matches that fell below the
 * configured hard-attribute confidence floor. The server alone computes the
 * score and writes canonical facts; this view only displays the deterministic
 * assessment and sends an operator's APPROVE / REJECT with a named reviewer.
 */
export function MatchReviewView() {
  const [candidates, setCandidates] = useState<MatchCandidateView[]>([]);
  const [corrections, setCorrections] = useState<MatchCorrectionView[]>([]);
  const [counts, setCounts] = useState<Record<MatchStatus, number>>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    Promise.all([fetchMatchQueue(), fetchMatchCorrections()])
      .then(([queue, log]) => {
        if (cancelled) return;
        setCandidates(queue.data.candidates);
        setCounts(queue.data.counts);
        setCorrections(log.data.corrections);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCandidates([]);
        setCorrections([]);
        setLoadError(error instanceof Error ? error.message : 'Could not load the match QA queue.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [reloadNonce]);

  function reload(): void {
    setReloadNonce((value) => value + 1);
  }

  async function submitReview(
    candidate: MatchCandidateView,
    options: { action: MatchAction },
  ): Promise<void> {
    const { action } = options;
    setBusyId(candidate.id);
    setReviewError(null);
    setNotice(null);
    try {
      await reviewMatchCandidate(candidate.id, action, reviewer, notes[candidate.id]);
      setNotice(`${candidate.id} ${action === 'APPROVE' ? 'approved' : 'rejected'}.`);
      reload();
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : 'Review action failed.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Identity governance"
        title="Match QA — Quarantine Queue"
        description="Listing-title matches below the configured hard-attribute confidence floor are held here. They never enter FMV or canonical price observations until an internal operator approves them with a named reviewer and an append-only correction."
        endpoints={[ROUTES.matchQueue, ROUTES.matchReview, ROUTES.matchCorrections]}
      >
        <InlineNotice>
          Hard attributes are extracted deterministically from the title. No
          model decides identity: a model may propose or explain, never decide.
          Missing values stay UNKNOWN, and corrections are append-only with
          source, basis, currency, lineage and confidence provenance.
        </InlineNotice>

        <label className="block text-xs text-[#94A3B8]" htmlFor="qa-reviewer">
          Reviewer name
          <input
            id="qa-reviewer"
            className="mt-1 w-full rounded border border-[#1F2937] bg-[#090C10] px-2 py-1 text-xs text-[#E2E8F0]"
            value={reviewer}
            onChange={(event) => setReviewer(event.target.value)}
            placeholder="operator name"
          />
        </label>

        {loadError && <p role="alert" className="text-xs text-red-300">{loadError}</p>}
        {reviewError && <p role="alert" className="text-xs text-red-300">{reviewError}</p>}
        {notice && <p className="text-xs text-emerald-300">{notice}</p>}

        {loading ? <LoadingState /> : (
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">
                Quarantine queue — pending {counts.PENDING}, approved {counts.APPROVED}, rejected {counts.REJECTED}
              </h3>
              {candidates.length === 0 ? (
                <EmptyState message="No matches are currently quarantined." />
              ) : (
                <ul className="max-h-96 space-y-2 overflow-y-auto">
                  {candidates.map((candidate) => (
                    <li key={candidate.id} className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate text-xs text-[#E2E8F0]">{candidate.title}</span>
                        <span className="font-mono text-[10px] text-[#64748B]">{candidate.status}</span>
                      </div>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        id={candidate.id} · evidence={candidate.evidenceId} · origin={candidate.origin}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        score={candidate.assessment.score} · floor={candidate.assessment.floor} · decision={candidate.assessment.decision}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        conflicts={candidate.assessment.conflicts.join(' / ') || UNKNOWN_TEXT} · reasons={candidate.assessment.reasons.join(' / ') || UNKNOWN_TEXT}
                      </p>
                      <ul className="mt-1 space-y-1">
                        {candidate.assessment.attributes.attributes.map((attribute) => (
                          <li key={`${candidate.id}-${attribute.name}`} className="font-mono text-[10px] text-[#94A3B8]">
                            {attribute.name}={attribute.value} · raw={attribute.raw} · confidence={attribute.confidence}
                          </li>
                        ))}
                      </ul>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        source={candidate.provenance.source} · basis={candidate.provenance.basis} · currency={candidate.provenance.currency}
                      </p>
                      <BasisChip basis={candidate.provenance.basis as never} />
                      <ConfidenceChip value={candidate.provenance.confidence as never} />
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        observed_at={candidate.provenance.observedAt} · captured_at={candidate.provenance.capturedAt}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        lineage={candidate.provenance.lineage.join(' / ')}
                      </p>
                      <input
                        aria-label={`Review note for ${candidate.id}`}
                        className="mt-2 w-full rounded border border-[#1F2937] bg-[#090C10] px-2 py-1 text-xs text-[#E2E8F0]"
                        value={notes[candidate.id] ?? ''}
                        onChange={(event) => setNotes((current) => ({ ...current, [candidate.id]: event.target.value }))}
                      />
                      <div className="mt-2 flex gap-2">
                        <button
                          type="button"
                          aria-label="Approve quarantined match"
                          disabled={busyId === candidate.id || candidate.status !== 'PENDING'}
                          onClick={() => void submitReview(candidate, { action: 'APPROVE' })}
                          className="rounded border border-emerald-500/40 px-2 py-1 text-[11px] text-emerald-300 disabled:opacity-50"
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          aria-label="Reject quarantined match"
                          disabled={busyId === candidate.id || candidate.status !== 'PENDING'}
                          onClick={() => void submitReview(candidate, { action: 'REJECT' })}
                          className="rounded border border-red-500/40 px-2 py-1 text-[11px] text-red-300 disabled:opacity-50"
                        >
                          Reject
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">
                Append-only corrections ({corrections.length})
              </h3>
              {corrections.length === 0 ? (
                <EmptyState message="No human review corrections have been recorded." />
              ) : (
                <ul className="max-h-96 space-y-2 overflow-y-auto">
                  {corrections.map((correction) => (
                    <li key={correction.id} className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2">
                      <p className="font-mono text-[10px] text-[#94A3B8]">
                        id={correction.id} · candidate={correction.candidateId} · action={correction.action}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        reviewer={correction.reviewer} · decided_at={correction.decidedAt} · note={correction.note ?? UNKNOWN_TEXT}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        provenance={JSON.stringify(correction.provenance)}
                      </p>
                      <p className="mt-1 font-mono text-[10px] text-[#94A3B8]">
                        score={correction.assessment.score} · floor={correction.assessment.floor} · decision={correction.assessment.decision}
                      </p>
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
