import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bot,
  Briefcase,
  Code2,
  Compass,
  Link2,
  Lock,
  Menu,
  Network,
  Play,
  Unlock,
  X,
} from 'lucide-react';
import { AddAssetModal } from './components/AddAssetModal.tsx';
import { AssetDetailDrawer } from './components/AssetDetailDrawer.tsx';
import { GraphRagExplorerView } from './components/GraphRagExplorerView.tsx';
import { HermesConnectView } from './components/HermesConnectView.tsx';
import { MarketPulseView } from './components/MarketPulseView.tsx';
import { OnboardingWizard } from './components/OnboardingWizard.tsx';
import { PortfolioView } from './components/PortfolioView.tsx';
import { SchemaBlueprintView } from './components/SchemaBlueprintView.tsx';
import { SwarmStudioView } from './components/SwarmStudioView.tsx';
import { ValuationArbitrageView } from './components/ValuationArbitrageView.tsx';
import type {
  AuthStatusPayload,
  GraphStatePayload,
  LLMProviderId,
  LLMProviderInfo,
  MarketplaceId,
  MarketSegment,
  SwarmRoutingConfig,
  SwarmRunRecord,
} from './types/graph.ts';
import { apiFetch, setOperatorToken } from './utils/apiClient.ts';

type ActiveTab =
  | 'onboarding'
  | 'pulse'
  | 'portfolio'
  | 'swarm'
  | 'graphrag'
  | 'arbitrage'
  | 'hermes'
  | 'blueprint';

