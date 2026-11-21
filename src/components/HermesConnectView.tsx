import { useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  Check,
  CheckCircle2,
  Copy,
  Play,
  Radio,
  Send,
  ShieldCheck,
  Terminal,
  Webhook,
} from 'lucide-react';
import type {
  GraphStatePayload,
  HermesStatusPayload,
  HermesToolRunResult,
  HermesWebhookDispatchResult,
  SwarmRoutingConfig,
} from '../types/graph.ts';
import { apiFetch } from '../utils/apiClient.ts';

interface HermesConnectViewProps {
  routing: SwarmRoutingConfig;
  onUpdateRouting: (patch: Partial<SwarmRoutingConfig>) => Promise<void>;
  onRefreshState: (nextState: GraphStatePayload) => void;
}

interface ChatTurn {
  id: string;
  role: 'user' | 'hermes';
  content: string;
  meta?: string;
}

type SnippetTab = 'env' | 'yaml' | 'secrets' | 'curl';

export function HermesConnectView({
  routing,
  onUpdateRouting,
  onRefreshState,
}: HermesConnectViewProps) {
  const [status, setStatus] = useState<HermesStatusPayload | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);

  // Handshake & Webhook test feedback
  const [pinging, setPinging] = useState(false);
  const [pingResult, setPingResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const [dispatchingWebhook, setDispatchingWebhook] = useState(false);
  const [webhookFeedback, setWebhookFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  const [routingAll, setRoutingAll] = useState(false);
  const [routingMsg, setRoutingMsg] = useState<string | null>(null);

  // Hermes Console Chat
  const [prompt, setPrompt] = useState('');
  const [attachGraphContext, setAttachGraphContext] = useState(true);
  const [sendingChat, setSendingChat] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<ChatTurn[]>([]);

  // Inbound Tool Bridge Sandbox
  const [selectedToolName, setSelectedToolName] = useState(
    'scan_arbitrage_spreads'
  );
  const [toolArgsJson, setToolArgsJson] = useState(
    JSON.stringify({ segment: 'ALL', minSpreadPct: 8, includeFees: true }, null, 2)
  );
  const [runningTool, setRunningTool] = useState(false);
  const [toolError, setToolError] = useState<string | null>(null);
  const [toolResult, setToolResult] = useState<HermesToolRunResult | null>(null);

  // Blueprint copy tabs
  const [snippetTab, setSnippetTab] = useState<SnippetTab>('env');
  const [copiedTab, setCopiedTab] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/hermes/status')
      .then((r) => r.json())
      .then((data: HermesStatusPayload) => {
        setStatus(data);
        const initialTool =
          data.tools.find((t) => t.name === 'scan_arbitrage_spreads') ||
          data.tools[0];
        if (initialTool) {
          setSelectedToolName(initialTool.name);
          setToolArgsJson(JSON.stringify(initialTool.sampleArgs, null, 2));
        }
      })
      .catch(() => {})
      .finally(() => setLoadingStatus(false));
  }, []);

  async function handlePingHermes() {
    setPinging(true);
    setPingResult(null);
    try {
      const res = await apiFetch('/api/hermes/ping', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Handshake failed.');
      setPingResult({
        ok: true,
        message: `${json.detail} (${json.latencyMs}ms)`,
      });
    } catch (err) {
      setPingResult({
        ok: false,
        message:
          err instanceof Error ? err.message : 'Unable to reach Hermes Gateway.',
      });
    } finally {
      setPinging(false);
    }
  }

  async function handleRouteAllToHermes() {
    setRoutingAll(true);
    setRoutingMsg(null);
    try {
      await onUpdateRouting({
        entityResolution: 'hermes',
        outlierFilter: 'hermes',
        catalystSentiment: 'hermes',
        graphRagSynthesis: 'hermes',
      });
      setRoutingMsg('All 4 Swarm agent roles are now routed to your Hermes Agent Gateway.');
    } catch (err) {
      setRoutingMsg(
        err instanceof Error ? err.message : 'Could not switch routing to Hermes.'
      );
    } finally {
      setRoutingAll(false);
    }
  }

  async function handleTestWebhook() {
    setDispatchingWebhook(true);
    setWebhookFeedback(null);
    try {
      const res = await apiFetch('/api/hermes/webhook/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: 'HERMES_TEST_EVENT' }),
      });
      const json = (await res.json()) as HermesWebhookDispatchResult & {
        error?: string;
      };
      if (!res.ok) throw new Error(json.error || 'Webhook delivery failed.');
      setWebhookFeedback({
        ok: true,
        message: `HTTP ${json.httpStatus} · ${json.signed ? 'HMAC-SHA256 signed' : 'Unsigned'} · ${json.latencyMs}ms`,
      });
    } catch (err) {
      setWebhookFeedback({
        ok: false,
        message:
          err instanceof Error
            ? err.message
            : 'Unable to dispatch webhook to Hermes.',
      });
    } finally {
      setDispatchingWebhook(false);
    }
  }

  async function handleSendChat(e: FormEvent) {
    e.preventDefault();
    const clean = prompt.trim();
    if (!clean) return;
    setChatError(null);
    setSendingChat(true);
    const userTurn: ChatTurn = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: clean,
    };
    setChatHistory((prev) => [...prev, userTurn]);
    setPrompt('');

    try {
      const res = await apiFetch('/api/hermes/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: clean,
          includeGraphSnapshot: attachGraphContext,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Hermes chat failed.');
      setChatHistory((prev) => [
        ...prev,
        {
          id: `h-${Date.now()}`,
          role: 'hermes',
          content: json.reply,
          meta: `${json.model} · ${json.latencyMs}ms`,
        },
      ]);
    } catch (err) {
      setChatError(
        err instanceof Error ? err.message : 'Hermes Gateway request failed.'
      );
    } finally {
      setSendingChat(false);
    }
  }

  async function handleExecuteToolPreview(e: FormEvent) {
    e.preventDefault();
    setToolError(null);
    let parsedArgs: Record<string, unknown> = {};
    try {
      parsedArgs = JSON.parse(toolArgsJson || '{}');
    } catch {
      setToolError('Arguments must be valid JSON.');
      return;
    }

    setRunningTool(true);
    try {
      const res = await apiFetch('/api/hermes/tools/preview', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Requested-With': 'SlabGraph-UI',
        },
        body: JSON.stringify({
          tool: selectedToolName,
          args: parsedArgs,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Tool execution failed.');
      setToolResult({
        tool: json.tool,
        executedAt: json.executedAt,
        latencyMs: json.latencyMs,
        result: json.result,
      });
      if (json.state) onRefreshState(json.state);
    } catch (err) {
      setToolError(err instanceof Error ? err.message : 'Tool failed.');
    } finally {
      setRunningTool(false);
    }
  }

  async function handleCopy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedTab(key);
      setTimeout(() => setCopiedTab(null), 1800);
    } catch {
      // Clipboard fallback ignored
    }
  }

  const allRoutedToHermes =
    routing.entityResolution === 'hermes' &&
    routing.outlierFilter === 'hermes' &&
    routing.catalystSentiment === 'hermes' &&
    routing.graphRagSynthesis === 'hermes';

  const secretsChecklist = `# Add these in Settings > Secrets (server-side only — never in browser code)
HERMES_API_URL="https://<your-hermes-tunnel-or-host>/v1"
HERMES_API_KEY="<matching API_SERVER_KEY from ~/.hermes/.env>"
HERMES_MODEL="hermes-agent"

# Optional: Receive real-time SlabGraph Layer 3 Alerts in Hermes Gateway (:8644)
HERMES_WEBHOOK_URL="https://<your-hermes-webhook-host>/webhooks/slabgraph_alerts"
HERMES_WEBHOOK_SECRET="<matching WEBHOOK_SECRET for HMAC-SHA256 signing>"

# Recommended: Require Bearer auth when Hermes calls SlabGraph's /api/hermes/tools/execute
HERMES_BRIDGE_TOKEN="<generate-a-strong-random-token>"`;

  const activeSnippetText = !status
    ? ''
    : snippetTab === 'env'
      ? status.snippets.hermesEnv
      : snippetTab === 'yaml'
        ? status.snippets.hermesConfigYaml
        : snippetTab === 'secrets'
          ? secretsChecklist
          : status.snippets.curlBridge;

  if (loadingStatus || !status) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-36 rounded-lg border border-[#1F2937] bg-[#11161D]" />
          ))}
        </div>
        <div className="h-80 rounded-lg border border-[#1F2937] bg-[#11161D]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* 3-Channel Bidirectional Hermes Connection Strip */}
      <section className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-[#1F2937] bg-[#1F2937] lg:grid-cols-3">
        {/* Channel 1: Outbound API Server (:8642/v1) */}
        <div className="flex flex-col justify-between bg-[#11161D] p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F1F5F9]">
                <Radio className="h-3.5 w-3.5 text-emerald-400" />
                <span>Hermes API Gateway</span>
              </span>
              <span
                className={`font-mono text-[11px] font-medium ${
                  status.apiGateway.configured
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }`}
              >
                {status.apiGateway.configured ? 'Configured' : 'Awaiting Env'}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-[#94A3B8]">
              Routes Swarm Agent handoffs & interactive terminal prompts to your Hermes API server (<span className="font-mono text-[#CBD5E1]">:8642/v1</span>).
            </p>
            <div className="mt-3 space-y-1 font-mono text-[11px] text-[#94A3B8]">
              <div className="truncate">
                Endpoint: <span className="text-[#E2E8F0]">{status.apiGateway.endpointPreview || 'HERMES_API_URL unset'}</span>
              </div>
              <div>
                Model: <span className="text-[#E2E8F0]">{status.apiGateway.model}</span> · Auth:{' '}
                <span className="text-[#E2E8F0]">
                  {status.apiGateway.apiKeyConfigured ? 'Bearer Key Set' : 'No Key Set'}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2 border-t border-[#1F2937] pt-3">
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={pinging}
                onClick={handlePingHermes}
                className="rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-[#E2E8F0] hover:border-emerald-500/60 hover:text-emerald-300 disabled:opacity-40 whitespace-nowrap"
              >
                {pinging ? 'Testing...' : 'Test Handshake'}
              </button>
              <button
                type="button"
                disabled={!status.apiGateway.configured || routingAll || allRoutedToHermes}
                onClick={handleRouteAllToHermes}
                className="rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-emerald-300 hover:border-emerald-500/60 disabled:opacity-40 whitespace-nowrap"
              >
                {allRoutedToHermes
                  ? 'Swarm Routed to Hermes'
                  : routingAll
                    ? 'Routing...'
                    : 'Route Swarm to Hermes'}
              </button>
            </div>
            {pingResult && (
              <p
                className={`text-[11px] ${
                  pingResult.ok ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {pingResult.message}
              </p>
            )}
            {routingMsg && (
              <p className="text-[11px] text-emerald-400">{routingMsg}</p>
            )}
          </div>
        </div>

        {/* Channel 2: Outbound Webhook Gateway (:8644/webhooks) */}
        <div className="flex flex-col justify-between bg-[#11161D] p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F1F5F9]">
                <Webhook className="h-3.5 w-3.5 text-amber-400" />
                <span>Hermes Webhook Gateway</span>
              </span>
              <span
                className={`font-mono text-[11px] font-medium ${
                  status.webhookGateway.configured
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }`}
              >
                {status.webhookGateway.configured ? 'Configured' : 'Awaiting Env'}
              </span>
            </div>
            <p className="mt-1.5 text-xs text-[#94A3B8]">
              Dispatches HMAC-SHA256 signed arbitrage, breakout, and outlier alerts directly into Hermes autonomous runs (<span className="font-mono text-[#CBD5E1]">:8644</span>).
            </p>
            <div className="mt-3 space-y-1 font-mono text-[11px] text-[#94A3B8]">
              <div className="truncate">
                Target: <span className="text-[#E2E8F0]">{status.webhookGateway.endpointPreview || 'HERMES_WEBHOOK_URL unset'}</span>
              </div>
              <div>
                Signature:{' '}
                <span className="text-[#E2E8F0]">
                  {status.webhookGateway.hmacSigningEnabled
                    ? 'HMAC-SHA256 Enabled'
                    : 'HERMES_WEBHOOK_SECRET unset'}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-4 space-y-2 border-t border-[#1F2937] pt-3">
            <button
              type="button"
              disabled={dispatchingWebhook}
              onClick={handleTestWebhook}
              className="rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-[#E2E8F0] hover:border-amber-500/60 hover:text-amber-300 disabled:opacity-40 whitespace-nowrap"
            >
              {dispatchingWebhook ? 'Dispatching...' : 'Send Test Webhook Event'}
            </button>
            {webhookFeedback && (
              <p
                className={`text-[11px] ${
                  webhookFeedback.ok ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {webhookFeedback.message}
              </p>
            )}
          </div>
        </div>

        {/* Channel 3: Inbound SlabGraph Tool Bridge */}
        <div className="flex flex-col justify-between bg-[#11161D] p-5">
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#F1F5F9]">
                <ArrowRightLeft className="h-3.5 w-3.5 text-sky-400" />
                <span>Inbound Tool Bridge</span>
              </span>
              <span className="font-mono text-[11px] font-medium text-emerald-400">
                Active · {status.inboundBridge.toolCount} Tools
              </span>
            </div>
            <p className="mt-1.5 text-xs text-[#94A3B8]">
              Lets your Hermes Agent query SlabGraph's deterministic valuations, arbitrage scanner, Cypher traversals, and ingestion pipeline.
            </p>
            <div className="mt-3 space-y-1 font-mono text-[11px] text-[#94A3B8]">
              <div className="truncate">
                Manifest: <span className="text-[#E2E8F0]">{status.inboundBridge.manifestUrl}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                <span className="text-[#E2E8F0]">
                  {status.inboundBridge.bearerTokenProtected
                    ? 'Protected by HERMES_BRIDGE_TOKEN'
                    : 'Set HERMES_BRIDGE_TOKEN before public sharing'}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-4 border-t border-[#1F2937] pt-3">
            <button
              type="button"
              onClick={() => handleCopy('manifest', status.inboundBridge.manifestUrl)}
              className="inline-flex items-center gap-1.5 rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs font-medium text-[#E2E8F0] hover:border-emerald-500/60"
            >
              {copiedTab === 'manifest' ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Manifest URL Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy Tool Manifest URL</span>
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Interactive Split: Hermes Agent Console + Inbound Tool Bridge Sandbox */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Left: Live Hermes Agent Command Console (6 cols) */}
        <section className="flex flex-col rounded-lg border border-[#1F2937] bg-[#11161D] xl:col-span-6">
          <div className="flex items-center justify-between border-b border-[#1F2937] px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-emerald-400" />
              <div>
                <h2 className="text-sm font-semibold text-[#F1F5F9]">
                  Hermes Agent Command Console
                </h2>
                <p className="text-[11px] text-[#94A3B8]">
                  Direct terminal session over your server-side Hermes API Gateway.
                </p>
              </div>
            </div>
            <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] text-[#CBD5E1]">
              <input
                type="checkbox"
                checked={attachGraphContext}
                onChange={(e) => setAttachGraphContext(e.target.checked)}
                className="h-3.5 w-3.5 accent-emerald-500"
              />
              <span>Inject Live Graph Snapshot</span>
            </label>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto p-5 min-h-[260px] max-h-[380px] bg-[#090C10]">
            {chatHistory.length === 0 ? (
              <div className="space-y-3 text-xs text-[#94A3B8]">
                <p>
                  Send a command to your Hermes Agent with SlabGraph's deterministic market context attached.
                </p>
                {!status.apiGateway.configured && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-950/20 p-3.5 text-amber-200/90">
                    <div className="font-medium text-amber-300">
                      Hermes API Gateway Not Connected Yet
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-amber-200/80">
                      Start <span className="font-mono text-amber-100">hermes gateway</span> locally (or on your VPS), expose port <span className="font-mono text-amber-100">8642</span> over HTTPS (e.g. Cloudflare Tunnel / Tailscale Funnel), and add <span className="font-mono text-amber-100">HERMES_API_URL</span> + <span className="font-mono text-amber-100">HERMES_API_KEY</span> in <strong>Settings &gt; Secrets</strong>.
                    </p>
                  </div>
                )}
              </div>
            ) : (
              chatHistory.map((turn) => (
                <div
                  key={turn.id}
                  className={`rounded-md border p-3 text-xs ${
                    turn.role === 'user'
                      ? 'border-[#243040] bg-[#11161D] text-[#F1F5F9]'
                      : 'border-emerald-500/30 bg-[#0D1614] text-[#E2E8F0]'
                  }`}
                >
                  <div className="flex items-center justify-between text-[11px] text-[#94A3B8]">
                    <span className="font-mono font-medium">
                      {turn.role === 'user' ? 'SlabGraph Operator' : 'Hermes Agent'}
                    </span>
                    {turn.meta && <span className="font-mono">{turn.meta}</span>}
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap leading-relaxed">
                    {turn.content}
                  </p>
                </div>
              ))
            )}
          </div>

          {chatError && (
            <div className="flex items-start gap-2 border-t border-red-500/30 bg-red-950/35 px-4 py-2.5 text-xs text-red-200">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
              <span>{chatError}</span>
            </div>
          )}

          <form
            onSubmit={handleSendChat}
            className="flex gap-2 border-t border-[#1F2937] p-4"
          >
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ask Hermes Agent to evaluate spreads, verify comps, or run a tool..."
              className="flex-1 rounded-md border border-[#243040] bg-[#090C10] px-3 py-2 text-xs text-[#F1F5F9] placeholder-[#64748B] focus:border-emerald-500 focus:outline-none"
            />
            <button
              type="submit"
              disabled={sendingChat}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50 whitespace-nowrap shrink-0"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{sendingChat ? 'Sending...' : 'Send'}</span>
            </button>
          </form>
        </section>

        {/* Right: Inbound Tool Bridge Sandbox (6 cols) */}
        <section className="flex flex-col rounded-lg border border-[#1F2937] bg-[#11161D] xl:col-span-6">
          <div className="border-b border-[#1F2937] px-5 py-3.5">
            <h2 className="text-sm font-semibold text-[#F1F5F9]">
              Inbound Tool Bridge Sandbox (Hermes → SlabGraph)
            </h2>
            <p className="mt-0.5 text-[11px] text-[#94A3B8]">
              Test the exact deterministic tools exposed to Hermes Agent at <span className="font-mono text-[#CBD5E1]">/api/hermes/tools/execute</span>.
            </p>
          </div>

          <form onSubmit={handleExecuteToolPreview} className="space-y-3 p-5">
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {status.tools.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => {
                    setSelectedToolName(t.name);
                    setToolArgsJson(JSON.stringify(t.sampleArgs, null, 2));
                    setToolError(null);
                  }}
                  className={`rounded-md border p-2.5 text-left transition-colors ${
                    selectedToolName === t.name
                      ? 'border-emerald-500/60 bg-[#161D27] text-[#F1F5F9]'
                      : 'border-[#1F2937] bg-[#0D1117] text-[#94A3B8] hover:text-[#E2E8F0]'
                  }`}
                >
                  <div className="font-mono text-xs font-medium">{t.name}</div>
                  <div className="mt-1 line-clamp-2 text-[11px] text-[#64748B]">
                    {t.description}
                  </div>
                </button>
              ))}
            </div>

            <div>
              <label className="block text-xs font-medium text-[#CBD5E1]">
                Tool Call Arguments (JSON)
              </label>
              <textarea
                rows={4}
                value={toolArgsJson}
                onChange={(e) => setToolArgsJson(e.target.value)}
                className="mt-1 w-full rounded-md border border-[#243040] bg-[#090C10] p-2.5 font-mono text-xs text-emerald-300/90 focus:border-emerald-500 focus:outline-none"
              />
            </div>

            {toolError && (
              <div className="rounded border border-red-500/40 bg-red-950/35 px-3 py-2 text-xs text-red-200">
                {toolError}
              </div>
            )}

            <button
              type="submit"
              disabled={runningTool}
              className="inline-flex items-center gap-1.5 rounded-md bg-emerald-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{runningTool ? 'Executing...' : `Execute ${selectedToolName}`}</span>
            </button>

            {toolResult && (
              <div className="rounded-md border border-[#1F2937] bg-[#090C10] p-3">
                <div className="flex items-center justify-between font-mono text-[11px] text-[#94A3B8]">
                  <span className="inline-flex items-center gap-1 text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    <span>{toolResult.tool} returned deterministic payload</span>
                  </span>
                  <span>{toolResult.latencyMs}ms</span>
                </div>
                <pre className="mt-2 max-h-56 overflow-auto font-mono text-[11px] leading-relaxed text-[#CBD5E1]">
                  {JSON.stringify(toolResult.result, null, 2)}
                </pre>
              </div>
            )}
          </form>
        </section>
      </div>

      {/* Copy-Ready Hermes Gateway Configuration Blueprint */}
      <section className="overflow-hidden rounded-lg border border-[#1F2937] bg-[#11161D]">
        <div className="flex flex-col gap-3 border-b border-[#1F2937] px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-[#F1F5F9]">
              Hermes Agent Setup & Configuration Snippets
            </h3>
            <p className="mt-0.5 text-xs text-[#94A3B8]">
              Copy these directly into your Hermes Agent home directory and server Secrets panel.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-md border border-[#1F2937] bg-[#0D1117] p-0.5">
              {(
                [
                  { id: 'env', label: '~/.hermes/.env' },
                  { id: 'yaml', label: 'config.yaml' },
                  { id: 'secrets', label: 'Server Secrets' },
                  { id: 'curl', label: 'curl Test' },
                ] as const
              ).map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setSnippetTab(tab.id)}
                  className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors whitespace-nowrap ${
                    snippetTab === tab.id
                      ? 'bg-[#1F2937] text-[#F1F5F9]'
                      : 'text-[#94A3B8] hover:text-[#E2E8F0]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => handleCopy(snippetTab, activeSnippetText)}
              className="inline-flex items-center gap-1.5 rounded border border-[#243040] bg-[#161D27] px-3 py-1.5 text-xs text-[#E2E8F0] hover:border-emerald-500/50 whitespace-nowrap shrink-0"
            >
              {copiedTab === snippetTab ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  <span>Copy</span>
                </>
              )}
            </button>
          </div>
        </div>
        <pre className="overflow-x-auto bg-[#090C10] p-4 font-mono text-xs leading-relaxed text-emerald-300/90">
          {activeSnippetText}
        </pre>
      </section>
    </div>
  );
}
