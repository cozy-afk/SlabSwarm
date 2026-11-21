import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  Database,
  Download,
  Lock,
  Plus,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
} from 'lucide-react';
import type {
  AuthStatusPayload,
  GradeLabel,
  GraphStatePayload,
  LLMProviderInfo,
  MarketplaceId,
  MarketSegment,
} from '../types/graph.ts';
import { apiFetch, setOperatorToken } from '../utils/apiClient.ts';

interface OnboardingWizardProps {
  state: GraphStatePayload;
  providers: LLMProviderInfo[];
  authStatus: AuthStatusPayload;
  onRefreshState: (next: GraphStatePayload) => void;
  onRefreshAuth: () => Promise<void>;
  onComplete: () => void;
}

const SAMPLE_IMPORT_SCHEMA = `{
  "assets": [
    {
      "segment": "TCG",
      "franchise": "Pokémon",
      "title": "Charizard Holo",
      "setName": "Base Set Unlimited",
      "releaseYear": 1999,
      "cardNumber": "4/102",
      "variant": "Holo Rare",
      "subjectName": "Charizard",
      "topGradePop": 472,
      "initialSalePriceUsd": 11500,
      "initialSaleGrade": "PSA 10",
      "initialSaleMarketplaceId": "ebay_sold",
      "initialSaleDate": "2026-11-20"
    }
  ]
}`;

const CHANNEL_SECRET_FIELDS: Record<
  string,
  Array<{ key: string; label: string; placeholder: string }>
> = {
  'Discord Webhook': [
    {
      key: 'DISCORD_WEBHOOK_URL',
      label: 'Discord webhook URL',
      placeholder: 'https://discord.com/api/webhooks/...',
    },
  ],
  'Telegram Bot': [
    {
      key: 'TELEGRAM_BOT_TOKEN',
      label: 'Bot token',
      placeholder: '123456:ABCDEF...',
    },
    { key: 'TELEGRAM_CHAT_ID', label: 'Chat ID', placeholder: '-1001234567890' },
  ],
  'Hermes Webhook': [
    {
      key: 'HERMES_WEBHOOK_URL',
      label: 'Hermes webhook URL',
      placeholder: 'https://your-hermes-host/webhook',
    },
  ],
};