const NAV_ITEMS: Array<{
  id: ActiveTab;
  label: string;
  sublabel: string;
  icon: typeof Activity;
}> = [
  {
    id: 'onboarding',
    label: 'Setup Guide',
    sublabel: 'Self-Hosted Onboarding',
    icon: Compass,
  },
  {
    id: 'pulse',
    label: 'Market Pulse',
    sublabel: 'Universal Watchlist',
    icon: Activity,
  },
  {
    id: 'portfolio',
    label: 'Portfolio Vault',
    sublabel: 'Holdings & Live P&L',
    icon: Briefcase,
  },
  {
    id: 'swarm',
    label: 'Agent Swarm',
    sublabel: 'Layer 1 · Ingest & Triage',
    icon: Bot,
  },
  {
    id: 'graphrag',
    label: 'Knowledge Graph',
    sublabel: 'Layer 2 · GraphRAG',
    icon: Network,
  },
  {
    id: 'arbitrage',
    label: 'Valuation & Alerts',
    sublabel: 'Layer 3 · Arb & Rules',
    icon: BarChart3,
  },
  {
    id: 'hermes',
    label: 'Hermes Agent',
    sublabel: 'Gateway, Webhooks & Tools',
    icon: Link2,
  },
  {
    id: 'blueprint',
    label: 'Schema & LLM',
    sublabel: 'Cypher & Server Router',
    icon: Code2,
  },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('pulse');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const didAutoRouteOnboarding = useRef(false);

  const [graphState, setGraphState] = useState<GraphStatePayload | null>(null);
  const [providers, setProviders] = useState<LLMProviderInfo[]>([]);
  const [authStatus, setAuthStatus] = useState<AuthStatusPayload>({
    locked: false,
    authenticated: true,
    source: 'open',
  });
  const [routing, setRouting] = useState<SwarmRoutingConfig>({
    entityResolution: 'gemini',
    outlierFilter: 'gemini',
    catalystSentiment: 'gemini',
    graphRagSynthesis: 'gemini',
  });

  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Operator Unlock Modal state (in-memory Bearer token only)
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockPasscode, setUnlockPasscode] = useState('');
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  // Global Filters & Modals
  const [segmentFilter, setSegmentFilter] = useState<MarketSegment | 'ALL'>('ALL');
  const [franchiseFilter, setFranchiseFilter] = useState<string>('ALL');
  const [includeFees, setIncludeFees] = useState(true);
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);
  const [graphFocusAssetId, setGraphFocusAssetId] = useState<string | null>(null);
  const [addAssetOpen, setAddAssetOpen] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => {
      setToast((current) => (current === msg ? null : current));
    }, 4000);
  }, []);

  const fetchAuthStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/auth/status');
      if (res.ok) {
        const data = (await res.json()) as AuthStatusPayload;
        setAuthStatus(data);
      }
    } catch {
      // Non-fatal
    }
  }, []);

  const fetchAll = useCallback(
    async (feeFlag: boolean) => {
      try {
        setGlobalError(null);
        const [stateRes, llmRes, authRes] = await Promise.all([
          apiFetch(`/api/graph/state?includeFees=${feeFlag ? 'true' : 'false'}`),
          apiFetch('/api/llm/providers'),
          apiFetch('/api/auth/status'),
        ]);

        if (!stateRes.ok) {
          throw new Error('Failed to load Knowledge Graph state.');
        }

        const nextState = (await stateRes.json()) as GraphStatePayload;
        setGraphState(nextState);

        if (
          !didAutoRouteOnboarding.current &&
          nextState.assets.length === 0 &&
          !nextState.onboardingCompleted
        ) {
          didAutoRouteOnboarding.current = true;
          setActiveTab('onboarding');
        } else {
          didAutoRouteOnboarding.current = true;
        }

        if (llmRes.ok) {
          const llmData = await llmRes.json();
          setProviders(llmData.providers || []);
          if (llmData.routing) setRouting(llmData.routing);
        }

        if (authRes.ok) {
          const authData = (await authRes.json()) as AuthStatusPayload;
          setAuthStatus(authData);
        }
      } catch (err) {
        setGlobalError(
          err instanceof Error ? err.message : 'Unable to reach SlabGraph server.'
        );
      } finally {
        setLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    fetchAll(includeFees);
  }, [fetchAll, includeFees]);

  async function handleUnlockSubmit(e: FormEvent) {
    e.preventDefault();
    setUnlockError(null);
    setUnlocking(true);
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: unlockPasscode }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Invalid operator passcode.');
      }
      setOperatorToken(json.token);
      setUnlockPasscode('');
      setUnlockOpen(false);
      await fetchAuthStatus();
      showToast('Operator session unlocked in memory.');
    } catch (err) {
      setUnlockError(err instanceof Error ? err.message : 'Authentication failed.');
    } finally {
      setUnlocking(false);
    }
  }

  async function handleLockSession() {
    setOperatorToken(null);
    await fetchAuthStatus();
    showToast('Operator session locked.');
  }

  async function handleUpdateRouting(patch: Partial<SwarmRoutingConfig>) {
    const res = await apiFetch('/api/llm/routing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || 'Failed to update server LLM routing.');
    }
    setProviders(json.providers || []);
    setRouting(json.routing);
    showToast('Updated server-side Swarm LLM routing.');
  }

  async function handleSaveProvider(payload: {
    id: LLMProviderId;
    credentials: Record<string, string>;
    model: string;
  }) {
    const res = await apiFetch('/api/llm/providers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || 'Failed to save provider settings.');
    }
    setProviders(json.providers || []);
    setRouting(json.routing);
  }

  async function handleClearProvider(id: LLMProviderId) {
    const res = await apiFetch(`/api/llm/providers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || 'Failed to clear provider settings.');
    }
    setProviders(json.providers || []);
    setRouting(json.routing);
  }

  async function handleIngestItem(payload: {
    queueId?: string;
    kind: 'LISTING' | 'CATALYST';
    rawTitle: string;
    marketplaceId: MarketplaceId;
    priceUsd: number;
    sellerNotes: string;
  }): Promise<SwarmRunRecord | null> {
    const res = await apiFetch('/api/swarm/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json = await res.json();
    if (!res.ok) {
      throw new Error(json.error || 'Swarm ingestion failed.');
    }
    if (json.state) {
      setGraphState(json.state);
    }
    const run = json.run as SwarmRunRecord;
    showToast(
      run.verdict === 'QUARANTINED_OUTLIER'
        ? `Quarantined outlier: ${run.resolvedAssetTitle || run.rawTitle}`
        : run.verdict === 'CATALYST_INJECTED'
          ? `Injected MarketEvent node impacting ${run.resolvedAssetTitle}`
          : `Committed verified comp for ${run.resolvedAssetTitle}`
    );
    return run;
  }

  async function handleRunBatchSweep() {
    setIsSweeping(true);
    setGlobalError(null);
    setActiveTab('swarm');

    try {
      const queued = graphState?.queuedFeed?.slice(0, 2) ?? [];
      const question = queued.length
        ? `Research these queued trading-card observations and summarize what the swarm can conclude: ${queued
            .map((item: { rawTitle: string; sellerNotes: string }) => `${item.rawTitle}${item.sellerNotes ? ` — ${item.sellerNotes}` : ''}`)
            .join('; ')}`
        : 'Run a general trading-card market research sweep. Identify the strongest available evidence, missing data, and any card categories, sets, events, or price signals worth investigating next. Do not invent prices.';

      const res = await apiFetch('/api/research/question', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question }),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || 'Generic swarm research failed.');
      }

      showToast(
        queued.length
          ? `Generic swarm completed using ${queued.length} queued item(s). Research note saved.`
          : 'Generic trading-card swarm completed. Research note saved.'
      );
    } catch (err) {
      setGlobalError(
        err instanceof Error ? err.message : 'Swarm sweep encountered an error.'
      );
      setActiveTab('swarm');
    } finally {
      setIsSweeping(false);
    }
  }

  const activeNavMeta = NAV_ITEMS.find((n) => n.id === activeTab)!;
  const selectedAsset =
    graphState?.assets.find((a) => a.id === selectedAssetId) || null;
  const selectedValuation =
    selectedAsset && graphState ? graphState.valuations[selectedAsset.id] || null : null;

  const activeProviderLabel =
    providers.find((p) => p.id === routing.entityResolution)?.label || 'Server LLM';

  const tcgCount =
    graphState?.assets.filter((a) => a.segment === 'TCG').length ?? 0;
  const sportsCount =
    graphState?.assets.filter((a) => a.segment === 'SPORTS').length ?? 0;

  return (
    <div className="flex min-h-screen bg-[#090C10] text-[#F1F5F9]">
      {/* Mobile Sidebar Backdrop */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/65 lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Persistent Left Sidebar (248px) */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-[248px] flex-col border-r border-[#1F2937] bg-[#0D1117] transition-transform duration-200 lg:static lg:translate-x-0 ${
          mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-14 items-center justify-between border-b border-[#1F2937] px-5">
          <button
            type="button"
            onClick={() => {
              setActiveTab('pulse');
              setMobileMenuOpen(false);
            }}
            className="font-display text-base font-bold tracking-tight text-[#F1F5F9] whitespace-nowrap shrink-0"
          >
            SlabGraph
          </button>
          <button
            type="button"
            onClick={() => setMobileMenuOpen(false)}
            aria-label="Close navigation"
            className="rounded p-1 text-[#94A3B8] hover:text-[#F1F5F9] lg:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Workspace sections">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setActiveTab(item.id);
                  setMobileMenuOpen(false);
                }}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors ${
                  isActive
                    ? 'bg-[#161D27] text-[#F1F5F9]'
                    : 'text-[#94A3B8] hover:bg-[#11161D] hover:text-[#E2E8F0]'
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    isActive ? 'text-emerald-400' : 'text-[#64748B]'
                  }`}
                />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{item.label}</div>
                  <div className="truncate text-[11px] text-[#64748B]">
                    {item.sublabel}
                  </div>
                </div>
              </button>
            );
          })}
        </nav>

        {/* Quiet Structural Scope Summary */}
        <div className="border-t border-[#1F2937] p-4 text-xs">
          <div className="text-[11px] font-medium text-[#94A3B8]">
            Self-Hosted Ontology Scope
          </div>
          <div className="mt-2 space-y-1.5 font-mono text-[11px] tabular-nums text-[#CBD5E1]">
            <div className="flex items-center justify-between">
              <span className="font-sans text-[#94A3B8]">Trading Card Games</span>
              <span>{tcgCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-sans text-[#94A3B8]">Sports Collectibles</span>
              <span>{sportsCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-sans text-[#94A3B8]">Portfolio Lots</span>
              <span>{graphState?.portfolio.totalHoldingsCount ?? 0}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-sans text-[#94A3B8]">Queued Raw Feed</span>
              <span className="text-amber-400">
                {graphState?.queuedFeed.length ?? 0}
              </span>
            </div>
          </div>
          <div className="mt-3 border-t border-[#1F2937] pt-3 text-[11px] text-[#94A3B8]">
            Swarm LLM: <span className="text-[#E2E8F0]">{activeProviderLabel}</span>
          </div>
        </div>
      </aside>

      {/* Main Command Center Viewport */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Single-Row Top Bar Contract */}
        <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-[#1F2937] bg-[#090C10]/95 px-4 backdrop-blur-sm sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation"
              className="rounded-md border border-[#1F2937] p-1.5 text-[#94A3B8] hover:text-[#F1F5F9] lg:hidden"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex min-w-0 items-center gap-2 text-xs text-[#94A3B8]">
              <span className="hidden sm:inline">Collectibles Terminal</span>
              <span className="hidden sm:inline" aria-hidden="true">/</span>
              <span className="truncate font-medium text-[#F1F5F9]">
                {activeNavMeta.label}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {authStatus.locked && (
              authStatus.authenticated ? (
                <button
                  type="button"
                  onClick={handleLockSession}
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-emerald-300 hover:border-amber-500/50 hover:text-amber-300 whitespace-nowrap shrink-0"
                >
                  <Unlock className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Lock Writes</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setUnlockOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-950/30 px-3 py-1.5 text-xs font-medium text-amber-300 hover:border-amber-400 whitespace-nowrap shrink-0"
                >
                  <Lock className="h-3.5 w-3.5" />
                  <span>Unlock Operator</span>
                </button>
              )
            )}

            <button
              type="button"
              disabled={isSweeping || loading}
              onClick={handleRunBatchSweep}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{isSweeping ? 'Running Swarm...' : 'Run Generic Swarm'}</span>
            </button>
          </div>
        </header>

        {/* Main Scrollable Content Area */}
        <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
          {globalError && (
            <div className="mb-5 flex items-center justify-between gap-3 rounded-lg border border-red-500/40 bg-red-950/35 px-4 py-3 text-xs text-red-200">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-400" />
                <span>{globalError}</span>
              </div>
              <button
                type="button"
                onClick={() => setGlobalError(null)}
                className="text-red-300 hover:text-white"
              >
                Dismiss
              </button>
            </div>
          )}

          {loading || !graphState ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
                {[1, 2, 3, 4].map((n) => (
                  <div
                    key={n}
                    className="h-24 rounded-lg border border-[#1F2937] bg-[#11161D]"
                  />
                ))}
              </div>
              <div className="h-96 rounded-lg border border-[#1F2937] bg-[#11161D]" />
            </div>
          ) : (
            <>
              {activeTab === 'onboarding' && (
                <OnboardingWizard
                  state={graphState}
                  providers={providers}
                  authStatus={authStatus}
                  onRefreshState={(next) => setGraphState(next)}
                  onRefreshAuth={fetchAuthStatus}
                  onComplete={() => setActiveTab('pulse')}
                />
              )}

              {activeTab === 'pulse' && (
                <MarketPulseView
                  state={graphState}
                  segmentFilter={segmentFilter}
                  franchiseFilter={franchiseFilter}
                  onSegmentChange={setSegmentFilter}
                  onFranchiseChange={setFranchiseFilter}
                  onSelectAsset={(id) => setSelectedAssetId(id)}
                  onOpenAddAsset={() => setAddAssetOpen(true)}
                  onOpenSetupGuide={() => setActiveTab('onboarding')}
                  onNavigateTab={(tab) => setActiveTab(tab)}
                />
              )}

              {activeTab === 'portfolio' && (
                <PortfolioView
                  state={graphState}
                  onSelectAsset={(id) => setSelectedAssetId(id)}
                  onOpenAddAsset={() => setAddAssetOpen(true)}
                  onRefreshState={(next) => setGraphState(next)}
                />
              )}

              {activeTab === 'swarm' && (
                <SwarmStudioView
                  state={graphState}
                  providers={providers}
                  routing={routing}
                  isSweeping={isSweeping}
                  onUpdateRouting={handleUpdateRouting}
                  onSaveProvider={handleSaveProvider}
                  onClearProvider={handleClearProvider}
                  onNotify={showToast}
                  onIngestItem={handleIngestItem}
                  onRunBatchSweep={handleRunBatchSweep}
                />
              )}

              {activeTab === 'graphrag' && (
                <GraphRagExplorerView
                  state={graphState}
                  providers={providers}
                  routing={routing}
                  segmentFilter={segmentFilter}
                  focusedAssetId={graphFocusAssetId}
                  onSelectAsset={(id) => setSelectedAssetId(id)}
                  onRefreshState={(next) => setGraphState(next)}
                />
              )}

              {activeTab === 'arbitrage' && (
                <ValuationArbitrageView
                  state={graphState}
                  segmentFilter={segmentFilter}
                  includeFees={includeFees}
                  onToggleIncludeFees={(flag) => setIncludeFees(flag)}
                  onSelectAsset={(id) => setSelectedAssetId(id)}
                  onRefreshState={(next) => setGraphState(next)}
                />
              )}

              {activeTab === 'hermes' && (
                <HermesConnectView
                  routing={routing}
                  onUpdateRouting={handleUpdateRouting}
                  onRefreshState={(next) => setGraphState(next)}
                />
              )}

              {activeTab === 'blueprint' && (
                <SchemaBlueprintView providers={providers} />
              )}
            </>
          )}
        </main>
      </div>

      {/* Contextual Asset Intelligence Drawer */}
      <AssetDetailDrawer
        asset={selectedAsset}
        valuation={selectedValuation}
        sales={graphState?.sales || []}
        events={graphState?.events || []}
        marketplaces={graphState?.marketplaces || []}
        onClose={() => setSelectedAssetId(null)}
        onInspectInGraph={(assetId) => {
          setSelectedAssetId(null);
          setGraphFocusAssetId(assetId);
          setActiveTab('graphrag');
        }}
      />

      {/* Register Canonical Collectible Modal */}
      <AddAssetModal
        open={addAssetOpen}
        marketplaces={graphState?.marketplaces || []}
        onClose={() => setAddAssetOpen(false)}
        onCreated={async () => {
          await fetchAll(includeFees);
          showToast('Registered new canonical collectible into Knowledge Graph.');
        }}
      />

      {/* Operator Passcode Unlock Modal */}
      {unlockOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-[2px]"
          onClick={() => setUnlockOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-lg border border-[#1F2937] bg-[#11161D] p-5 text-[#F1F5F9]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#1F2937] pb-3">
              <div className="flex items-center gap-2">
                <Lock className="h-4 w-4 text-amber-400" />
                <h2 className="text-sm font-semibold">Unlock Operator Session</h2>
              </div>
              <button
                type="button"
                onClick={() => setUnlockOpen(false)}
                aria-label="Close unlock dialog"
                className="rounded p-1 text-[#94A3B8] hover:text-[#F1F5F9]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="mt-3 text-xs text-[#94A3B8]">
              Enter your self-hosted operator passcode to unlock write mutations. The Bearer session token is kept strictly in browser memory.
            </p>
            <form onSubmit={handleUnlockSubmit} className="mt-4 space-y-3">
              <input
                type="password"
                required
                autoFocus
                value={unlockPasscode}
                onChange={(e) => setUnlockPasscode(e.target.value)}
                placeholder="Operator passcode"
                className="w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
              />
              {unlockError && (
                <p className="text-xs text-red-400">{unlockError}</p>
              )}
              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setUnlockOpen(false)}
                  className="rounded-md border border-[#243040] px-3.5 py-1.5 text-xs text-[#CBD5E1] hover:bg-[#161D27]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={unlocking}
                  className="rounded-md bg-emerald-600 px-4 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
                >
                  {unlocking ? 'Verifying...' : 'Unlock'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Subtle Action Feedback Toast */}
      {toast && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-50 rounded-md border border-emerald-500/40 bg-[#11161D] px-4 py-2.5 text-xs font-medium text-emerald-300 shadow-lg"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
