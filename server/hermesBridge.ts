import crypto from 'crypto';
import type {
  HermesStatusPayload,
  HermesToolDefinition,
  HermesToolRunResult,
  HermesWebhookDispatchResult,
  MarketplaceId,
} from '../src/types/graph.ts';
import { graphEngine } from './graphEngine.ts';

const BLOCKED_HOSTS = new Set([
  '169.254.169.254',
  'metadata.google.internal',
  'metadata.goog',
  '0.0.0.0',
]);

export function validateHermesOutboundUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('Configured Hermes URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Hermes URL must use http:// or https:// scheme.');
  }
  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.startsWith('169.254.')) {
    throw new Error('Configured Hermes URL points to a restricted metadata host.');
  }
  return parsed;
}

export const HERMES_TOOL_DEFINITIONS: HermesToolDefinition[] = [
  {
    name: 'get_collectible_valuation',
    description:
      'Retrieve deterministic PSA 10 / BGS 9.5 / PSA 9 / Raw NM averages, medians, 7d/30d/90d moving averages, grade multiplier, and population counts for a canonical collectible.',
    method: 'POST',
    endpoint: '/api/hermes/tools/execute',
    sampleArgs: { assetId: 'TCG-PKM-BS-004' },
  },
  {
    name: 'scan_arbitrage_spreads',
    description:
      'Run the deterministic cross-marketplace arbitrage scanner across eBay Sold, Cardmarket, TCGplayer, PWCC, Goldin, and Fanatics Collect with optional seller fee deduction.',
    method: 'POST',
    endpoint: '/api/hermes/tools/execute',
    sampleArgs: { segment: 'ALL', minSpreadPct: 8, includeFees: true },
  },
  {
    name: 'query_knowledge_graph',
    description:
      'Execute a deterministic multi-hop Knowledge Graph traversal and receive the equivalent Cypher query plus ground-truth valuation, catalyst, and outlier facts.',
    method: 'POST',
    endpoint: '/api/hermes/tools/execute',
    sampleArgs: {
      question:
        'Which graded sports rookies and modern TCG chase cards have the highest net arbitrage spreads?',
    },
  },
  {
    name: 'ingest_market_listing',
    description:
      'Submit a raw marketplace sale or event directly from Hermes Agent into SlabGraph deterministic pre-parsing and Knowledge Graph storage.',
    method: 'POST',
    endpoint: '/api/hermes/tools/execute',
    sampleArgs: {
      assetId: 'TCG-OP-OP05-119',
      rawTitle: 'Hermes Scrape: OP05-119 Luffy Manga Rare PSA 10 Verified Comp',
      grade: 'PSA 10',
      priceUsd: 4720,
      marketplaceId: 'ebay_sold',
    },
  },
];

export function verifyHermesBridgeToken(authHeader: string | undefined): {
  authorized: boolean;
  protectedMode: boolean;
} {
  const configuredToken = process.env.HERMES_BRIDGE_TOKEN?.trim();
  if (!configuredToken) {
    return { authorized: true, protectedMode: false };
  }
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { authorized: false, protectedMode: true };
  }
  const provided = authHeader.slice('Bearer '.length).trim();
  const expectedBuf = Buffer.from(configuredToken, 'utf8');
  const providedBuf = Buffer.from(provided, 'utf8');
  if (expectedBuf.length !== providedBuf.length) {
    return { authorized: false, protectedMode: true };
  }
  return {
    authorized: crypto.timingSafeEqual(expectedBuf, providedBuf),
    protectedMode: true,
  };
}