export function OnboardingWizard({
  state,
  providers,
  authStatus,
  onRefreshState,
  onRefreshAuth,
  onComplete,
}: OnboardingWizardProps) {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);

  // Step 1: Optional self-hosted operator passcode claim
  const [claimPasscode, setClaimPasscode] = useState('');
  const [claimStatus, setClaimStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [claiming, setClaiming] = useState(false);

  // Step 2: Register first collectible OR Bulk JSON Import
  const [catalogTab, setCatalogTab] = useState<'SINGLE' | 'IMPORT'>('SINGLE');
  const [segment, setSegment] = useState<MarketSegment>('TCG');
  const [franchise, setFranchise] = useState('');
  const [title, setTitle] = useState('');
  const [setName, setSetName] = useState('');
  const [releaseYear, setReleaseYear] = useState(String(new Date().getFullYear()));
  const [cardNumber, setCardNumber] = useState('');
  const [variant, setVariant] = useState('');
  const [subjectName, setSubjectName] = useState('');
  const [initialPrice, setInitialPrice] = useState('');
  const [initialGrade, setInitialGrade] = useState<GradeLabel>('PSA 10');
  const [initialVenue, setInitialVenue] = useState<MarketplaceId>('ebay_sold');
  const [addingAsset, setAddingAsset] = useState(false);
  const [assetFeedback, setAssetFeedback] = useState<{ ok: boolean; msg: string } | null>(null);

  const [importJson, setImportJson] = useState('');
  const [importing, setImporting] = useState(false);

  // Step 3: Webhook / Connector test & copy
  const [testingChannel, setTestingChannel] = useState<string | null>(null);
  const [channelFeedback, setChannelFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [savingSecret, setSavingSecret] = useState(false);

  // Step 4: Build vector index & finish
  const [reindexing, setReindexing] = useState(false);
  const [indexFeedback, setIndexFeedback] = useState<{ ok: boolean; msg: string } | null>(null);
  const [exporting, setExporting] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const configuredProviders = providers.filter((p) => p.configured);
  const origin =
    typeof window !== 'undefined' ? window.location.origin : 'https://your-server.example.com';

  const connectorCurl = `curl -X POST ${origin}/api/swarm/ingest \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer <OPERATOR_TOKEN_IF_LOCKED>" \\
  -d '{
    "kind": "LISTING",
    "rawTitle": "1999 Base Set Charizard #4/102 PSA 10",
    "marketplaceId": "ebay_sold",
    "priceUsd": 11800,
    "date": "${new Date().toISOString().slice(0, 10)}"
  }'`;

  async function handleClaimPasscode(e: FormEvent) {
    e.preventDefault();
    if (claimPasscode.trim().length < 8) {
      setClaimStatus({ ok: false, msg: 'Use at least 8 characters for your operator passcode.' });
      return;
    }
    setClaiming(true);
    setClaimStatus(null);
    try {
      const res = await apiFetch('/api/auth/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: claimPasscode.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not claim passcode.');
      setOperatorToken(json.token);
      setClaimPasscode('');
      await onRefreshAuth();
      setClaimStatus({
        ok: true,
        msg: 'Server passcode claimed and hashed with scrypt. Your current session is unlocked.',
      });
    } catch (err) {
      setClaimStatus({
        ok: false,
        msg: err instanceof Error ? err.message : 'Unable to save passcode.',
      });
    } finally {
      setClaiming(false);
    }
  }

  async function handleAddSingleAsset(e: FormEvent) {
    e.preventDefault();
    setAddingAsset(true);
    setAssetFeedback(null);
    try {
      const res = await apiFetch('/api/graph/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          segment,
          franchise,
          title,
          setName,
          releaseYear: Number(releaseYear) || new Date().getFullYear(),
          cardNumber: cardNumber || '#1',
          variant: variant || 'Base',
          subjectName: subjectName || title,
          initialSalePriceUsd: Number(initialPrice) || 0,
          initialSaleGrade: initialGrade,
          initialSaleMarketplaceId: initialVenue,
          initialSaleDate: new Date().toISOString().slice(0, 10),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to add collectible.');
      if (json.state) onRefreshState(json.state);
      setAssetFeedback({
        ok: true,
        msg: `Saved canonical asset ${json.asset.title} (${json.asset.id}) to persistent disk store.`,
      });
      setTitle('');
      setCardNumber('');
      setVariant('');
      setSubjectName('');
      setInitialPrice('');
    } catch (err) {
      setAssetFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Unable to register collectible.',
      });
    } finally {
      setAddingAsset(false);
    }
  }

  async function handleBulkImport(e: FormEvent) {
    e.preventDefault();
    setImporting(true);
    setAssetFeedback(null);
    try {
      const parsed = JSON.parse(importJson);
      const res = await apiFetch('/api/graph/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Catalog import failed.');
      if (json.state) onRefreshState(json.state);
      setAssetFeedback({
        ok: true,
        msg: `Imported ${json.importedAssets} canonical asset(s) and ${json.importedSales} verified sale(s).`,
      });
      setImportJson('');
    } catch (err) {
      setAssetFeedback({
        ok: false,
        msg:
          err instanceof Error
            ? err.message
            : 'Invalid JSON payload. Check formatting and try again.',
      });
    } finally {
      setImporting(false);
    }
  }

  async function handleTestChannel(
    channel: 'Discord Webhook' | 'Telegram Bot' | 'Hermes Webhook'
  ) {
    setTestingChannel(channel);
    setChannelFeedback(null);
    try {
      const res = await apiFetch('/api/alerts/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel,
          severity: 'MEDIUM',
          headline: 'SlabGraph Self-Hosted Setup Verification',
          detail: `Connected and verified ${channel} delivery from your SlabGraph server.`,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || `Failed to test ${channel}.`);
      if (json.state) onRefreshState(json.state);
      setChannelFeedback({ ok: true, msg: json.receipt?.detail || 'Test sent.' });
    } catch (err) {
      setChannelFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Test dispatch failed.',
      });
    } finally {
      setTestingChannel(null);
    }
  }

  async function handleSaveSecret(channel: string) {
    const fields = CHANNEL_SECRET_FIELDS[channel] ?? [];
    const payload: Record<string, string> = {};
    for (const field of fields) {
      const value = (secretDrafts[field.key] ?? '').trim();
      if (!value) {
        setChannelFeedback({
          ok: false,
          msg: `${field.label} is required before saving.`,
        });
        return;
      }
      payload[field.key] = value;
    }
    setSavingSecret(true);
    setChannelFeedback(null);
    try {
      const res = await apiFetch('/api/settings/secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Could not save the secret.');
      if (json.state) onRefreshState(json.state);
      setChannelFeedback({
        ok: true,
        msg: `Saved ${Object.keys(payload).join(', ')} on the server. Test ping is now available.`,
      });
      setEditingChannel(null);
      setSecretDrafts({});
    } catch (err) {
      setChannelFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Unable to save secret.',
      });
    } finally {
      setSavingSecret(false);
    }
  }

  async function handleBuildVectorIndex() {
    setReindexing(true);
    setIndexFeedback(null);
    try {
      const res = await apiFetch('/api/embeddings/reindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceAll: false }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Vector indexing failed.');
      if (json.state) onRefreshState(json.state);
      setIndexFeedback({
        ok: true,
        msg: `Indexed ${json.newlyIndexed} new node(s) (${json.totalIndexed} total vectors stored using ${json.model}).`,
      });
    } catch (err) {
      setIndexFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Unable to build vector index.',
      });
    } finally {
      setReindexing(false);
    }
  }

  async function handleExportBackup() {
    setExporting(true);
    setIndexFeedback(null);
    try {
      const res = await apiFetch('/api/graph/export');
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'Could not export backup.');
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `slabgraph-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setIndexFeedback({
        ok: false,
        msg: err instanceof Error ? err.message : 'Backup export failed.',
      });
    } finally {
      setExporting(false);
    }
  }

  async function handleFinishOnboarding() {
    setFinishing(true);
    try {
      const res = await apiFetch('/api/onboarding/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed: true }),
      });
      const json = await res.json();
      if (res.ok && json.state) {
        onRefreshState(json.state);
      }
      onComplete();
    } finally {
      setFinishing(false);
    }
  }

  async function handleCopyCurl() {
    try {
      await navigator.clipboard.writeText(connectorCurl);
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 1800);
    } catch {
      // Clipboard may be restricted
    }
  }

  const steps: Array<{ id: 1 | 2 | 3 | 4; label: string; done: boolean }> = [
    { id: 1, label: '1. Server & Storage', done: configuredProviders.length > 0 },
    { id: 2, label: '2. Canonical Catalog', done: state.assets.length > 0 },
    {
      id: 3,
      label: '3. Connectors & Alerts',
      done:
        state.alertChannels.discord.configured ||
        state.alertChannels.telegram.configured ||
        state.alertChannels.hermes.configured,
    },
    {
      id: 4,
      label: '4. Vector Index & Launch',
      done:
        state.vectorIndex.totalAssets > 0 &&
        state.vectorIndex.indexedAssets === state.vectorIndex.totalAssets,
    },
  ];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Header */}
      <section className="rounded-lg border border-[#1F2937] bg-[#11161D] p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-display text-lg font-semibold text-[#F1F5F9]">
              Self-Hosted SlabGraph Setup Guide
            </h1>
            <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
              Zero mock data is loaded. Follow these 4 steps to verify your persistent store, register your real collectibles, connect live alert webhooks or scrapers, and build your semantic vector index.
            </p>
          </div>
          <button
            type="button"
            onClick={handleFinishOnboarding}
            disabled={finishing}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#243040] bg-[#161D27] px-3.5 py-2 text-xs font-medium text-[#E2E8F0] transition-colors hover:border-emerald-500/50 hover:text-emerald-300 whitespace-nowrap shrink-0"
          >
            <span>Open Terminal</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Stepper */}
        <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {steps.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStep(s.id)}
              className={`flex items-center justify-between gap-2 rounded-md border px-3 py-2.5 text-left text-xs font-medium transition-colors ${
                step === s.id
                  ? 'border-emerald-500/60 bg-[#161D27] text-[#F1F5F9]'
                  : 'border-[#1F2937] bg-[#0D1117] text-[#94A3B8] hover:border-[#334155] hover:text-[#E2E8F0]'
              }`}
            >
              <span className="truncate">{s.label}</span>
              {s.done && <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" />}
            </button>
          ))}
        </div>
      </section>

      {/* Step 1: Server Health, Storage & Optional Operator Lock */}
      {step === 1 && (
        <section className="space-y-5 rounded-lg border border-[#1F2937] bg-[#11161D] p-6">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              Step 1 · Verify Persistence, Server LLMs & Access Control
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Every asset, comp, portfolio holding, alert rule, and embedding vector persists atomically to your server disk.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-md border border-[#1F2937] bg-[#0D1117] p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-[#CBD5E1]">
                <Database className="h-3.5 w-3.5 text-emerald-400" />
                <span>Persistent Disk Store</span>
              </div>
              <div className="mt-2 font-mono text-xs text-[#F1F5F9]">
                {state.storage.filePath}
              </div>
              <div className="mt-1 font-mono text-[11px] text-[#94A3B8]">
                {(state.storage.fileSizeBytes / 1024).toFixed(1)} KB on disk · Atomic JSON WAL
              </div>
            </div>

            <div className="rounded-md border border-[#1F2937] bg-[#0D1117] p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-[#CBD5E1]">
                <Sparkles className="h-3.5 w-3.5 text-emerald-400" />
                <span>Configured Server LLMs</span>
              </div>
              <div className="mt-2 font-mono text-xs text-[#F1F5F9]">
                {configuredProviders.length > 0
                  ? configuredProviders.map((p) => p.label).join(', ')
                  : 'None configured yet'}
              </div>
              <div className="mt-1 text-[11px] text-[#94A3B8]">
                Set GEMINI_API_KEY, HERMES_API_URL, OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_BASE_URL in .env
              </div>
            </div>

            <div className="rounded-md border border-[#1F2937] bg-[#0D1117] p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-[#CBD5E1]">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
                <span>Hybrid Vector Embeddings</span>
              </div>
              <div className="mt-2 font-mono text-xs text-[#F1F5F9]">
                {state.vectorIndex.configured
                  ? `${state.vectorIndex.model} ready`
                  : 'Pending API key'}
              </div>
              <div className="mt-1 text-[11px] text-[#94A3B8]">
                {state.vectorIndex.indexedAssets}/{state.vectorIndex.totalAssets} assets embedded
              </div>
            </div>
          </div>

          {/* Optional Self-Hosted Operator Passcode Claim */}
          <div className="rounded-md border border-[#1F2937] bg-[#0D1117] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-[#F1F5F9]">
                <Lock className="h-3.5 w-3.5 text-amber-400" />
                <span>Self-Hosted Operator Passcode</span>
              </div>
              <span className="font-mono text-[11px] text-[#94A3B8]">
                Status:{' '}
                {authStatus.source === 'env'
                  ? 'Protected via SLABGRAPH_ADMIN_PASSCODE'
                  : authStatus.source === 'claimed'
                    ? 'Protected via Claimed Passcode (scrypt)'
                    : 'Open Local Mode (Optional)'}
              </span>
            </div>

            {!authStatus.locked ? (
              <form onSubmit={handleClaimPasscode} className="mt-3 flex flex-col gap-2 sm:flex-row">
                <input
                  type="password"
                  value={claimPasscode}
                  onChange={(e) => setClaimPasscode(e.target.value)}
                  placeholder="Optional: set an 8+ character operator passcode to lock writes on your server"
                  className="flex-1 rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={claiming}
                  className="rounded-md border border-amber-500/40 bg-amber-950/30 px-4 py-2 text-xs font-medium text-amber-300 transition-colors hover:border-amber-400 disabled:opacity-50 whitespace-nowrap shrink-0"
                >
                  {claiming ? 'Locking...' : 'Claim Admin Passcode'}
                </button>
              </form>
            ) : (
              <p className="mt-2 text-xs text-emerald-400">
                Write routes are protected. Only signed-in operators (or Hermes with HERMES_BRIDGE_TOKEN) can mutate the graph.
              </p>
            )}

            {claimStatus && (
              <p
                className={`mt-2 text-xs ${
                  claimStatus.ok ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {claimStatus.msg}
              </p>
            )}
          </div>

          <div className="flex justify-end border-t border-[#1F2937] pt-4">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500"
            >
              <span>Continue to Catalog Setup</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </section>
      )}

      {/* Step 2: Register Canonical Collectibles or Bulk Import JSON */}
      {step === 2 && (
        <section className="space-y-5 rounded-lg border border-[#1F2937] bg-[#11161D] p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-[#F1F5F9]">
                Step 2 · Add Your Real Canonical Collectibles ({state.assets.length} indexed)
              </h2>
              <p className="mt-0.5 text-xs text-[#94A3B8]">
                Register individual TCG or sports cards below, or paste a JSON catalog to bulk-seed ground-truth nodes.
              </p>
            </div>
            <div className="inline-flex rounded-md border border-[#1F2937] bg-[#0D1117] p-0.5">
              <button
                type="button"
                onClick={() => setCatalogTab('SINGLE')}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  catalogTab === 'SINGLE'
                    ? 'bg-[#161D27] text-emerald-400'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                Single Asset Form
              </button>
              <button
                type="button"
                onClick={() => setCatalogTab('IMPORT')}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  catalogTab === 'IMPORT'
                    ? 'bg-[#161D27] text-emerald-400'
                    : 'text-[#94A3B8] hover:text-[#F1F5F9]'
                }`}
              >
                Bulk JSON Import
              </button>
            </div>
          </div>

          {assetFeedback && (
            <div
              className={`rounded-md border px-3.5 py-2.5 text-xs ${
                assetFeedback.ok
                  ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                  : 'border-red-500/40 bg-red-950/35 text-red-200'
              }`}
            >
              {assetFeedback.msg}
            </div>
          )}

          {catalogTab === 'SINGLE' ? (
            <form onSubmit={handleAddSingleAsset} className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="block text-xs text-[#CBD5E1]">Segment</label>
                  <select
                    value={segment}
                    onChange={(e) => setSegment(e.target.value as MarketSegment)}
                    className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="TCG">Trading Card Game (TCG)</option>
                    <option value="SPORTS">Sports Collectible</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[#CBD5E1]">Franchise / Sport *</label>
                  <input
                    type="text"
                    required
                    value={franchise}
                    onChange={(e) => setFranchise(e.target.value)}
                    placeholder={segment === 'TCG' ? 'Pokémon, MTG, One Piece...' : 'Basketball, Baseball, F1...'}
                    className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#CBD5E1]">Subject (Player / Character) *</label>
                  <input
                    type="text"
                    required
                    value={subjectName}
                    onChange={(e) => setSubjectName(e.target.value)}
                    placeholder="e.g. Charizard, Michael Jordan"
                    className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className="block text-xs text-[#CBD5E1]">Canonical Card Title *</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Charizard Holo or Fleer Rookie"
                    className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#CBD5E1]">Set / Release Name *</label>
                  <input
                    type="text"
                    required
                    value={setName}
                    onChange={(e) => setSetName(e.target.value)}
                    placeholder="e.g. Base Set Unlimited"
                    className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs text-[#CBD5E1]">Year</label>
                  <input
                    type="number"
                    value={releaseYear}
                    onChange={(e) => setReleaseYear(e.target.value)}
                    className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 font-mono text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#CBD5E1]">Card #</label>
                  <input
                    type="text"
                    value={cardNumber}
                    onChange={(e) => setCardNumber(e.target.value)}
                    placeholder="#4/102"
                    className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[#CBD5E1]">Variant</label>
                  <input
                    type="text"
                    value={variant}
                    onChange={(e) => setVariant(e.target.value)}
                    placeholder="Holo / Silver Prizm"
                    className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Optional opening real comp */}
              <div className="rounded-md border border-[#1F2937] bg-[#0D1117] p-3.5">
                <div className="text-[11px] font-medium text-[#CBD5E1]">
                  Optional: Opening Verified Comp (leave price blank if awaiting live connector feeds)
                </div>
                <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={initialPrice}
                    onChange={(e) => setInitialPrice(e.target.value)}
                    placeholder="Realized USD (optional)"
                    className="rounded-md border border-[#243040] bg-[#090C10] px-3 py-1.5 font-mono text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
                  />
                  <select
                    value={initialGrade}
                    onChange={(e) => setInitialGrade(e.target.value as GradeLabel)}
                    className="rounded-md border border-[#243040] bg-[#090C10] px-3 py-1.5 text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="PSA 10">PSA 10</option>
                    <option value="BGS 9.5">BGS 9.5</option>
                    <option value="SGC 10">SGC 10</option>
                    <option value="PSA 9">PSA 9</option>
                    <option value="Raw NM">Raw NM</option>
                  </select>
                  <select
                    value={initialVenue}
                    onChange={(e) => setInitialVenue(e.target.value as MarketplaceId)}
                    className="rounded-md border border-[#243040] bg-[#090C10] px-3 py-1.5 text-xs text-[#F1F5F9] focus:border-emerald-500 focus:outline-none"
                  >
                    {state.marketplaces.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <button
                type="submit"
                disabled={addingAsset}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <Plus className="h-3.5 w-3.5" />
                <span>{addingAsset ? 'Saving...' : 'Save Canonical Collectible'}</span>
              </button>
            </form>
          ) : (
            <form onSubmit={handleBulkImport} className="space-y-3">
              <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                <span>Paste JSON containing an &quot;assets&quot; array (and optional &quot;sales&quot; array):</span>
                <button
                  type="button"
                  onClick={() => setImportJson(SAMPLE_IMPORT_SCHEMA)}
                  className="font-mono text-[11px] text-emerald-400 hover:text-emerald-300"
                >
                  Insert Schema Template
                </button>
              </div>
              <textarea
                rows={8}
                value={importJson}
                onChange={(e) => setImportJson(e.target.value)}
                spellCheck={false}
                placeholder={SAMPLE_IMPORT_SCHEMA}
                className="w-full rounded-md border border-[#243040] bg-[#090C10] p-3 font-mono text-[11px] text-emerald-300 placeholder-[#475569] focus:border-emerald-500 focus:outline-none"
              />
              <button
                type="submit"
                disabled={importing || !importJson.trim()}
                className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <Upload className="h-3.5 w-3.5" />
                <span>{importing ? 'Importing...' : 'Import Catalog JSON'}</span>
              </button>
            </form>
          )}

          <div className="flex items-center justify-between border-t border-[#1F2937] pt-4">
            <button
              type="button"
              onClick={() => setStep(1)}
              className="rounded-md border border-[#243040] px-3.5 py-2 text-xs font-medium text-[#CBD5E1] hover:bg-[#161D27]"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(3)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500"
            >
              <span>Continue to Connectors & Alerts</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </section>
      )}

      {/* Step 3: Live Alert Channels & External Scraper Webhook Connector */}
      {step === 3 && (
        <section className="space-y-5 rounded-lg border border-[#1F2937] bg-[#11161D] p-6">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              Step 3 · Connect API Scrapers, Webhooks & Live Alert Channels
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Point your marketplace scrapers (eBay, TCGplayer, Cardmarket, PWCC, Goldin) or Hermes skills at the Swarm ingestion endpoint below, and verify live Discord / Telegram / Hermes alerts.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {(
              [
                {
                  label: 'Discord Webhook' as const,
                  status: state.alertChannels.discord,
                },
                {
                  label: 'Telegram Bot' as const,
                  status: state.alertChannels.telegram,
                },
                {
                  label: 'Hermes Webhook' as const,
                  status: state.alertChannels.hermes,
                },
              ]
            ).map((ch) => (
              <div
                key={ch.label}
                className="flex flex-col justify-between rounded-md border border-[#1F2937] bg-[#0D1117] p-4"
              >
                <div>
                  <div className="flex items-center justify-between text-xs font-medium text-[#F1F5F9]">
                    <span>{ch.label}</span>
                    <span
                      className={`font-mono text-[11px] ${
                        ch.status.configured ? 'text-emerald-400' : 'text-[#64748B]'
                      }`}
                    >
                      {ch.status.configured ? 'Ready' : 'Not set'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[11px] text-[#94A3B8]">
                    {ch.status.hint}
                    {!ch.status.configured ? ' You can also enter it below.' : ''}
                  </p>
                </div>
                <div className="mt-3 space-y-2">
                  {editingChannel === ch.label && (
                    <div className="space-y-2 rounded border border-[#243040] bg-[#090C10] p-2">
                      {(CHANNEL_SECRET_FIELDS[ch.label] ?? []).map((field) => (
                        <label key={field.key} className="block">
                          <span className="text-[10px] text-[#94A3B8]">{field.label}</span>
                          <input
                            type="password"
                            autoComplete="off"
                            value={secretDrafts[field.key] ?? ''}
                            onChange={(e) =>
                              setSecretDrafts((prev) => ({
                                ...prev,
                                [field.key]: e.target.value,
                              }))
                            }
                            placeholder={field.placeholder}
                            className="mt-1 w-full rounded border border-[#243040] bg-[#0D1117] px-2 py-1 text-[11px] text-[#E2E8F0] outline-none focus:border-emerald-500/50"
                          />
                        </label>
                      ))}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={savingSecret}
                          onClick={() => handleSaveSecret(ch.label)}
                          className="rounded border border-emerald-600/50 bg-emerald-950/40 px-2 py-1 text-[11px] font-medium text-emerald-200 hover:border-emerald-400 disabled:opacity-40"
                        >
                          {savingSecret ? 'Saving...' : 'Save on server'}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEditingChannel(null);
                            setSecretDrafts({});
                          }}
                          className="rounded border border-[#243040] px-2 py-1 text-[11px] text-[#94A3B8] hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEditingChannel(editingChannel === ch.label ? null : ch.label);
                        setSecretDrafts({});
                      }}
                      className="rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-[11px] font-medium text-[#CBD5E1] hover:border-emerald-500/50"
                    >
                      {ch.status.configured ? 'Update' : 'Configure'}
                    </button>
                    <button
                      type="button"
                      disabled={!ch.status.configured || testingChannel !== null}
                      onClick={() => handleTestChannel(ch.label)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-[11px] font-medium text-[#E2E8F0] hover:border-emerald-500/50 disabled:opacity-40"
                    >
                      <Send className="h-3 w-3" />
                      <span>
                        {testingChannel === ch.label ? 'Sending...' : 'Send Live Test Ping'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {channelFeedback && (
            <div
              className={`rounded-md border px-3.5 py-2.5 text-xs ${
                channelFeedback.ok
                  ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                  : 'border-red-500/40 bg-red-950/35 text-red-200'
              }`}
            >
              {channelFeedback.msg}
            </div>
          )}

          {/* Ready-to-connect Ingestion Webhook Snippet */}
          <div className="space-y-2 rounded-md border border-[#1F2937] bg-[#0D1117] p-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-[#F1F5F9]">
                Inbound Marketplace Comp Webhook (POST /api/swarm/ingest)
              </span>
              <button
                type="button"
                onClick={handleCopyCurl}
                className="inline-flex items-center gap-1 rounded border border-[#243040] bg-[#161D27] px-2.5 py-1 text-[11px] text-[#CBD5E1] hover:text-white"
              >
                {copiedCurl ? (
                  <Check className="h-3 w-3 text-emerald-400" />
                ) : (
                  <Copy className="h-3 w-3" />
                )}
                <span>{copiedCurl ? 'Copied' : 'Copy cURL'}</span>
              </button>
            </div>
            <pre className="overflow-x-auto rounded border border-[#1F2937] bg-[#090C10] p-3 font-mono text-[11px] leading-relaxed text-emerald-300/90">
              {connectorCurl}
            </pre>
            <p className="text-[11px] text-[#94A3B8]">
              Want to stage raw comps for manual review before LLM triage? POST the same JSON payload to <span className="font-mono text-[#E2E8F0]">/api/swarm/queue</span> instead.
            </p>
          </div>

          <div className="flex items-center justify-between border-t border-[#1F2937] pt-4">
            <button
              type="button"
              onClick={() => setStep(2)}
              className="rounded-md border border-[#243040] px-3.5 py-2 text-xs font-medium text-[#CBD5E1] hover:bg-[#161D27]"
            >
              Back
            </button>
            <button
              type="button"
              onClick={() => setStep(4)}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-4 py-2 text-xs font-medium text-white hover:bg-emerald-500"
            >
              <span>Continue to Vector Index & Launch</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </section>
      )}

      {/* Step 4: Hybrid Vector Embeddings & Launch */}
      {step === 4 && (
        <section className="space-y-5 rounded-lg border border-[#1F2937] bg-[#11161D] p-6">
          <div>
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              Step 4 · Build Hybrid Vector Index & Launch Production Terminal
            </h2>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Generate persistent semantic embeddings ({state.vectorIndex.model}) for your canonical collectibles so Entity Resolution and GraphRAG scale smoothly as your catalog grows.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-[#1F2937] bg-[#0D1117] p-4">
            <div className="space-y-1 text-xs">
              <div className="font-semibold text-[#F1F5F9]">
                Vector Index Status · {state.vectorIndex.indexedAssets}/{state.vectorIndex.totalAssets} assets embedded
              </div>
              <div className="font-mono text-[11px] text-[#94A3B8]">
                Provider: {state.vectorIndex.provider} · Model: {state.vectorIndex.model}
              </div>
            </div>
            <button
              type="button"
              disabled={reindexing || state.assets.length === 0 || !state.vectorIndex.configured}
              onClick={handleBuildVectorIndex}
              className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-950/30 px-3.5 py-2 text-xs font-medium text-emerald-300 hover:border-emerald-400 disabled:opacity-40 whitespace-nowrap shrink-0"
            >
              <Sparkles className="h-3.5 w-3.5" />
              <span>{reindexing ? 'Embedding Nodes...' : 'Build Vector Index'}</span>
            </button>
          </div>

          {indexFeedback && (
            <div
              className={`flex items-start gap-2 rounded-md border px-3.5 py-2.5 text-xs ${
                indexFeedback.ok
                  ? 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
                  : 'border-red-500/40 bg-red-950/35 text-red-200'
              }`}
            >
              {!indexFeedback.ok && <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />}
              <span>{indexFeedback.msg}</span>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#1F2937] bg-[#0D1117] p-4 text-xs">
            <div>
              <div className="font-semibold text-[#F1F5F9]">Backup & Portability</div>
              <div className="mt-0.5 text-[#94A3B8]">
                Download a complete sanitized JSON snapshot of your persistent graph & portfolio at any time.
              </div>
            </div>
            <button
              type="button"
              disabled={exporting}
              onClick={handleExportBackup}
              className="inline-flex items-center gap-1.5 rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-[#E2E8F0] hover:border-emerald-500/50 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" />
              <span>{exporting ? 'Exporting...' : 'Export JSON Backup'}</span>
            </button>
          </div>

          <div className="flex items-center justify-between border-t border-[#1F2937] pt-4">
            <button
              type="button"
              onClick={() => setStep(3)}
              className="rounded-md border border-[#243040] px-3.5 py-2 text-xs font-medium text-[#CBD5E1] hover:bg-[#161D27]"
            >
              Back
            </button>
            <button
              type="button"
              disabled={finishing}
              onClick={handleFinishOnboarding}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-5 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              <span>{finishing ? 'Launching...' : 'Complete Setup & Open Terminal'}</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
