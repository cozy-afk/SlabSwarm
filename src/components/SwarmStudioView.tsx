import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Play,
  Send,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import type {
  GraphStatePayload,
  LLMProviderId,
  LLMProviderInfo,
  MarketplaceId,
  SwarmAgentRole,
  SwarmRoutingConfig,
  SwarmRunRecord,
} from '../types/graph.ts';
import { formatTimeShort, formatUsd } from '../utils/visualAssets.ts';

interface SwarmStudioViewProps {
  state: GraphStatePayload;
  providers: LLMProviderInfo[];
  routing: SwarmRoutingConfig;
  isSweeping: boolean;
  onUpdateRouting: (patch: Partial<SwarmRoutingConfig>) => Promise<void>;
  onSaveProvider: (payload: {
    id: LLMProviderId;
    credentials: Record<string, string>;
    model: string;
  }) => Promise<void>;
  onClearProvider: (id: LLMProviderId) => Promise<void>;
  onNotify: (message: string) => void;
  onIngestItem: (payload: {
    queueId?: string;
    kind: 'LISTING' | 'CATALYST';
    rawTitle: string;
    marketplaceId: MarketplaceId;
    priceUsd: number;
    sellerNotes: string;
  }) => Promise<SwarmRunRecord | null>;
  onRunBatchSweep: () => Promise<void>;
}

const ROLE_LABELS: Array<{
  role: SwarmAgentRole;
  title: string;
  task: string;
}> = [
  {
    role: 'entityResolution',
    title: 'Entity Resolution Agent',
    task: 'Maps messy titles to canonical IDs',
  },
  {
    role: 'outlierFilter',
    title: 'Outlier & Fraud Filter',
    task: 'Quarantines shill bids & mislabels',
  },
  {
    role: 'catalystSentiment',
    title: 'Catalyst & Sentiment Agent',
    task: 'Injects tournament & milestone nodes',
  },
  {
    role: 'graphRagSynthesis',
    title: 'GraphRAG Synthesis Agent',
    task: 'Narrates deterministic query math',
  },
];