export function getHermesStatus(appOrigin: string): HermesStatusPayload {
  const apiUrlRaw = process.env.HERMES_API_URL?.trim() || '';
  const apiKeySet = Boolean(process.env.HERMES_API_KEY?.trim());
  const model = process.env.HERMES_MODEL?.trim() || 'hermes-agent';
  const webhookUrlRaw = process.env.HERMES_WEBHOOK_URL?.trim() || '';
  const webhookSecretSet = Boolean(process.env.HERMES_WEBHOOK_SECRET?.trim());
  const bridgeTokenSet = Boolean(process.env.HERMES_BRIDGE_TOKEN?.trim());

  let sanitizedApiHost: string | null = null;
  if (apiUrlRaw) {
    try {
      const u = validateHermesOutboundUrl(apiUrlRaw);
      sanitizedApiHost = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      sanitizedApiHost = 'Invalid URL configured';
    }
  }

  let sanitizedWebhookHost: string | null = null;
  if (webhookUrlRaw) {
    try {
      const u = validateHermesOutboundUrl(webhookUrlRaw);
      sanitizedWebhookHost = `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      sanitizedWebhookHost = 'Invalid URL configured';
    }
  }

  const cleanOrigin = appOrigin.replace(/\/+$/, '');

  const hermesEnvSnippet = `# ~/.hermes/.env — Enable Hermes API Server & Webhook Gateway
API_SERVER_ENABLED=true
API_SERVER_KEY=replace-with-strong-random-key
WEBHOOK_ENABLED=true
WEBHOOK_PORT=8644
WEBHOOK_SECRET=replace-with-hmac-webhook-secret`;

  const hermesConfigYaml = `# ~/.hermes/config.yaml — Receive SlabGraph Alerts & Call SlabGraph Tools
platforms:
  webhook:
    port: 8644
    secret: "\${WEBHOOK_SECRET}"
    extra:
      routes:
        slabgraph_alerts:
          events: ["ARBITRAGE_EDGE_DETECTED", "FRAUD_OUTLIER_QUARANTINED", "PRICE_BREAKOUT_TRIGGER", "HERMES_TEST_EVENT"]
          prompt_template: "Analyze this SlabGraph collectibles alert and verify comps via SlabGraph tools: {{payload}}"

# Register SlabGraph HTTP Tool Manifest for Hermes agent runs:
# Manifest URL: ${cleanOrigin}/api/hermes/tools
# Execute URL:  ${cleanOrigin}/api/hermes/tools/execute`;

  const curlBridgeSnippet = `curl -X POST "${cleanOrigin}/api/hermes/tools/execute" \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer \${HERMES_BRIDGE_TOKEN}" \\
  -d '{"tool":"scan_arbitrage_spreads","args":{"minSpreadPct":8,"includeFees":true}}'`;

  return {
    apiGateway: {
      configured: Boolean(apiUrlRaw && sanitizedApiHost !== 'Invalid URL configured'),
      endpointPreview: sanitizedApiHost,
      model,
      apiKeyConfigured: apiKeySet,
    },
    webhookGateway: {
      configured: Boolean(
        webhookUrlRaw && sanitizedWebhookHost !== 'Invalid URL configured'
      ),
      endpointPreview: sanitizedWebhookHost,
      hmacSigningEnabled: webhookSecretSet,
    },
    inboundBridge: {
      manifestUrl: `${cleanOrigin}/api/hermes/tools`,
      executeUrl: `${cleanOrigin}/api/hermes/tools/execute`,
      bearerTokenProtected: bridgeTokenSet,
      toolCount: HERMES_TOOL_DEFINITIONS.length,
    },
    tools: HERMES_TOOL_DEFINITIONS,
    snippets: {
      hermesEnv: hermesEnvSnippet,
      hermesConfigYaml,
      curlBridge: curlBridgeSnippet,
    },
  };
}

export async function pingHermesGateway(): Promise<{
  reachable: boolean;
  latencyMs: number;
  models: string[];
  detail: string;
}> {
  const apiUrlRaw = process.env.HERMES_API_URL?.trim();
  if (!apiUrlRaw) {
    throw new Error(
      'HERMES_API_URL is not configured on the server. Add your Hermes Gateway URL (e.g. https://<your-tunnel>/v1) in Settings > Secrets.'
    );
  }
  const baseUrl = validateHermesOutboundUrl(apiUrlRaw)
    .toString()
    .replace(/\/+$/, '');
  const apiKey = process.env.HERMES_API_KEY?.trim();

  const start = Date.now();
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`${baseUrl}/models`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(10000),
  });
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Hermes Gateway returned HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ id?: string }>;
  };
  const models = (json.data || [])
    .map((m) => m.id)
    .filter((id): id is string => Boolean(id));

  return {
    reachable: true,
    latencyMs,
    models,
    detail: `Connected to Hermes Gateway (${models.length} model(s) advertised).`,
  };
}

