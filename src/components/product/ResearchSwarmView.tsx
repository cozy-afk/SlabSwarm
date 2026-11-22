import { useState, type FormEvent } from 'react';

import type { SwarmRunView } from '../../types/dataProduct.ts';
import {
  ROUTES,
  buildRoute,
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
 * Research Swarm — bounded roles propose, explain and challenge, but no model
 * writes canonical facts. Each run is traceable through role claims and the
 * evidence ids that support them.
 */
export function ResearchSwarmView() {
  const [question, setQuestion] = useState(
    'Which trading-card sets show the strongest first-party evidence of active trading in the last 30 days?'
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useEnvelope<SwarmRunView>(
    runId ? buildRoute(ROUTES.swarmRunById, { id: runId }) : null
  );

  async function handleRun(event: FormEvent) {
    event.preventDefault();
    if (!question.trim()) return;
    setBusy(true);
    setNotice(null);
    try {
      const envelope = await postEnvelope<SwarmRunView>(ROUTES.swarmRun, {
        question: question.trim(),
        mode: 'EVIDENCE_FIRST',
      });
      const id = envelope.data?.id ?? null;
      setRunId(id);
      setNotice(
        id
          ? `Research run ${id} started. Role claims are proposals, not canonical facts.`
          : 'Research run accepted. No run id was returned by the contract.'
      );
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Research run failed.');
    } finally {
      setBusy(false);
    }
  }

  const data = run.data;

  return (
    <div className="space-y-5">
      <ProductPanel
        eyebrow="Research swarm"
        title="Evidence-First Trading Card Research"
        description="Run a bounded swarm over first-party trading-card evidence. Roles propose claims, explain reasoning and challenge one another; deterministic code remains the authority for canonical facts and scores."
        endpoints={[ROUTES.swarmRun, ROUTES.swarmRunById]}
      >
        <InlineNotice>
          This replaces the legacy untargeted research stub. A run must cite evidence ids;
          unsupported claims are deflected with UNKNOWN confidence instead of
          producing an invented market answer.
        </InlineNotice>
        <form onSubmit={handleRun} className="space-y-3">
          <textarea
            aria-label="Research question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            className="w-full resize-y rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs"
            placeholder="Ask a trading-card research question grounded in first-party evidence"
          />
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={busy || !question.trim()}
              className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Run Research Swarm'}
            </button>
            {notice && <span className="text-[11px] text-[#94A3B8]">{notice}</span>}
          </div>
        </form>
      </ProductPanel>

      {runId && (
        <ProductPanel
          eyebrow="Run trace"
          title={`Swarm Run ${runId}`}
          description="Role claims and their supporting evidence are displayed verbatim. The synthesis is a proposal until a deterministic scorer evaluates it."
          endpoints={[buildRoute(ROUTES.swarmRunById, { id: runId })]}
        >
          {run.loading ? (
            <LoadingState />
          ) : run.error ? (
            <ErrorState message={run.error} onRetry={run.reload} />
          ) : !data ? (
            <EmptyState message="No trace is available for this run yet." />
          ) : (
            <div className="space-y-4">
              <div className="rounded border border-[#1F2937] bg-[#090C10] p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium text-[#E2E8F0]">
                    {data.question}
                  </span>
                  <span className="font-mono text-[10px] text-[#94A3B8]">
                    {data.status}
                  </span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-[#CBD5E1]">
                  {data.synthesis}
                </p>
                {data.missingData.length > 0 && (
                  <p className="mt-2 font-mono text-[10px] text-amber-300/80">
                    missing: {data.missingData.join(', ')}
                  </p>
                )}
              </div>
              <div>
                <h3 className="mb-2 text-xs font-semibold text-[#E2E8F0]">
                  Role claims ({data.roleClaims.length})
                </h3>
                {data.roleClaims.length === 0 ? (
                  <EmptyState message="No role claims were emitted for this trading-card question." />
                ) : (
                  <ul className="space-y-2">
                    {data.roleClaims.map((claim, index) => (
                      <li
                        key={`${claim.role}-${index}`}
                        className="rounded border border-[#1F2937] bg-[#090C10] px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] text-emerald-300">
                            {claim.role}
                          </span>
                          <span className="font-mono text-[10px] text-[#64748B]">
                            evidence={claim.evidenceIds.length}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] text-[#CBD5E1]">{claim.claim}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </ProductPanel>
      )}
    </div>
  );
}