export function SwarmStudioView({
  state,
  providers,
  routing,
  isSweeping,
  onUpdateRouting,
  onSaveProvider,
  onClearProvider,
  onNotify,
  onIngestItem,
  onRunBatchSweep,
}: SwarmStudioViewProps) {
  const [selectedRunId, setSelectedRunId] = useState<string>(
    state.swarmRuns[0]?.id || ''
  );
  const [processingId, setProcessingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [configuringId, setConfiguringId] = useState<LLMProviderId | null>(null);
  const [credentialDraft, setCredentialDraft] = useState<Record<string, string>>({});
  const [modelDraft, setModelDraft] = useState('');

  // Custom listing / catalyst form state
  const [customKind, setCustomKind] = useState<'LISTING' | 'CATALYST'>('LISTING');
  const [customTitle, setCustomTitle] = useState('');
  const [customVenue, setCustomVenue] = useState<MarketplaceId>('ebay_sold');
  const [customPrice, setCustomPrice] = useState('');
  const [customNotes, setCustomNotes] = useState('');

  const activeRun =
    state.swarmRuns.find((r) => r.id === selectedRunId) || state.swarmRuns[0];

  async function handleProcessQueued(queueId: string) {
    const q = state.queuedFeed.find((item) => item.id === queueId);
    if (!q) return;
    setErrorMsg(null);
    setProcessingId(queueId);
    try {
      const run = await onIngestItem({
        queueId: q.id,
        kind: q.kind,
        rawTitle: q.rawTitle,
        marketplaceId: q.marketplaceId,
        priceUsd: q.priceUsd,
        sellerNotes: q.sellerNotes,
      });
      if (run) setSelectedRunId(run.id);
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Swarm handoff failed.'
      );
    } finally {
      setProcessingId(null);
    }
  }

  async function handleCustomSubmit(e: FormEvent) {
    e.preventDefault();
    if (!customTitle.trim()) return;
    setErrorMsg(null);
    setProcessingId('custom');
    try {
      const run = await onIngestItem({
        kind: customKind,
        rawTitle: customTitle.trim(),
        marketplaceId: customVenue,
        priceUsd: customKind === 'CATALYST' ? 0 : Number(customPrice) || 0,
        sellerNotes: customNotes.trim(),
      });
      if (run) {
        setSelectedRunId(run.id);
        setCustomTitle('');
        setCustomNotes('');
      }
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : 'Custom ingestion failed.'
      );
    } finally {
      setProcessingId(null);
    }
  }

  return (
    <div className="space-y-6">
      {errorMsg && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-500/40 bg-red-950/35 px-4 py-3 text-xs text-red-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
          <div>
            <div className="font-medium text-red-100">Swarm Execution Error</div>
            <p className="mt-0.5 text-red-300/90">{errorMsg}</p>
          </div>
        </div>
      )}

      {state.assets.length === 0 && (
        <div className="rounded-lg border border-amber-500/35 bg-amber-950/20 px-4 py-3 text-xs text-amber-200">
          Your canonical catalog is currently empty. Register at least one collectible in the <strong>Setup Guide</strong> or via <strong>+ Register Asset</strong> so the Entity Resolution Agent has ground-truth targets to match incoming comps against.
        </div>
      )}

      {/* Pluggable Server-Side Swarm LLM Model Router */}
      <section className="rounded-lg border border-[#1F2937] bg-[#11161D]">
        <div className="flex flex-col gap-2 border-b border-[#1F2937] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              Server-Side Swarm LLM Router
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Set credentials and models here, then assign a backend per agent role. Credentials stay on the server, encrypted, and are never sent back to the browser.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-xs">
            {providers.map((p) => (
              <button
                type="button"
                key={p.id}
                onClick={() => {
                  setErrorMsg(null);
                  setConfiguringId(p.id);
                  setCredentialDraft({});
                  setModelDraft(p.defaultModel);
                }}
                className={`rounded border px-2 py-1 text-xs transition-colors ${
                  p.configured
                    ? 'border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10'
                    : 'border-[#243040] text-[#64748B] hover:border-[#3b4a5e]'
                }`}
                title={p.envHint}
              >
                {p.label}: {p.configured ? `Ready${p.hasStoredCredentials ? ' (saved)' : ''}` : 'Unset'} · Configure
              </button>
            ))}
          </div>
        </div>

        {configuringId && (
          <div className="border-b border-[#1F2937] bg-[#0D1117] px-5 py-4">
            <div className="mb-3 text-xs font-medium text-[#F1F5F9]">
              Configure {providers.find((p) => p.id === configuringId)?.label}
            </div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {providers
                .find((p) => p.id === configuringId)
                ?.credentialFields.map((field) => (
                  <label key={field} className="block">
                    <span className="mb-1 block font-mono text-[11px] text-[#94A3B8]">{field}</span>
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder="Leave blank to keep saved value"
                      value={credentialDraft[field] || ''}
                      onChange={(e) =>
                        setCredentialDraft((prev) => ({ ...prev, [field]: e.target.value }))
                      }
                      className="w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-1.5 font-mono text-xs text-[#E2E8F0] focus:border-emerald-500 focus:outline-none"
                    />
                  </label>
                ))}
              <label className="block">
                <span className="mb-1 block font-mono text-[11px] text-[#94A3B8]">Model</span>
                <input
                  type="text"
                  value={modelDraft}
                  onChange={(e) => setModelDraft(e.target.value)}
                  className="w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-1.5 font-mono text-xs text-[#E2E8F0] focus:border-emerald-500 focus:outline-none"
                />
              </label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setErrorMsg(null);
                  onSaveProvider({
                    id: configuringId,
                    credentials: credentialDraft,
                    model: modelDraft,
                  })
                    .then(() => {
                      setConfiguringId(null);
                      setCredentialDraft({});
                      onNotify('Saved server-side LLM provider settings.');
                    })
                    .catch((err) =>
                      setErrorMsg(err instanceof Error ? err.message : 'Save failed')
                    );
                }}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setErrorMsg(null);
                  onClearProvider(configuringId)
                    .then(() => {
                      setConfiguringId(null);
                      onNotify('Cleared stored provider credentials.');
                    })
                    .catch((err) =>
                      setErrorMsg(err instanceof Error ? err.message : 'Clear failed')
                    );
                }}
                className="rounded-md border border-rose-500/40 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10"
              >
                Clear saved credentials
              </button>
              <button
                type="button"
                onClick={() => setConfiguringId(null)}
                className="rounded-md border border-[#243040] px-3 py-1.5 text-xs text-[#94A3B8] hover:border-[#3b4a5e]"
              >
                Cancel
              </button>
              {errorMsg && <span className="text-xs text-rose-300">{errorMsg}</span>}
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 gap-px bg-[#1F2937] md:grid-cols-2 xl:grid-cols-4">
          {ROLE_LABELS.map(({ role, title, task }) => (
            <div key={role} className="bg-[#11161D] p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-[#F1F5F9]">{title}</span>
                <Cpu className="h-3.5 w-3.5 text-[#64748B]" />
              </div>
              <p className="mt-1 text-[11px] text-[#94A3B8]">{task}</p>
              <select
                aria-label={`Select server LLM for ${title}`}
                value={routing[role]}
                onChange={(e) => {
                  setErrorMsg(null);
                  onUpdateRouting({ [role]: e.target.value as LLMProviderId }).catch(
                    (err) =>
                      setErrorMsg(
                        err instanceof Error ? err.message : 'Routing error'
                      )
                  );
                }}
                className="mt-3 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-1.5 font-mono text-xs text-[#E2E8F0] focus:border-emerald-500 focus:outline-none"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.configured}>
                    {p.label} — {p.defaultModel} {p.configured ? '' : '(env unset)'}
                  </option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </section>

      {/* 4-Stage Horizontal Handoff Pipeline Schematic */}
      <section className="rounded-lg border border-[#1F2937] bg-[#11161D] p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              Layer 1: Ingestion & Triage Handoff Pipeline
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Deterministic parsing strips raw marketplace noise before invoking LLM agents for normalization and outlier quarantine.
            </p>
          </div>
          <button
            type="button"
            disabled={isSweeping || state.queuedFeed.length === 0}
            onClick={onRunBatchSweep}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Play className="h-3.5 w-3.5" />
            <span>
              {isSweeping
                ? 'Running Swarm Sweep...'
                : `Process Next Batch (${Math.min(2, state.queuedFeed.length)})`}
            </span>
          </button>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-4">
          {[
            {
              step: '01',
              name: 'Deterministic Parser',
              desc: 'Extracts price, grade hints, and reprint/crease keywords with zero LLM token burn.',
            },
            {
              step: '02',
              name: 'Entity Resolution Agent',
              desc: 'Resolves messy titles to strict canonical IDs to eliminate duplicate graph node bloat.',
            },
            {
              step: '03',
              name: 'Outlier & Fraud Filter',
              desc: 'Compares against exact graph comps to quarantine shill bids and mislabeled damage.',
            },
            {
              step: '04',
              name: 'Graph Commit & Recalc',
              desc: 'Writes SOLD_ON / IMPACTED edges and triggers deterministic valuation & alert loops.',
            },
          ].map((stage, idx) => (
            <div
              key={stage.step}
              className="relative rounded-md border border-[#1F2937] bg-[#0D1117] p-3.5"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-medium text-emerald-400">
                  {stage.step}. {stage.name}
                </span>
                {idx < 3 && (
                  <ArrowRight className="hidden h-3.5 w-3.5 text-[#475569] md:block" />
                )}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-[#94A3B8]">
                {stage.desc}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Main Split: Queued Raw Feed + Custom Ingest | Auditable Handoff Trace */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Left Column (5 cols): Raw Feed Queue + Custom Ingest Form */}
        <div className="space-y-6 xl:col-span-5">
          {/* Queued Multi-Marketplace Feed */}
          <section className="rounded-lg border border-[#1F2937] bg-[#11161D]">
            <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-3.5">
              <h3 className="text-sm font-semibold text-[#F1F5F9]">
                Queued Marketplace & Catalyst Feed
              </h3>
              <span className="font-mono text-xs tabular-nums text-[#94A3B8]">
                {state.queuedFeed.length} pending
              </span>
            </div>

            {state.queuedFeed.length === 0 ? (
              <div className="p-6 text-center text-xs text-[#94A3B8]">
                All queued marketplace listings have been triaged. Submit a custom raw listing or catalyst below.
              </div>
            ) : (
              <div className="divide-y divide-[#1F2937]">
                {state.queuedFeed.map((item) => (
                  <div key={item.id} className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-xs font-medium text-[#F1F5F9]">
                          {item.rawTitle}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[#94A3B8]">
                          <span>{item.kind === 'CATALYST' ? 'Market Catalyst' : 'Raw Listing'}</span>
                          <span aria-hidden="true">·</span>
                          <span>{item.marketplaceId}</span>
                          {item.priceUsd > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono tabular-nums text-[#CBD5E1]">
                                {formatUsd(item.priceUsd)}
                              </span>
                            </>
                          )}
                        </div>
                        <p className="mt-1.5 text-[11px] text-[#64748B]">
                          {item.sellerNotes}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={processingId !== null || isSweeping}
                        onClick={() => handleProcessQueued(item.id)}
                        className="rounded-md border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-emerald-300 transition-colors hover:border-emerald-500/60 hover:bg-emerald-500/10 disabled:opacity-40 whitespace-nowrap shrink-0"
                      >
                        {processingId === item.id ? 'Triaging...' : 'Run Swarm'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Custom Raw Listing / Catalyst Submission */}
          <section className="rounded-lg border border-[#1F2937] bg-[#11161D]">
            <div className="border-b border-[#1F2937] px-5 py-3.5">
              <h3 className="text-sm font-semibold text-[#F1F5F9]">
                Ingest Custom Raw Listing or Catalyst
              </h3>
              <p className="mt-0.5 text-xs text-[#94A3B8]">
                Test messy titles, cross-venue comps, shill bids, or event announcements live against the server Swarm.
              </p>
            </div>
            <form onSubmit={handleCustomSubmit} className="space-y-3.5 p-5">
              <div className="grid grid-cols-2 gap-2">
                {(['LISTING', 'CATALYST'] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setCustomKind(k)}
                    className={`rounded-md border px-3 py-1.5 text-xs font-medium transition-colors ${
                      customKind === k
                        ? 'border-emerald-500/60 bg-emerald-500/10 text-emerald-300'
                        : 'border-[#243040] bg-[#0D1117] text-[#94A3B8]'
                    }`}
                  >
                    {k === 'LISTING' ? 'Raw Sold Listing' : 'Market Catalyst Event'}
                  </button>
                ))}
              </div>

              <div>
                <label className="block text-xs font-medium text-[#CBD5E1]">
                  {customKind === 'LISTING' ? 'Raw Listing Title' : 'Catalyst Headline'}
                </label>
                <input
                  type="text"
                  required
                  value={customTitle}
                  onChange={(e) => setCustomTitle(e.target.value)}
                  placeholder={
                    customKind === 'LISTING'
                      ? 'e.g., 1999 Base Set Charizard #4 Holo PSA 9 Mint!!'
                      : 'e.g., World Championship Top 8 features 4x Elsa Enchanted decks'
                  }
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                />
              </div>

              {customKind === 'LISTING' && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-[#CBD5E1]">
                      Marketplace
                    </label>
                    <select
                      value={customVenue}
                      onChange={(e) => setCustomVenue(e.target.value as MarketplaceId)}
                      className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-2.5 py-2 text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
                    >
                      {state.marketplaces.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-[#CBD5E1]">
                      Sold Price (USD)
                    </label>
                    <input
                      type="number"
                      min={1}
                      step="0.01"
                      value={customPrice}
                      onChange={(e) => setCustomPrice(e.target.value)}
                      placeholder="Realized USD"
                      className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-[#CBD5E1]">
                  Seller Description / Event Context
                </label>
                <textarea
                  rows={2}
                  value={customNotes}
                  onChange={(e) => setCustomNotes(e.target.value)}
                  placeholder="Include condition notes, cert details, bidder patterns, or tournament impact..."
                  className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={processingId !== null || isSweeping}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                <span>
                  {processingId === 'custom'
                    ? 'Running Multi-Agent Handoff...'
                    : 'Submit to Agent Swarm'}
                </span>
              </button>
            </form>
          </section>
        </div>

        {/* Right Column (7 cols): Live Auditable Agent Handoff Trace Inspector */}
        <div className="space-y-6 xl:col-span-7">
          <section className="rounded-lg border border-[#1F2937] bg-[#11161D]">
            <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-3.5">
              <div>
                <h3 className="text-sm font-semibold text-[#F1F5F9]">
                  Auditable Agent Handoff Trace
                </h3>
                <p className="mt-0.5 text-xs text-[#94A3B8]">
                  Inspect exact structured payloads passed between deterministic parsers and server-side LLM agents.
                </p>
              </div>
              <span className="font-mono text-xs tabular-nums text-[#94A3B8]">
                {state.swarmRuns.length} run(s)
              </span>
            </div>

            {/* Run Selector Tabs */}
            <div className="flex gap-2 overflow-x-auto border-b border-[#1F2937] bg-[#0D1117] px-4 py-2.5">
              {state.swarmRuns.slice(0, 6).map((run) => {
                const isSelected = activeRun?.id === run.id;
                return (
                  <button
                    key={run.id}
                    type="button"
                    onClick={() => setSelectedRunId(run.id)}
                    className={`rounded-md border px-3 py-1.5 text-left text-xs transition-colors whitespace-nowrap shrink-0 ${
                      isSelected
                        ? 'border-emerald-500/50 bg-[#161D27] text-[#F1F5F9]'
                        : 'border-transparent text-[#94A3B8] hover:text-[#E2E8F0]'
                    }`}
                  >
                    <span className="font-mono">{run.id}</span>
                    <span className="mx-1.5 text-[#475569]">·</span>
                    <span
                      className={
                        run.verdict === 'QUARANTINED_OUTLIER'
                          ? 'text-red-400'
                          : run.verdict === 'CATALYST_INJECTED'
                            ? 'text-amber-400'
                            : 'text-emerald-400'
                      }
                    >
                      {run.verdict === 'QUARANTINED_OUTLIER'
                        ? 'Quarantined'
                        : run.verdict === 'CATALYST_INJECTED'
                          ? 'Catalyst'
                          : 'Verified'}
                    </span>
                  </button>
                );
              })}
            </div>

            {activeRun ? (
              <div className="space-y-4 p-5">
                <div className="flex flex-col gap-2 border-b border-[#1F2937] pb-4 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <div className="text-sm font-medium text-[#F1F5F9]">
                      {activeRun.rawTitle}
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[#94A3B8]">
                      <span>{formatTimeShort(activeRun.timestamp)}</span>
                      <span aria-hidden="true">·</span>
                      <span>
                        Resolved: <strong className="font-mono text-[#E2E8F0]">{activeRun.resolvedAssetId || 'N/A'}</strong>
                      </span>
                      {activeRun.resolvedGrade && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>{activeRun.resolvedGrade}</span>
                        </>
                      )}
                      {activeRun.priceUsd > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums text-[#E2E8F0]">
                            {formatUsd(activeRun.priceUsd)}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0">
                    {activeRun.verdict === 'COMMITTED_VERIFIED' && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                        <CheckCircle2 className="h-4 w-4" />
                        <span>Verified Commit</span>
                      </span>
                    )}
                    {activeRun.verdict === 'QUARANTINED_OUTLIER' && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
                        <ShieldAlert className="h-4 w-4" />
                        <span>Quarantined Outlier</span>
                      </span>
                    )}
                    {activeRun.verdict === 'CATALYST_INJECTED' && (
                      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                        <Sparkles className="h-4 w-4" />
                        <span>Catalyst Injected</span>
                      </span>
                    )}
                  </div>
                </div>

                {/* Graph Diff Callout */}
                <div className="rounded-md border border-[#1F2937] bg-[#0D1117] px-3.5 py-2.5 font-mono text-xs text-[#CBD5E1]">
                  Graph Mutation: {activeRun.graphDiff}
                </div>

                {/* Step-by-Step Handoff Cards */}
                <div className="space-y-3">
                  {activeRun.steps.map((step, i) => (
                    <div
                      key={`${activeRun.id}-${i}`}
                      className="rounded-md border border-[#1F2937] bg-[#0D1117] p-3.5"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono text-[#64748B]">0{i + 1}</span>
                          <span className="font-semibold text-[#F1F5F9]">
                            {step.agent}
                          </span>
                          <span aria-hidden="true" className="text-[#475569]">·</span>
                          <span className="text-[#94A3B8]">{step.provider}</span>
                        </div>
                        <div className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
                          <span className="text-[#64748B]">{step.latencyMs}ms</span>
                          <span
                            className={
                              step.status === 'FLAGGED'
                                ? 'text-red-400'
                                : step.status === 'COMMITTED' || step.status === 'PASSED'
                                  ? 'text-emerald-400'
                                  : 'text-[#94A3B8]'
                            }
                          >
                            {step.status}
                          </span>
                        </div>
                      </div>
                      <p className="mt-1.5 text-xs text-[#CBD5E1]">{step.summary}</p>
                      <pre className="mt-2.5 overflow-x-auto rounded border border-[#1F2937] bg-[#090C10] p-2.5 font-mono text-[11px] leading-relaxed text-[#94A3B8]">
                        {JSON.stringify(step.payload, null, 2)}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-xs text-[#94A3B8]">
                Run a Swarm item to inspect live agent handoffs.
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