export async function sendHermesConsoleMessage(
  prompt: string,
  includeGraphSnapshot: boolean
): Promise<{
  reply: string;
  model: string;
  latencyMs: number;
}> {
  const apiUrlRaw = process.env.HERMES_API_URL?.trim();
  if (!apiUrlRaw) {
    throw new Error(
      'HERMES_API_URL is not configured on the server. Add your Hermes Gateway URL in Settings > Secrets to chat directly with your Hermes Agent.'
    );
  }
  const baseUrl = validateHermesOutboundUrl(apiUrlRaw)
    .toString()
    .replace(/\/+$/, '');
  const apiKey = process.env.HERMES_API_KEY?.trim();
  const model = process.env.HERMES_MODEL?.trim() || 'hermes-agent';

  const systemParts = [
    'You are connected to SlabGraph, a deterministic Trading Card & Sports Collectibles GraphRAG terminal.',
  ];
  if (includeGraphSnapshot) {
    const state = graphEngine.getState(true);
    const snapshot = {
      kpis: state.kpis,
      topArbitrage: state.arbitrage.slice(0, 4),
      recentCatalysts: state.events.slice(0, 3).map((e) => ({
        id: e.id,
        title: e.title,
        deltaPct: e.priceDeltaPct,
      })),
    };
    systemParts.push(
      `Live Deterministic SlabGraph Context:\n${JSON.stringify(snapshot, null, 2)}`
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const start = Date.now();
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemParts.join('\n\n') },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(25000),
  });
  const latencyMs = Date.now() - start;

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Hermes Gateway error (${res.status}): ${errText.slice(0, 240)}`);
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    model?: string;
  };
  const reply = json.choices?.[0]?.message?.content;
  if (!reply) {
    throw new Error('Hermes Gateway returned an empty response.');
  }

  return {
    reply: reply.trim(),
    model: json.model || model,
    latencyMs,
  };
}

export async function dispatchHermesWebhook(
  eventType: string,
  payload: Record<string, unknown>
): Promise<HermesWebhookDispatchResult> {
  const webhookUrlRaw = process.env.HERMES_WEBHOOK_URL?.trim();
  if (!webhookUrlRaw) {
    throw new Error(
      'HERMES_WEBHOOK_URL is not configured on the server. Add your Hermes Webhook Gateway URL (e.g. https://<your-tunnel>/webhooks/slabgraph_alerts) in Settings > Secrets.'
    );
  }

  const targetUrl = validateHermesOutboundUrl(webhookUrlRaw).toString();
  const secret = process.env.HERMES_WEBHOOK_SECRET?.trim();
  const bodyStr = JSON.stringify({
    source: 'slabgraph',
    event: eventType,
    timestamp: new Date().toISOString(),
    payload,
  });

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-SlabGraph-Event': eventType,
  };

  let signed = false;
  if (secret) {
    const hmac = crypto
      .createHmac('sha256', secret)
      .update(bodyStr)
      .digest('hex');
    headers['X-Hermes-Signature-256'] = `sha256=${hmac}`;
    headers['X-Hub-Signature-256'] = `sha256=${hmac}`;
    signed = true;
  }

  const start = Date.now();
  const res = await fetch(targetUrl, {
    method: 'POST',
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(12000),
  });
  const latencyMs = Date.now() - start;
  const responseText = (await res.text()).slice(0, 300);

  if (!res.ok) {
    throw new Error(
      `Hermes Webhook returned HTTP ${res.status}: ${responseText || 'No body'}`
    );
  }

  return {
    delivered: true,
    httpStatus: res.status,
    latencyMs,
    signed,
    eventType,
    responsePreview: responseText || 'Accepted',
  };
}

export function executeHermesTool(
  toolName: string,
  args: Record<string, unknown>
): HermesToolRunResult {
  const start = Date.now();

  switch (toolName) {
    case 'get_collectible_valuation': {
      const requestedId = String(args.assetId || '').trim();
      const assets = graphEngine.getAssets();
      const asset = assets.find((a) => a.id === requestedId) || assets[0];
      if (!asset) {
        throw new Error(
          'Knowledge Graph catalog is empty. Register at least one canonical collectible first.'
        );
      }
      const valuation = graphEngine.computeAssetValuation(asset.id);
      return {
        tool: toolName,
        executedAt: new Date().toISOString(),
        latencyMs: Math.max(1, Date.now() - start),
        result: {
          asset: {
            id: asset.id,
            title: asset.title,
            segment: asset.segment,
            franchise: asset.franchise,
            setName: asset.setName,
            releaseYear: asset.releaseYear,
          },
          valuation,
        },
      };
    }

    case 'scan_arbitrage_spreads': {
      const includeFees = args.includeFees !== false;
      const minSpreadPct = Number(args.minSpreadPct ?? 5);
      const seg = String(args.segment || 'ALL').toUpperCase();
      const opps = graphEngine
        .computeArbitrageOpportunities(includeFees)
        .filter(
          (o) =>
            o.netSpreadPct >= minSpreadPct &&
            (seg === 'ALL' || o.segment === seg)
        );
      return {
        tool: toolName,
        executedAt: new Date().toISOString(),
        latencyMs: Math.max(1, Date.now() - start),
        result: {
          count: opps.length,
          includeFees,
          minSpreadPct,
          opportunities: opps,
        },
      };
    }

    case 'query_knowledge_graph': {
      const question = String(args.question || 'Top graded multipliers').trim();
      const traversal = graphEngine.runDeterministicGraphQuery(question);
      return {
        tool: toolName,
        executedAt: new Date().toISOString(),
        latencyMs: Math.max(1, Date.now() - start),
        result: {
          question,
          cypherQuery: traversal.cypherQuery,
          matchedAssetIds: traversal.matchedAssetIds,
          deterministicFacts: traversal.facts,
        },
      };
    }

    case 'ingest_market_listing': {
      const assetId = String(args.assetId || '').trim();
      const asset = graphEngine.getAssets().find((a) => a.id === assetId);
      if (!asset) {
        throw new Error(`Unknown canonical assetId "${assetId}".`);
      }
      const priceUsd = Number(args.priceUsd);
      if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
        throw new Error('priceUsd must be a positive number.');
      }
      const rawTitle = String(args.rawTitle || `${asset.title} Hermes Comp`).trim();
      const gradeRaw = String(args.grade || 'PSA 10');
      const allowedGrades = ['PSA 10', 'BGS 9.5', 'PSA 9', 'SGC 10', 'Raw NM'] as const;
      const grade = allowedGrades.includes(gradeRaw as (typeof allowedGrades)[number])
        ? (gradeRaw as (typeof allowedGrades)[number])
        : 'PSA 10';
      const allowedMarkets: MarketplaceId[] = [
        'ebay_sold',
        'tcgplayer',
        'cardmarket',
        'pwcc',
        'goldin',
        'fanatics',
      ];
      const mId = allowedMarkets.includes(args.marketplaceId as MarketplaceId)
        ? (args.marketplaceId as MarketplaceId)
        : 'ebay_sold';

      const preParse = graphEngine.deterministicPreParse(rawTitle, priceUsd, '');
      const currentVal = graphEngine.computeAssetValuation(asset.id);
      const refAvg =
        grade === 'Raw NM'
          ? currentVal.rawAvg
          : grade === 'PSA 9'
            ? currentVal.midGradeAvg
            : currentVal.topGradeAvg;
      const devPct =
        refAvg > 0 ? Math.round(((priceUsd - refAvg) / refAvg) * 1000) / 10 : 0;
      const isOutlier =
        Math.abs(devPct) >= 75 ||
        preParse.editionFlags.length > 0 ||
        preParse.conditionRiskKeywords.length > 0;

      const committed = graphEngine.commitSale({
        assetId: asset.id,
        rawTitle,
        grade,
        priceUsd,
        marketplaceId: mId,
        date: new Date().toISOString().slice(0, 10),
        status: isOutlier ? 'QUARANTINED' : 'VERIFIED',
        outlierReason: isOutlier
          ? `Hermes ingest flagged (${devPct}% vs comp or risk keyword)`
          : undefined,
        ingestedBySwarm: true,
      });

      return {
        tool: toolName,
        executedAt: new Date().toISOString(),
        latencyMs: Math.max(1, Date.now() - start),
        result: {
          committedSale: committed,
          updatedValuation: graphEngine.computeAssetValuation(asset.id),
        },
      };
    }

    default:
      throw new Error(
        `Unsupported tool "${toolName}". Valid tools: ${HERMES_TOOL_DEFINITIONS.map((t) => t.name).join(', ')}.`
      );
  }
}
