import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  dispatchAlertToChannel,
  getAlertChannelStatus,
} from './server/alertDispatcher.ts';
import { createAnalyticsRouter } from './server/analytics/routes.ts';
import { createAnalyticsStore } from './server/analytics/store.ts';
import { createOperatorAuthManager } from './server/auth.ts';
import { mountDbRoutes } from './server/db/routes.ts';
import { createIngestRouter } from './server/ingest/routes.ts';
import { createDurableRepositories } from './server/ingest/store.ts';
import { setActiveReportRepositories } from './server/intelligence/active-report.ts';
import { mountIntelligenceRoutes } from './server/intelligence/routes.ts';
import { mountServingRoutes } from './server/serving/routes.ts';
import { graphEngine } from './server/graphEngine.ts';
import {
  groundGraphRagAnswer,
  type GraphRagEvidenceFact,
} from './server/graphRagGuardrails.ts';
import {
  HERMES_TOOL_DEFINITIONS,
  dispatchHermesWebhook,
  executeHermesTool,
  getHermesStatus,
  pingHermesGateway,
  sendHermesConsoleMessage,
  verifyHermesBridgeToken,
} from './server/hermesBridge.ts';
import {
  getAvailableProviders,
  getSwarmRouting,
  invokeSwarmLLM,
  updateSwarmRouting,
} from './server/llmRouter.ts';
import {
  applyStoredSettingsToEnv,
  clearProviderCredentials,
  setProviderCredentials,
} from './server/llmSettings.ts';
import { getMediaAsset, isValidSha256Hex, storeMediaAsset } from './server/mediaStore.ts';
import {
  ValidationError,
  addMarketObservation,
  getMarketObservation,
  listMarketObservations,
  type MarketObservationFilters,
} from './server/marketObservations.ts';
import { indexMissingNodes, searchSemanticNodes } from './server/vectorIndex.ts';
import type {
  AlertRule,
  GradeLabel,
  LLMProviderId,
  MarketBasis,
  MarketplaceId,
  MarketSegment,
  SwarmRunRecord,
  SwarmStepTrace,
} from './src/types/graph.ts';
import { MEDIA_KINDS } from './src/types/graph.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

// Allow-list of LLM provider ids accepted from caller-supplied overrides.
// Anything outside this set is ignored (never forwarded to the router).
const VALID_PROVIDER_IDS: ReadonlySet<string> = new Set<LLMProviderId>([
  'gemini', 'hermes', 'openai', 'anthropic', 'ollama',
]);

/**
 * Return a provider override only when it is an allow-listed id; otherwise
 * undefined. This prevents arbitrary strings from reaching the LLM router.
 */
function sanitizeProviderOverride(value: unknown): LLMProviderId | undefined {
  return typeof value === 'string' && VALID_PROVIDER_IDS.has(value)
    ? (value as LLMProviderId)
    : undefined;
}

/** Lowercase 64-hex-digit SHA-256 digest (shared research/media contract). */
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/**
 * Validate a caller-supplied URL. Accepts http(s) URLs only; any other scheme
 * or a malformed value is rejected. Null/undefined means "not supplied".
 */
function isValidHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

const VALID_GRADES: GradeLabel[] = [
  'PSA 10',
  'BGS 9.5',
  'PSA 9',
  'SGC 10',
  'Raw NM',
];

function normalizeGrade(
  raw: string | undefined,
  fallback: GradeLabel
): GradeLabel {
  if (!raw) return fallback;
  const upper = raw.toUpperCase();
  if (upper.includes('PSA 10') || upper.includes('GEM 10')) return 'PSA 10';
  if (upper.includes('BGS 9.5')) return 'BGS 9.5';
  if (upper.includes('SGC 10')) return 'SGC 10';
  if (upper.includes('PSA 9') || upper.includes('MINT 9')) return 'PSA 9';
  if (upper.includes('RAW') || upper.includes('NM')) return 'Raw NM';
  return VALID_GRADES.includes(raw as GradeLabel)
    ? (raw as GradeLabel)
    : fallback;
}

const operatorAuth = createOperatorAuthManager(
  () => graphEngine.getAdminPasscodeHash(),
  (hash) => graphEngine.setAdminPasscodeHash(hash)
);

// Build the Express application with all routes. Exported so API tests can
// drive real handlers over an ephemeral port without auto-starting a listener.
// When SLABGRAPH_TEST_MODE is set, Vite dev middleware and static hosting are
// skipped (the API is all tests need) so no long-lived watcher keeps Node alive.
export async function createApp() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // --- Data product lanes (wired by the integrator) ---
  // One durable ledger instance is shared by ingest, serving and intelligence
  // so a seed written by the CLI is visible to the running server. No lane
  // opens a listener; all stay on the existing internal bind and auth gate.
  const dataRepositories = createDurableRepositories();
  setActiveReportRepositories(dataRepositories);
  const [evidenceSeed, observationSeed] = await Promise.all([
    dataRepositories.evidence.list(),
    dataRepositories.marketObservations.list(),
  ]);
  const analyticsStore = createAnalyticsStore({
    evidence: evidenceSeed,
    observations: observationSeed,
  });
  mountDbRoutes(app, { requireAuth: operatorAuth.requireAuth });
  app.use(createIngestRouter(dataRepositories));
  // The derived lake is rebuildable, but its export trigger stays behind the
  // existing operator gate. No new listener or public route is introduced.
  app.use('/api/admin/export-parquet', operatorAuth.requireAuth);
  app.use(createAnalyticsRouter({ store: analyticsStore, canonical: dataRepositories }));
  mountIntelligenceRoutes(app, operatorAuth.requireAuth);

  // --- Self-Hosted Health Check Endpoint (Docker / systemd / Reverse Proxy) ---
  app.get('/api/health', (_req, res) => {
    const providers = getAvailableProviders();
    const state = graphEngine.getState();
    res.json({
      status: 'ok',
      mode:
        process.env.NODE_ENV === 'production' &&
        fs.existsSync(path.resolve(__dirname, 'dist'))
          ? 'production'
          : 'development',
      uptimeSec: Math.round(process.uptime()),
      storage: state.storage,
      providersConfigured: providers.filter((p) => p.configured).map((p) => p.id),
      routing: getSwarmRouting(),
      vectorIndex: state.vectorIndex,
    });
  });

  // --- Self-Hosted Operator Auth Endpoints ---
  app.get('/api/auth/status', (req, res) => {
    res.json(operatorAuth.getStatus(req.headers.authorization));
  });

  app.post('/api/auth/claim', (req, res) => {
    try {
      const passcode = String(req.body?.passcode || '');
      const session = operatorAuth.claimInitialPasscode(passcode);
      res.status(201).json({
        ...session,
        status: operatorAuth.getStatus(`Bearer ${session.token}`),
      });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error ? err.message : 'Unable to claim operator passcode.',
      });
    }
  });

  app.post('/api/auth/login', (req, res) => {
    try {
      const passcode = String(req.body?.passcode || '');
      const session = operatorAuth.login(passcode);
      res.json({
        ...session,
        status: operatorAuth.getStatus(`Bearer ${session.token}`),
      });
    } catch (err) {
      res.status(401).json({
        error: err instanceof Error ? err.message : 'Invalid operator passcode.',
      });
    }
  });

  // --- Graph State, Onboarding & Catalog Management ---
  app.get('/api/graph/state', (req, res) => {
    const includeFees = req.query.includeFees !== 'false';
    res.json(graphEngine.getState(includeFees));
  });

  // --- First-party research source ingest & state (Task 3) ---
  const RESEARCH_SOURCE_TYPES = new Set([
    'USER_NOTE',
    'RAW_LISTING',
    'CSV_IMPORT',
    'SCREENSHOT',
    'NEWS',
    'EVENT',
    'PACK_PULL',
    'POPULATION_REPORT',
    'API_RESULT',
  ]);
  const MARKET_BASES = new Set([
    'SOLD',
    'ASKING',
    'OFFER',
    'GUIDE',
    'CLAIM',
    'POPULATION',
    'UNKNOWN',
  ]);

  app.post('/api/research/source', operatorAuth.requireAuth, (req, res) => {
    const { type, title, rawText, tags, basis, tenantId, raw_payload, checksum_sha256, source_url } =
      req.body ?? {};

    if (!type || !RESEARCH_SOURCE_TYPES.has(type)) {
      res.status(400).json({
        error:
          'A valid research source type is required (USER_NOTE, RAW_LISTING, CSV_IMPORT, SCREENSHOT, NEWS, EVENT, PACK_PULL, POPULATION_REPORT, API_RESULT).',
      });
      return;
    }
    if (typeof title !== 'string' || title.trim() === '') {
      res.status(400).json({ error: 'A non-empty title is required.' });
      return;
    }
    if (typeof rawText !== 'string' || rawText.trim() === '') {
      res.status(400).json({ error: 'Non-empty rawText is required.' });
      return;
    }
    if (tags !== undefined && !Array.isArray(tags)) {
      res.status(400).json({ error: 'tags must be an array of strings.' });
      return;
    }
    if (Array.isArray(tags) && !tags.every((t) => typeof t === 'string')) {
      res.status(400).json({ error: 'tags must be an array of strings.' });
      return;
    }
    if (basis !== undefined && !MARKET_BASES.has(basis)) {
      res.status(400).json({ error: 'Invalid basis. Basis must be a first-party market basis or UNKNOWN.' });
      return;
    }
    // checksum_sha256, when supplied, must be a lowercase 64-hex digest.
    if (checksum_sha256 !== undefined && checksum_sha256 !== null &&
        (typeof checksum_sha256 !== 'string' || !SHA256_HEX_RE.test(checksum_sha256))) {
      res.status(400).json({ error: 'checksum_sha256 must be a lowercase 64-character hex SHA-256 digest.' });
      return;
    }
    // source_url, when supplied, must be a syntactically valid http(s) URL.
    if (source_url !== undefined && source_url !== null && !isValidHttpUrl(source_url)) {
      res.status(400).json({ error: 'source_url must be a valid http(s) URL.' });
      return;
    }
    // raw_payload is an opaque string (or null). Reject objects, arrays and
    // scalars so only text provenance is persisted, never arbitrary JSON.
    if (raw_payload !== undefined && raw_payload !== null && typeof raw_payload !== 'string') {
      res.status(400).json({ error: 'raw_payload must be a string or null.' });
      return;
    }

    try {
      const source = graphEngine.addResearchSource({
        type,
        title: title.trim(),
        rawText,
        tags: tags as string[] | undefined,
        basis: basis as MarketBasis | undefined,
        tenantId,
        raw_payload,
        checksum_sha256,
        source_url,
      });
      res.status(201).json({
        source,
        state: graphEngine.getResearchState(),
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to ingest research source.',
      });
    }
  });

  app.get('/api/research/state', operatorAuth.requireAuth, (_req, res) => {
    res.json(graphEngine.getResearchState());
  });

  // --- First-party market observation API (Task 1) -----------------------
  // Append-only write path plus list/get reads. Basis is required and never
  // defaulted; missing shipping/fees/currency stay UNKNOWN. Validation errors
  // surface as 400 rather than 500.
  app.post('/api/market/observations', operatorAuth.requireAuth, (req, res) => {
    try {
      const observation = addMarketObservation(req.body);
      res.status(201).json({ observation });
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to add market observation.',
      });
    }
  });

  app.get('/api/market/observations', operatorAuth.requireAuth, (req, res) => {
    const allowed = new Set([
      'tenantId', 'targetIdentityRef', 'basis', 'status',
      'sourceId', 'nativeSourceRecordId', 'marketplace', 'currency',
    ]);
    const filters: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.query)) {
      if (!allowed.has(key)) {
        res.status(400).json({ error: `Unknown filter: ${key}`, allowed: [...allowed] });
        return;
      }
      if (typeof value === 'string') filters[key] = value;
    }
    res.json({ observations: listMarketObservations(filters as MarketObservationFilters) });
  });

  app.get('/api/market/observations/:id', operatorAuth.requireAuth, (req, res) => {
    const observation = getMarketObservation(req.params.id);
    if (!observation) {
      res.status(404).json({ error: 'Market observation not found.' });
      return;
    }
    res.json({ observation });
  });

  // --- Question-first research (Task 6) -----------------------------------
  // A research question decomposes into subquestions and is answered against
  // first-party deterministic evidence only. LLM output may reorganize that
  // evidence but may never invent facts, prices, or confidence. With no
  // provider (or insufficient evidence) the note is still saved, explicitly
  // marked LOW confidence with insufficient evidence and missingData.
  app.post('/api/research/question', operatorAuth.requireAuth, async (req, res) => {
    const { question, providerOverride } = req.body ?? {};
    // Allow-list the provider override: arbitrary strings are ignored, never
    // forwarded to the router.
    const allowedProviderOverride = sanitizeProviderOverride(providerOverride);
    if (typeof question !== 'string' || question.trim() === '') {
      res.status(400).json({ error: 'A non-empty research question is required.' });
      return;
    }
    const cleanQuestion = question.trim();

    try {
      const state = graphEngine.getResearchState();
      const evidenceIds: string[] = [];
      const evidenceFacts: GraphRagEvidenceFact[] = [];

      // Deterministic facts authority: only first-party collections are
      // eligible evidence. No external or fabricated numbers enter here.
      // Task 7: graph facts + research observations are the grounding set.
      for (const source of state.researchSources) {
        evidenceIds.push(source.id);
        evidenceFacts.push({
          id: source.id,
          kind: 'researchSource',
          detail: `${source.type} · ${source.title} · basis=${source.basis}`,
        });
      }
      for (const observation of state.researchObservations) {
        evidenceIds.push(observation.id);
        evidenceFacts.push({
          id: observation.id,
          kind: 'researchObservation',
          detail: `${observation.kind} · ${observation.value} (confidence=${observation.confidence})`,
        });
      }
      for (const media of state.mediaAssets) {
        evidenceIds.push(media.id);
        evidenceFacts.push({
          id: media.id,
          kind: 'mediaAsset',
          detail: `${media.kind} · target=${media.target_type} · sha256=${media.checksum_sha256.slice(0, 12)}`,
        });
      }

      // Task 7: deterministic graph facts are grounding evidence too. Market
      // observations carry an explicit basis and amount emitted by the graph
      // engine — never computed or invented by the model. They are the only
      // priced facts eligible to back a numeric price in a grounded answer.
      for (const observation of state.marketObservations) {
        evidenceIds.push(observation.id);
        // Canonical USD price token so the deterministic verifier can back a
        // grounded answer that cites this real market observation ($amount).
        // Non-USD amounts stay currency-labelled and are never treated as USD.
        const priceToken =
          observation.currency?.toUpperCase() === 'USD'
            ? `$${Number(observation.amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : `${observation.currency} ${observation.amount}`;
        evidenceFacts.push({
          id: observation.id,
          kind: 'marketObservation',
          detail: `MARKET ${observation.basis} · ${priceToken} · qty=${observation.quantity} · marketplace=${observation.marketplace}`,
        });
      }

      // Deterministic subquestion decomposition — never invented by the LLM.
      const subquestions: string[] = [
        `What first-party evidence is available for: ${cleanQuestion}?`,
        'Which claims are supported by deterministic facts, and which are unsupported?',
        'What evidence is still missing to answer with confidence?',
      ];

      const hasProvider = getAvailableProviders().some((p) => p.configured);
      const hasKnownBasis =
        state.researchSources.some((s) => s.basis !== 'UNKNOWN') ||
        state.marketObservations.some((o) => o.basis !== 'UNKNOWN');

      // Task 7: the GraphRAG system instruction now makes deterministic
      // evidence the sole authority. Prices/numbers may only be repeated from
      // the supplied facts, every claim needs an [evidenceId] citation, and
      // unsupported questions must be deflected — never answered by guesswork.
      const graphRagSystemInstruction = [
        'You are the Question-First Research Agent for SlabGraph, a deterministic GraphRAG terminal.',
        'GROUNDING RULES (absolute):',
        '- Answer ONLY from the first-party evidence facts supplied. They are authoritative; you may reorganize them but never add, invent, estimate, or recalculate prices, dates, grades, counts, or confidence.',
        '- Never output a numeric price unless that exact value appears in a supplied evidence fact. No made-up dollar amounts, comps, or market values.',
        '- Cite the evidence id in square brackets for every claim, e.g. [src-123]. An answer without at least one citation is not grounded.',
        '- Basis is never defaulted: SOLD, ASKING, GUIDE, and CLAIM are distinct. Treat basis=UNKNOWN as UNKNOWN.',
        '- Missing data stays UNKNOWN. Do not fill gaps with plausible-sounding numbers or assumptions.',
        '- DEFLECTION: if the evidence is insufficient, empty, or does not support the question, reply with a synthesis that explicitly begins "Insufficient evidence" and states what is missing. Never bluff a confident answer.',
        '- Confidence is a deterministic cap, not a free choice: without a known market basis use LOW; never claim HIGH on your own authority.',
        'Return JSON with: synthesis (string), confidence (LOW/MEDIUM/HIGH), subquestions (array of strings).',
      ].join('\n');

      const missingData: string[] = [];
      if (evidenceIds.length === 0) {
        missingData.push('No first-party research sources, observations, or media evidence are available.');
      }
      if (!hasKnownBasis) {
        missingData.push('No source with a known market basis (SOLD / ASKING / GUIDE / CLAIM) is available.');
      }
      missingData.push('No verified price comps are attached to this question.');

      const evidenceText = evidenceFacts.length
        ? evidenceFacts.map((f) => `- [${f.id}] ${f.detail}`).join('\n')
        : '(none — no first-party evidence is available)';

      let draftSynthesis = '';
      let requestedConfidence = '';
      let evidenceMode = 'deterministic_fallback';
      let providerUsed: string | undefined;

      if (hasProvider) {
        try {
          const synthesized = await invokeSwarmLLM<{
            synthesis?: string;
            confidence?: string;
            subquestions?: string[];
          }>({
            role: 'graphRagSynthesis',
            providerOverride: allowedProviderOverride,
            systemInstruction: graphRagSystemInstruction,
            prompt: `Research Question: ${cleanQuestion}\n\nSubquestions:\n${subquestions.map((s) => `- ${s}`).join('\n')}\n\nFirst-party evidence (authoritative):\n${evidenceText}\n\nKnown missing data:\n${missingData.map((m) => `- ${m}`).join('\n')}`,
            jsonSchema: {
              synthesis: { type: 'STRING', description: 'Evidence-grounded synthesis. No invented numbers. Every claim cites an [evidenceId].' },
              confidence: { type: 'STRING', description: 'LOW, MEDIUM, or HIGH; deterministic evidence caps this, never HIGH without known basis.' },
              subquestions: { type: 'ARRAY', itemsType: 'STRING', description: 'Subquestions answered.' },
            },
          });
          const data = synthesized.data;
          if (typeof data?.synthesis === 'string') {
            draftSynthesis = data.synthesis.trim();
            requestedConfidence = String(data.confidence || '');
          }
          if (Array.isArray(data?.subquestions) && data.subquestions.length > 0) {
            subquestions.splice(0, subquestions.length, ...data.subquestions.filter((q) => typeof q === 'string'));
          }
          evidenceMode = 'swarm_provider';
          providerUsed = `${synthesized.providerLabel} (${synthesized.model})`;
        } catch {
          // Provider unavailable: deterministic fallback below.
          draftSynthesis = '';
          requestedConfidence = '';
        }
      }

      // Task 7: run the provider draft through the deterministic guardrail.
      // This is the last word on grounding — deterministic facts are authority
      // over the model, so an uncited or invented price is deflected here even
      // if the provider ignored its system instruction.
      const grounded = groundGraphRagAnswer({
        question: cleanQuestion,
        draftSynthesis,
        evidenceFacts,
        evidenceIds,
        knownBasis: hasKnownBasis,
        requestedConfidence,
      });
      const synthesis = grounded.synthesis;

      // ResearchNoteNode.confidence stays numeric (Task 1 schema). Map the
      // grounded band to a conservative numeric value; UNKNOWN and LOW are
      // both 0.2 so missing evidence is never treated as a factual value.
      const confidenceByBand: Record<string, number> = {
        UNKNOWN: 0.2,
        LOW: 0.2,
        MEDIUM: 0.6,
        HIGH: 0.8,
      };
      const confidence = confidenceByBand[grounded.confidence] ?? 0.2;
      const confidenceLabel = grounded.confidence;

      const finalMissingData = grounded.missingData.length
        ? grounded.missingData
        : ['Unspecified evidence gaps.'];

      const note = graphEngine.addResearchNote({
        question: cleanQuestion,
        subquestions,
        evidenceIds,
        synthesis,
        confidence,
        missingData: finalMissingData,
      });
      res.status(201).json({
        note,
        confidence,
        confidenceLabel,
        missingData: finalMissingData,
        deflected: grounded.deflected,
        citations: grounded.citations,
        evidenceMode,
        ...(providerUsed ? { providerUsed } : {}),
        evidenceFacts,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to record research question.',
      });
    }
  });

  // --- First-party media evidence ingest / retrieval (Task 5) -------------
  // Raw bytes are immutable; all derived OCR/recognition data is attached to
  // the record. License metadata is mandatory for commercial use. Kinds are
  // validated against the single source of truth in src/types/graph.ts.
  const MEDIA_KIND_SET: ReadonlySet<string> = new Set<string>(MEDIA_KINDS);

  app.post('/api/media/ingest', operatorAuth.requireAuth, (req, res) => {
    const body = req.body ?? {};
    const {
      kind,
      bytesBase64,
      uri,
      checksumSha256,
      mimeType,
      width,
      height,
      license,
      attribution,
      sourceUrl,
      sourceTerms,
      usageRights,
      observedAt,
      capturedAt,
      tenantId,
      sourceId,
      sourceRecordId,
      targetType,
      targetId,
      ocrText,
      recognitionCandidates,
      recognitionConfidence,
      parserVersion,
      visibleFacets,
    } = body;

    if (!MEDIA_KIND_SET.has(kind)) {
      res.status(400).json({
        error:
          'A valid media kind is required (CARD_FRONT, CARD_BACK, SLAB_LABEL, PACK, BOX, SELLER_PHOTO, SCREENSHOT, OCR_IMAGE).',
      });
      return;
    }
    if (typeof license !== 'string' || license.trim() === '') {
      res.status(400).json({ error: 'License metadata is required for commercial use.' });
      return;
    }
    if (typeof mimeType !== 'string' || mimeType.trim() === '') {
      res.status(400).json({ error: 'A non-empty mimeType is required.' });
      return;
    }
    if (bytesBase64 === undefined && uri === undefined) {
      res.status(400).json({ error: 'Either bytesBase64 or uri is required.' });
      return;
    }
    if (bytesBase64 !== undefined && uri !== undefined) {
      res.status(400).json({ error: 'Provide either bytesBase64 or uri, not both.' });
      return;
    }
    if (bytesBase64 !== undefined && typeof bytesBase64 !== 'string') {
      res.status(400).json({ error: 'bytesBase64 must be a base64-encoded string.' });
      return;
    }
    if (uri !== undefined && typeof uri !== 'string') {
      res.status(400).json({ error: 'uri must be a string.' });
      return;
    }
    // URI references require a well-formed lowercase 64-hex SHA-256 checksum.
    if (uri !== undefined && !isValidSha256Hex(checksumSha256)) {
      res.status(400).json({
        error: 'checksumSha256 must be a lowercase 64-character hex SHA-256 digest.',
      });
      return;
    }
    // Image dimensions, when supplied, must be finite positive integers.
    const isPositiveInt = (v: unknown): boolean =>
      typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v > 0;
    if ((width !== undefined && width !== null && !isPositiveInt(width)) ||
        (height !== undefined && height !== null && !isPositiveInt(height))) {
      res.status(400).json({ error: 'width and height must be finite positive integers.' });
      return;
    }

    let bytes: Buffer | undefined;
    if (bytesBase64 !== undefined) {
      // Reject malformed base64 before decoding: restrict to the standard
      // alphabet with optional padding, require a non-empty payload, and
      // verify the decode -> re-encode round-trip matches the input.
      const trimmed = bytesBase64.trim();
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0 ||
          trimmed.length === 0) {
        res.status(400).json({ error: 'bytesBase64 is not valid base64 image data.' });
        return;
      }
      bytes = Buffer.from(trimmed, 'base64');
      if (bytes.length === 0 || bytes.toString('base64') !== trimmed) {
        res.status(400).json({ error: 'bytesBase64 is not valid base64 image data.' });
        return;
      }
    }

    try {
      const media = storeMediaAsset({
        kind,
        bytes,
        uri,
        checksumSha256,
        mimeType,
        width,
        height,
        license,
        attribution,
        sourceUrl,
        sourceTerms,
        usageRights,
        observedAt: observedAt ?? new Date().toISOString(),
        capturedAt,
        tenantId,
        sourceId,
        sourceRecordId,
        targetType,
        targetId,
        ocrText,
        recognitionCandidates,
        recognitionConfidence,
        parserVersion,
        visibleFacets,
      });
      res.status(201).json({ media });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to ingest media asset.',
      });
    }
  });

  app.get('/api/media/:id', operatorAuth.requireAuth, (req, res) => {
    const media = getMediaAsset(req.params.id);
    if (!media) {
      res.status(404).json({ error: 'Media asset not found.' });
      return;
    }
    res.json({ media });
  });

  app.get('/api/blueprint', (_req, res) => {
    res.json({
      cypherSchema: graphEngine.generateCypherSchema(),
      swarmAdapterCode: graphEngine.generateSwarmAdapterBlueprint(),
    });
  });

  app.get('/api/graph/export', operatorAuth.requireAuth, (_req, res) => {
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="slabgraph-backup-${new Date().toISOString().slice(0, 10)}.json"`
    );
    res.json(graphEngine.exportDatabaseSnapshot());
  });

  app.post('/api/graph/import', operatorAuth.requireAuth, (req, res) => {
    try {
      const result = graphEngine.importCatalog(req.body ?? {});
      res.status(201).json({
        ...result,
        state: graphEngine.getState(),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Catalog import failed.',
      });
    }
  });

  app.post('/api/graph/reset', operatorAuth.requireAuth, (_req, res) => {
    graphEngine.resetAllData();
    res.json({ reset: true, state: graphEngine.getState() });
  });

  app.post('/api/onboarding/complete', operatorAuth.requireAuth, (req, res) => {
    const completed = req.body?.completed !== false;
    graphEngine.setOnboardingCompleted(completed);
    res.json({ onboardingCompleted: completed, state: graphEngine.getState() });
  });

  app.post('/api/graph/assets', operatorAuth.requireAuth, (req, res) => {
    try {
      const {
        title,
        segment,
        franchise,
        setName,
        releaseYear,
        cardNumber,
        variant,
        subjectName,
        topGradeLabel,
        topGradePop,
        gemRatePct,
        initialSalePriceUsd,
        initialSaleGrade,
        initialSaleMarketplaceId,
        initialSaleDate,
      } = req.body ?? {};

      if (!title || !franchise || !setName || !subjectName) {
        res.status(400).json({
          error:
            'Title, franchise/sport, set/release name, and subject name are required.',
        });
        return;
      }

      const validSegment: MarketSegment =
        segment === 'SPORTS' ? 'SPORTS' : 'TCG';

      const created = graphEngine.registerCanonicalAsset({
        title: String(title).trim(),
        segment: validSegment,
        franchise: String(franchise).trim(),
        setName: String(setName).trim(),
        releaseYear: Number(releaseYear) || new Date().getFullYear(),
        cardNumber: String(cardNumber || '#1').trim(),
        variant: String(variant || 'Base').trim(),
        subjectName: String(subjectName).trim(),
        topGradeLabel: normalizeGrade(topGradeLabel, 'PSA 10'),
        topGradePop: Math.max(0, Number(topGradePop) || 0),
        gemRatePct: Math.max(0, Math.min(100, Number(gemRatePct) || 0)),
        initialSalePriceUsd: Math.max(0, Number(initialSalePriceUsd) || 0),
        initialSaleGrade: initialSaleGrade
          ? normalizeGrade(initialSaleGrade, 'PSA 10')
          : undefined,
        initialSaleMarketplaceId: initialSaleMarketplaceId as
          | MarketplaceId
          | undefined,
        initialSaleDate: initialSaleDate
          ? String(initialSaleDate).slice(0, 10)
          : undefined,
      });

      res.status(201).json({
        asset: created,
        state: graphEngine.getState(),
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to register canonical asset.',
      });
    }
  });

  // --- Hybrid Vector Embeddings Endpoints (gemini-embedding-2) ---
  app.post('/api/embeddings/reindex', operatorAuth.requireAuth, async (req, res) => {
    try {
      const forceAll = req.body?.forceAll === true;
      const result = await indexMissingNodes(
        graphEngine.getAssets(),
        graphEngine.getEvents(),
        graphEngine.getEmbeddingsStore(),
        forceAll
      );
      graphEngine.persistEmbeddings();
      res.json({
        ...result,
        state: graphEngine.getState(),
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to build vector embedding index.',
      });
    }
  });

  app.post('/api/embeddings/search', async (req, res) => {
    try {
      const query = String(req.body?.query || '').trim();
      const topK = Math.min(20, Math.max(1, Number(req.body?.topK) || 6));
      if (!query) {
        res.status(400).json({ error: 'Search query is required.' });
        return;
      }
      const result = await searchSemanticNodes(
        query,
        graphEngine.getAssets(),
        graphEngine.getEvents(),
        graphEngine.getEmbeddingsStore(),
        topK
      );
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error ? err.message : 'Semantic vector search failed.',
      });
    }
  });

  // --- Pluggable Server-Side LLM Provider Router Endpoints ---
  app.get('/api/llm/providers', (_req, res) => {
    res.json({
      providers: getAvailableProviders(),
      routing: getSwarmRouting(),
    });
  });

  app.post('/api/llm/providers', operatorAuth.requireAuth, (req, res) => {
    try {
      const { id, credentials, model } = req.body ?? {};
      if (!id || !credentials || typeof credentials !== 'object') {
        throw new Error('Provider id and credentials are required.');
      }
      setProviderCredentials(
        id as LLMProviderId,
        credentials as Record<string, string>,
        typeof model === 'string' ? model : undefined
      );
      applyStoredSettingsToEnv();
      res.json({
        providers: getAvailableProviders(),
        routing: getSwarmRouting(),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid provider settings.',
      });
    }
  });

  app.delete('/api/llm/providers/:id', operatorAuth.requireAuth, (req, res) => {
    try {
      clearProviderCredentials(req.params.id as LLMProviderId);
      res.json({
        providers: getAvailableProviders(),
        routing: getSwarmRouting(),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Failed to clear provider settings.',
      });
    }
  });

  app.post('/api/llm/routing', operatorAuth.requireAuth, (req, res) => {
    try {
      const updated = updateSwarmRouting(req.body ?? {});
      res.json({
        providers: getAvailableProviders(),
        routing: updated,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Invalid routing update.',
      });
    }
  });

  // --- Layer 1: Raw Queue Endpoint for External Connectors/Scrapers ---
  app.post('/api/swarm/queue', operatorAuth.requireAuth, (req, res) => {
    try {
      const {
        kind = 'LISTING',
        rawTitle,
        marketplaceId = 'ebay_sold',
        priceUsd = 0,
        sellerNotes = '',
        date = new Date().toISOString().slice(0, 10),
        expectedSignalHint = '',
      } = req.body ?? {};
      const title = String(rawTitle || '').trim();
      if (!title) {
        res.status(400).json({ error: 'rawTitle is required to enqueue an item.' });
        return;
      }
      const queued = graphEngine.enqueueRawItem({
        kind: kind === 'CATALYST' ? 'CATALYST' : 'LISTING',
        rawTitle: title,
        marketplaceId: marketplaceId as MarketplaceId,
        priceUsd: Math.max(0, Number(priceUsd) || 0),
        sellerNotes: String(sellerNotes || '').trim(),
        date: String(date || new Date().toISOString().slice(0, 10)).slice(0, 10),
        expectedSignalHint:
          String(expectedSignalHint || '').trim() ||
          (kind === 'CATALYST' ? 'Inbound Catalyst' : 'Inbound Listing'),
      });
      res.status(201).json({ queued, state: graphEngine.getState() });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to enqueue raw item.',
      });
    }
  });

  // --- Layer 1: Multi-Agent Swarm Ingestion & Triage ---
  app.post('/api/swarm/ingest', operatorAuth.requireAuth, async (req, res) => {
    try {
      const {
        queueId,
        kind = 'LISTING',
        rawTitle,
        marketplaceId = 'ebay_sold',
        priceUsd = 0,
        sellerNotes = '',
        date = new Date().toISOString().slice(0, 10),
        providerOverride,
      } = req.body ?? {};

      // Note: an empty canonical catalog no longer blocks ingest. An
      // unresolved raw title is captured as first-party research evidence
      // instead of being forced onto a fabricated asset.
      let itemKind: 'LISTING' | 'CATALYST' =
        kind === 'CATALYST' ? 'CATALYST' : 'LISTING';
      let itemTitle = String(rawTitle || '').trim();
      let itemMarketplace = (marketplaceId || 'ebay_sold') as MarketplaceId;
      let itemPrice = Number(priceUsd) || 0;
      let itemNotes = String(sellerNotes || '').trim();
      let itemDate = String(date || new Date().toISOString().slice(0, 10)).slice(0, 10);

      if (queueId) {
        const queued = graphEngine.getQueuedItem(String(queueId));
        if (!queued) {
          res
            .status(404)
            .json({ error: 'Queued item was already processed or not found.' });
          return;
        }
        itemKind = queued.kind;
        itemTitle = queued.rawTitle;
        itemMarketplace = queued.marketplaceId;
        itemPrice = queued.priceUsd;
        itemNotes = queued.sellerNotes;
        itemDate = queued.date;
      }

      if (!itemTitle) {
        res.status(400).json({
          error: 'A raw listing title or catalyst headline is required.',
        });
        return;
      }

      const allAssets = graphEngine.getAssets();
      const steps: SwarmStepTrace[] = [];

      // No canonical assets yet: hold the raw listing as first-party
      // research evidence. Never fabricate an asset ID or a price from an
      // unresolved title; a research question can be asked against it later.
      if (allAssets.length === 0) {
        const source = graphEngine.addResearchSource({
          type: 'RAW_LISTING',
          title: itemTitle,
          rawText: [
            itemKind === 'CATALYST' ? `Catalyst headline: ${itemTitle}` : `Raw listing title: ${itemTitle}`,
            itemNotes ? `Seller notes: ${itemNotes}` : '',
            `Marketplace: ${itemMarketplace}`,
          ].filter(Boolean).join('\n'),
          tags: ['unresolved-ingest', 'no-canonical-catalog'],
          // Basis is explicit UNKNOWN: a raw, unresolved title is not a SOLD comp.
          basis: 'UNKNOWN',
        });
        steps.push({
          agent: 'Deterministic Parser',
          status: 'PASSED',
          provider: 'Deterministic Regex Engine',
          latencyMs: 1,
          summary: 'Captured unresolved raw title as first-party research evidence; no canonical asset or price inferred.',
          payload: { sourceId: source.id, basis: source.basis },
        });
        if (queueId) graphEngine.removeQueuedItem(String(queueId));
        const runRecord: SwarmRunRecord = {
          id: `RUN-${Date.now().toString().slice(-5)}`,
          timestamp: new Date().toISOString(),
          kind: itemKind,
          rawTitle: itemTitle,
          marketplaceId: itemMarketplace,
          priceUsd: 0,
          verdict: 'HELD_UNRESOLVED',
          resolvedAssetId: null,
          resolvedAssetTitle: null,
          resolvedGrade: null,
          steps,
          graphDiff: `+1 ResearchSource (${source.id}) — unresolved raw title, no asset or price inferred`,
        };
        graphEngine.addSwarmRun(runRecord);
        res.json({ run: runRecord, state: graphEngine.getState() });
        return;
      }

      // Hybrid Vector Candidate Narrowing when catalog grows large (> 12 assets)
      let candidateAssets = allAssets;
      if (allAssets.length > 12) {
        const vecStart = Date.now();
        const searchRes = await searchSemanticNodes(
          `${itemTitle} ${itemNotes}`,
          allAssets,
          [],
          graphEngine.getEmbeddingsStore(),
          12
        );
        const hitIds = new Set(searchRes.hits.map((h) => h.id));
        const narrowed = allAssets.filter((a) => hitIds.has(a.id));
        if (narrowed.length > 0) {
          candidateAssets = narrowed;
          steps.push({
            agent: 'Deterministic Parser',
            status: 'PASSED',
            provider: `Hybrid Retrieval (${searchRes.model})`,
            latencyMs: Math.max(1, Date.now() - vecStart),
            summary: `Narrowed ${allAssets.length} canonical assets to top ${narrowed.length} ${searchRes.mode} candidates prior to Entity Resolution.`,
            payload: { mode: searchRes.mode, candidateIds: narrowed.map((a) => a.id) },
          });
        }
      }

      const canonicalCatalog = candidateAssets.map((a) => ({
        id: a.id,
        title: a.title,
        franchise: a.franchise,
        segment: a.segment,
        setName: a.setName,
        cardNumber: a.cardNumber,
        variant: a.variant,
        subjectName: a.subjectName,
      }));

      // Step 1: Deterministic Pre-Parser
      const parseStart = Date.now();
      const preParsed = graphEngine.deterministicPreParse(
        itemTitle,
        itemPrice,
        itemNotes
      );
      steps.push({
        agent: 'Deterministic Parser',
        status:
          preParsed.conditionRiskKeywords.length > 0 ||
          preParsed.shillRiskKeywords.length > 0 ||
          preParsed.editionFlags.length > 0
            ? 'FLAGGED'
            : 'PASSED',
        provider: 'Deterministic Regex Engine',
        latencyMs: Math.max(1, Date.now() - parseStart),
        summary:
          itemKind === 'CATALYST'
            ? 'Parsed structured catalyst payload prior to sentiment agent handoff.'
            : `Extracted price $${preParsed.extractedPriceUsd.toLocaleString()}, grade hint ${preParsed.detectedGradeHint || 'unclassified'}, and ${preParsed.conditionRiskKeywords.length + preParsed.shillRiskKeywords.length + preParsed.editionFlags.length} risk flag(s).`,
        payload: preParsed as unknown as Record<string, unknown>,
      });

      if (itemKind === 'CATALYST') {
        const catalystRes = await invokeSwarmLLM<{
          impactedAssetIds: string[];
          category: string;
          sentiment: string;
          estimatedDeltaPct: number;
          windowDays: number;
          conciseSummary: string;
        }>({
          role: 'catalystSentiment',
          providerOverride: providerOverride as LLMProviderId | undefined,
          systemInstruction:
            'You are the Catalyst & Sentiment Agent in a trading card & sports collectibles Knowledge Graph Swarm. Map the incoming market catalyst to canonical Asset IDs from the provided catalog, classify its category and sentiment, and write a concise 1-sentence analytical summary. Only return IDs that exist in the catalog.',
          prompt: `Catalyst Headline: ${itemTitle}\nDetails: ${itemNotes}\nCatalog:\n${JSON.stringify(canonicalCatalog)}`,
          jsonSchema: {
            impactedAssetIds: {
              type: 'ARRAY',
              itemsType: 'STRING',
              description: 'Canonical asset IDs impacted by this catalyst.',
            },
            category: {
              type: 'STRING',
              description:
                'One of: Tournament Meta, Set Release, Ban List, Championship / Milestone, Pop Report Shift',
            },
            sentiment: {
              type: 'STRING',
              description: 'One of: BULLISH, BEARISH, NEUTRAL',
            },
            estimatedDeltaPct: {
              type: 'NUMBER',
              description: 'Estimated percentage impact window (e.g., 12.5)',
            },
            windowDays: {
              type: 'NUMBER',
              description: 'Expected impact window in days (e.g., 10)',
            },
            conciseSummary: {
              type: 'STRING',
              description:
                'One concise institutional sentence explaining market impact.',
            },
          },
        });

        const validIds = new Set(canonicalCatalog.map((c) => c.id));
        const impactedIds = (catalystRes.data.impactedAssetIds || []).filter(
          (id) => validIds.has(id)
        );
        const finalImpacted =
          impactedIds.length > 0 ? impactedIds : [canonicalCatalog[0].id];

        const allowedCategories = [
          'Tournament Meta',
          'Set Release',
          'Ban List',
          'Championship / Milestone',
          'Pop Report Shift',
        ] as const;
        const category = allowedCategories.includes(
          catalystRes.data.category as (typeof allowedCategories)[number]
        )
          ? (catalystRes.data.category as (typeof allowedCategories)[number])
          : 'Tournament Meta';

        const sentiment =
          catalystRes.data.sentiment === 'BEARISH'
            ? 'BEARISH'
            : catalystRes.data.sentiment === 'NEUTRAL'
              ? 'NEUTRAL'
              : 'BULLISH';

        steps.push({
          agent: 'Catalyst & Sentiment Agent',
          status: 'PASSED',
          provider: `${catalystRes.providerLabel} (${catalystRes.model})`,
          latencyMs: catalystRes.latencyMs,
          summary: `Classified as ${category} (${sentiment}) impacting ${finalImpacted.join(', ')}.`,
          payload: catalystRes.data as unknown as Record<string, unknown>,
        });

        const committedEvent = graphEngine.injectMarketEvent({
          title: itemTitle,
          date: itemDate,
          category,
          sentiment,
          impactedAssetIds: finalImpacted,
          priceDeltaPct: Number(catalystRes.data.estimatedDeltaPct) || 8.5,
          windowDays: Math.max(
            3,
            Math.round(Number(catalystRes.data.windowDays) || 10)
          ),
          summary: catalystRes.data.conciseSummary || itemNotes,
        });

        steps.push({
          agent: 'Graph Writer',
          status: 'COMMITTED',
          provider: 'Knowledge Graph Engine',
          latencyMs: 1,
          summary: `Injected MarketEvent ${committedEvent.id} and ${finalImpacted.length} IMPACTED edge(s).`,
          payload: {
            eventId: committedEvent.id,
            edgesWritten: finalImpacted.map(
              (id) => `(${committedEvent.id})-[IMPACTED]->(${id})`
            ),
          },
        });

        if (queueId) graphEngine.removeQueuedItem(String(queueId));

        const primaryAsset = allAssets.find((a) => a.id === finalImpacted[0]);

        const runRecord: SwarmRunRecord = {
          id: `RUN-${Date.now().toString().slice(-5)}`,
          timestamp: new Date().toISOString(),
          kind: 'CATALYST',
          rawTitle: itemTitle,
          marketplaceId: itemMarketplace,
          priceUsd: 0,
          verdict: 'CATALYST_INJECTED',
          resolvedAssetId: finalImpacted[0],
          resolvedAssetTitle: primaryAsset?.title || finalImpacted[0],
          resolvedGrade: null,
          steps,
          graphDiff: `+1 MarketEvent (${committedEvent.id}) -[IMPACTED]-> ${finalImpacted.join(', ')}`,
        };

        graphEngine.addSwarmRun(runRecord);
        res.json({ run: runRecord, state: graphEngine.getState() });
        return;
      }

      // Step 2: Entity Resolution Agent
      const entityRes = await invokeSwarmLLM<{
        canonicalAssetId: string;
        normalizedGrade: string;
        confidence: number;
        editionMismatch: boolean;
        reasoning: string;
      }>({
        role: 'entityResolution',
        providerOverride: providerOverride as LLMProviderId | undefined,
        systemInstruction:
          'You are the Entity Resolution Agent in a trading card & sports collectibles Knowledge Graph Swarm. Map the messy raw listing to the single closest canonical Asset ID from the catalog without creating duplicates. Identify the normalized grade (PSA 10, BGS 9.5, PSA 9, SGC 10, or Raw NM) and flag whether the listing is a reprint/wrong edition.',
        prompt: `Raw Listing Title: ${itemTitle}\nSeller Notes: ${itemNotes}\nDeterministic Pre-Parse: ${JSON.stringify(preParsed)}\nCanonical Catalog:\n${JSON.stringify(canonicalCatalog)}`,
        jsonSchema: {
          canonicalAssetId: {
            type: 'STRING',
            description: 'Exact canonical Asset ID from the provided catalog.',
          },
          normalizedGrade: {
            type: 'STRING',
            description:
              'Normalized grade: PSA 10, BGS 9.5, PSA 9, SGC 10, or Raw NM',
          },
          confidence: {
            type: 'NUMBER',
            description: 'Confidence score between 0 and 1.',
          },
          editionMismatch: {
            type: 'BOOLEAN',
            description:
              'True if listing appears to be a reprint, proxy, or different edition.',
          },
          reasoning: {
            type: 'STRING',
            description: 'Concise 1-sentence entity resolution rationale.',
          },
        },
      });

      const resolvedAsset =
        allAssets.find((a) => a.id === entityRes.data.canonicalAssetId) ||
        allAssets[0];
      const resolvedGrade = normalizeGrade(
        entityRes.data.normalizedGrade,
        preParsed.detectedGradeHint || 'PSA 10'
      );

      steps.push({
        agent: 'Entity Resolution Agent',
        status: entityRes.data.editionMismatch ? 'FLAGGED' : 'PASSED',
        provider: `${entityRes.providerLabel} (${entityRes.model})`,
        latencyMs: entityRes.latencyMs,
        summary: `Resolved to ${resolvedAsset.id} (${resolvedAsset.title} · ${resolvedGrade}) with ${(Number(entityRes.data.confidence || 0.92) * 100).toFixed(0)}% confidence.`,
        payload: entityRes.data as unknown as Record<string, unknown>,
      });

      // Deterministic comp lookup prior to Outlier & Fraud Filter
      const currentVal = graphEngine.computeAssetValuation(resolvedAsset.id);
      const referenceAvg =
        resolvedGrade === 'Raw NM'
          ? currentVal.rawAvg
          : resolvedGrade === 'PSA 9'
            ? currentVal.midGradeAvg
            : currentVal.topGradeAvg;
      const deviationPct =
        referenceAvg > 0
          ? Math.round(((itemPrice - referenceAvg) / referenceAvg) * 1000) / 10
          : 0;

      // Step 3: Outlier & Fraud Filter Agent
      const fraudRes = await invokeSwarmLLM<{
        verdict: string;
        riskCategory: string;
        explanation: string;
      }>({
        role: 'outlierFilter',
        providerOverride: providerOverride as LLMProviderId | undefined,
        systemInstruction:
          'You are the Outlier & Fraud Filter Agent protecting a trading card & sports collectibles pricing graph from corruption. Using the deterministic price deviation computed by the graph database (note: if Reference Average is 0, this is the first opening comp for this grade so do not flag price deviation alone) and seller notes, decide VERIFY or QUARANTINE. Quarantine shill bids, mislabeled damaged/altered cards, or wrong-edition reprints.',
        prompt: `Raw Title: ${itemTitle}\nSeller Notes: ${itemNotes}\nListing Price USD: ${itemPrice}\nDeterministic Reference Average (${resolvedGrade}): ${referenceAvg}\nDeterministic Deviation Pct: ${deviationPct}%\nEdition Mismatch Flag: ${entityRes.data.editionMismatch}\nPre-Parser Risk Keywords: ${JSON.stringify({ condition: preParsed.conditionRiskKeywords, shill: preParsed.shillRiskKeywords, edition: preParsed.editionFlags })}`,
        jsonSchema: {
          verdict: {
            type: 'STRING',
            description: 'Strictly VERIFY or QUARANTINE',
          },
          riskCategory: {
            type: 'STRING',
            description:
              'NOMINAL, SHILL_BID, MISLABELED_CONDITION, or WRONG_EDITION',
          },
          explanation: {
            type: 'STRING',
            description:
              'Concise 1-sentence reason referencing deterministic deviation or condition evidence.',
          },
        },
      });

      const shouldQuarantine =
        fraudRes.data.verdict?.toUpperCase() === 'QUARANTINE' ||
        entityRes.data.editionMismatch ||
        (referenceAvg > 0 && Math.abs(deviationPct) >= 75);

      steps.push({
        agent: 'Outlier & Fraud Filter',
        status: shouldQuarantine ? 'FLAGGED' : 'PASSED',
        provider: `${fraudRes.providerLabel} (${fraudRes.model})`,
        latencyMs: fraudRes.latencyMs,
        summary: `${shouldQuarantine ? 'QUARANTINED' : 'VERIFIED'}${referenceAvg > 0 ? ` (${deviationPct >= 0 ? '+' : ''}${deviationPct}% vs $${referenceAvg.toLocaleString()} comp)` : ' (opening comp)'}: ${fraudRes.data.explanation}`,
        payload: {
          deterministicReferenceAvgUsd: referenceAvg,
          deterministicDeviationPct: deviationPct,
          ...fraudRes.data,
        },
      });

      // Step 4: Deterministic Graph Writer
      const committedSale = graphEngine.commitSale({
        assetId: resolvedAsset.id,
        rawTitle: itemTitle,
        grade: resolvedGrade,
        priceUsd: itemPrice,
        marketplaceId: itemMarketplace,
        date: itemDate,
        status: shouldQuarantine ? 'QUARANTINED' : 'VERIFIED',
        outlierReason: shouldQuarantine ? fraudRes.data.explanation : undefined,
        sourceNotes: itemNotes,
        ingestedBySwarm: true,
      });

      steps.push({
        agent: 'Graph Writer',
        status: shouldQuarantine ? 'FLAGGED' : 'COMMITTED',
        provider: 'Knowledge Graph Engine',
        latencyMs: 1,
        summary: shouldQuarantine
          ? `Stored quarantined node ${committedSale.id}; live ${resolvedAsset.id} averages protected.`
          : `Committed verified node ${committedSale.id} with SOLD_ON and IS_INSTANCE_OF edges; recalculated deterministic averages & arbitrage.`,
        payload: {
          saleId: committedSale.id,
          canonicalAssetId: resolvedAsset.id,
          status: committedSale.status,
        },
      });

      if (queueId) graphEngine.removeQueuedItem(String(queueId));

      const runRecord: SwarmRunRecord = {
        id: `RUN-${Date.now().toString().slice(-5)}`,
        timestamp: new Date().toISOString(),
        kind: 'LISTING',
        rawTitle: itemTitle,
        marketplaceId: itemMarketplace,
        priceUsd: itemPrice,
        verdict: shouldQuarantine ? 'QUARANTINED_OUTLIER' : 'COMMITTED_VERIFIED',
        resolvedAssetId: resolvedAsset.id,
        resolvedAssetTitle: resolvedAsset.title,
        resolvedGrade,
        steps,
        graphDiff: shouldQuarantine
          ? `Quarantined ${committedSale.id} (${resolvedAsset.id}) — pricing average untouched`
          : `+1 Verified Sale (${committedSale.id}) -[SOLD_ON $${itemPrice.toLocaleString()}]-> (${itemMarketplace})`,
      };

      graphEngine.addSwarmRun(runRecord);
      res.json({ run: runRecord, state: graphEngine.getState() });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Swarm ingestion failed while invoking server LLM.',
      });
    }
  });

  // --- Layer 2: Multi-Hop GraphRAG Query Console ---
  // Same grounding contract as /api/research/question: operator auth, strict
  // evidence-only prompt, and the deterministic groundGraphRagAnswer guardrail
  // are the last word over any provider output. Without a configured provider
  // (or insufficient evidence) the answer deflects rather than guessing.
  app.post('/api/graphrag/query', operatorAuth.requireAuth, async (req, res) => {
    try {
      const { question, providerOverride } = req.body ?? {};
      const allowedProviderOverride = sanitizeProviderOverride(providerOverride);
      const cleanQuestion = String(question || '').trim();
      if (!cleanQuestion) {
        res.status(400).json({ error: 'Please enter a GraphRAG question.' });
        return;
      }

      const traversal = graphEngine.runDeterministicGraphQuery(cleanQuestion);
      const structuredContextText = traversal.facts
        .map((f, i) => `- [gfact-${i}] ${f.label}: ${f.value} (${f.context})`)
        .join('\n');

      // Deterministic graph facts are the only evidence eligible to ground the
      // answer. Each fact carries a stable id the provider must cite; its value
      // and context carry the exact figures the guardrail will back.
      const evidenceFacts: GraphRagEvidenceFact[] = traversal.facts.map((f, i) => ({
        id: `gfact-${i}`,
        kind: 'graphFact',
        detail: `${f.label}: ${f.value} (${f.context})`,
      }));
      const evidenceIds = evidenceFacts.map((f) => f.id);
      // Basis is never defaulted: only grant a known basis when a deterministic
      // fact explicitly carries one; otherwise stay conservative.
      const knownBasis = evidenceFacts.some((f) =>
        /\b(SOLD|ASKING|GUIDE|CLAIM)\b/i.test(f.detail)
      );

      const graphRagSystemInstruction = [
        'You are the GraphRAG Quantitative Analyst inside SlabGraph, a deterministic GraphRAG terminal.',
        'GROUNDING RULES (absolute):',
        '- Answer ONLY from the deterministic Knowledge Graph facts supplied. They are authoritative; you may reorganize them but never add, invent, estimate, or recalculate prices, dates, grades, counts, or confidence.',
        '- Never output a numeric price unless that exact value appears in a supplied fact.',
        '- Cite the fact id in square brackets for every claim, e.g. [gfact-0]. An answer without at least one citation is not grounded.',
        '- Basis is never defaulted: SOLD, ASKING, GUIDE, and CLAIM are distinct and basis=UNKNOWN stays UNKNOWN.',
        '- DEFLECTION: if the facts are insufficient or do not support the question, reply with a synthesis that explicitly begins "Insufficient evidence" and states what is missing. Never bluff.',
        '- Confidence is a deterministic cap, never HIGH on your own authority.',
      ].join('\n');

      let draftSynthesis = '';
      let providerUsed: string | undefined;
      let modelUsed: string | undefined;
      let latencyMs = 0;
      const hasProvider = getAvailableProviders().some((p) => p.configured);
      if (hasProvider) {
        try {
          const synthesisRes = await invokeSwarmLLM<string>({
            role: 'graphRagSynthesis',
            providerOverride: allowedProviderOverride,
            systemInstruction: graphRagSystemInstruction,
            prompt: `User Question: ${cleanQuestion}\n\nExecuted Cypher Traversal:\n${traversal.cypherQuery}\n\nDeterministic Graph Results (Ground Truth):\n${structuredContextText}`,
          });
          draftSynthesis = typeof synthesisRes.data === 'string' ? synthesisRes.data : '';
          providerUsed = synthesisRes.providerLabel;
          modelUsed = synthesisRes.model;
          latencyMs = synthesisRes.latencyMs;
        } catch {
          // Provider unavailable: deterministic fallback (deflection) below.
          draftSynthesis = '';
        }
      }

      const grounded = groundGraphRagAnswer({
        question: cleanQuestion,
        draftSynthesis,
        evidenceFacts,
        evidenceIds,
        knownBasis,
      });

      res.json({
        question: cleanQuestion,
        cypherQuery: traversal.cypherQuery,
        matchedAssetIds: traversal.matchedAssetIds,
        matchedEventIds: traversal.matchedEventIds,
        deterministicFacts: traversal.facts,
        synthesis: grounded.synthesis,
        deflected: grounded.deflected,
        confidenceLabel: grounded.confidence,
        missingData: grounded.missingData,
        citations: grounded.citations,
        providerUsed: providerUsed ?? 'Deterministic Guardrail',
        modelUsed: modelUsed ?? 'In-Graph Engine',
        latencyMs,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'GraphRAG query synthesis failed.',
      });
    }
  });

  // --- Layer 2: NL-to-Cypher Query Builder & Subgraph Visualizer ---
  app.post('/api/graphrag/cypher-builder', async (req, res) => {
    try {
      const { naturalLanguage, rawCypher, mode, providerOverride } =
        req.body ?? {};

      if (mode === 'execute_cypher') {
        const cleanCypher = String(rawCypher || '').trim();
        if (!cleanCypher) {
          res.status(400).json({ error: 'Cypher query cannot be empty.' });
          return;
        }
        const start = Date.now();
        const executed = graphEngine.parseAndExecuteRawCypher(cleanCypher);
        res.json({
          naturalLanguage: String(naturalLanguage || 'Custom Cypher query'),
          cypherQuery: cleanCypher,
          explanation: `Executed custom Cypher traversal across ${executed.matchedAssetIds.length} asset(s) and ${executed.relationships.length} relationship edge(s).`,
          ...executed,
          providerUsed: 'Deterministic Cypher Evaluator',
          modelUsed: 'In-Graph Engine',
          latencyMs: Math.max(1, Date.now() - start),
        });
        return;
      }

      const nlQuestion = String(naturalLanguage || '').trim();
      if (!nlQuestion) {
        res
          .status(400)
          .json({ error: 'Please enter a natural language question.' });
        return;
      }

      const state = graphEngine.getState(true);
      const ontologyCatalog = {
        nodeLabels: [
          'Asset',
          'SetRelease',
          'Marketplace',
          'ListingSale',
          'MarketEvent',
        ],
        edgeTypes: [
          '(ListingSale)-[:IS_INSTANCE_OF {grade}]->(Asset)',
          '(ListingSale)-[:SOLD_ON {price, date}]->(Marketplace)',
          '(MarketEvent)-[:IMPACTED {priceDeltaPct, windowDays}]->(Asset)',
          '(Asset)-[:BELONGS_TO]->(SetRelease)',
        ],
        assets: state.assets.map((a) => ({
          id: a.id,
          title: a.title,
          segment: a.segment,
          franchise: a.franchise,
          topGradeAvg: state.valuations[a.id]?.topGradeAvg,
          gradeMultiplier: state.valuations[a.id]?.gradeMultiplier,
          bestArbSpreadPct: state.valuations[a.id]?.bestArbSpreadPct,
          quarantinedCount: state.valuations[a.id]?.quarantinedCount,
        })),
        marketplaces: state.marketplaces.map((m) => ({
          id: m.id,
          name: m.name,
          region: m.region,
        })),
        events: state.events.map((e) => ({
          id: e.id,
          title: e.title,
          category: e.category,
          impactedAssetIds: e.impactedAssetIds,
        })),
      };

      const llmRes = await invokeSwarmLLM<{
        cypherQuery: string;
        explanation: string;
        segment: 'ALL' | 'TCG' | 'SPORTS';
        franchises: string[];
        assetIds: string[];
        marketplaceIds: string[];
        eventIds: string[];
        includeSoldOn: boolean;
        includeImpacted: boolean;
        minMultiplier: number;
        minTopGradeUsd: number;
        minArbSpreadPct: number;
        onlyWithQuarantined: boolean;
      }>({
        role: 'graphRagSynthesis',
        providerOverride,
        systemInstruction:
          'You are a Neo4j Cypher Query Builder for SlabGraph, a universal TCG and Sports Collectibles Knowledge Graph. Convert the user natural language question into: (1) an idiomatic, valid Neo4j Cypher query referencing exact node labels (:Asset, :ListingSale, :Marketplace, :MarketEvent) and relationship types (:SOLD_ON, :IS_INSTANCE_OF, :IMPACTED), AND (2) exact structured filter parameters matching the live catalog so the deterministic graph visualizer highlights the matching nodes and edges. Leave array filters empty when the user asks broadly. Use 0 for numeric thresholds not requested.',
        prompt: `User Question: ${nlQuestion}\n\nLive Knowledge Graph Schema & Catalog:\n${JSON.stringify(ontologyCatalog)}`,
        jsonSchema: {
          cypherQuery: {
            type: 'STRING',
            description:
              'Formatted multi-line Neo4j Cypher query answering the user question.',
          },
          explanation: {
            type: 'STRING',
            description:
              'Concise 1-sentence explanation of the matched relationship pattern.',
          },
          segment: {
            type: 'STRING',
            description: 'Filter segment: ALL, TCG, or SPORTS',
          },
          franchises: {
            type: 'ARRAY',
            itemsType: 'STRING',
            description:
              'Matching franchise or sport names from catalog, or empty array.',
          },
          assetIds: {
            type: 'ARRAY',
            itemsType: 'STRING',
            description:
              'Specific canonical Asset IDs from catalog if targeted, or empty array.',
          },
          marketplaceIds: {
            type: 'ARRAY',
            itemsType: 'STRING',
            description:
              'Specific Marketplace IDs (ebay_sold, cardmarket, tcgplayer, pwcc, goldin, fanatics) if targeted, or empty array.',
          },
          eventIds: {
            type: 'ARRAY',
            itemsType: 'STRING',
            description:
              'Specific MarketEvent IDs if targeted, or empty array.',
          },
          includeSoldOn: {
            type: 'BOOLEAN',
            description: 'True to visualize SOLD_ON marketplace edges.',
          },
          includeImpacted: {
            type: 'BOOLEAN',
            description: 'True to visualize IMPACTED market event edges.',
          },
          minMultiplier: {
            type: 'NUMBER',
            description:
              'Minimum top-grade-to-PSA-9 multiplier threshold (0 if none).',
          },
          minTopGradeUsd: {
            type: 'NUMBER',
            description: 'Minimum top-grade average USD threshold (0 if none).',
          },
          minArbSpreadPct: {
            type: 'NUMBER',
            description:
              'Minimum net arbitrage spread percentage (0 if none).',
          },
          onlyWithQuarantined: {
            type: 'BOOLEAN',
            description:
              'True if user specifically asks for quarantined fraud/shill-bid outliers.',
          },
        },
      });

      const executed = graphEngine.executeCypherPlan(llmRes.data);

      res.json({
        naturalLanguage: nlQuestion,
        cypherQuery: llmRes.data.cypherQuery,
        explanation: llmRes.data.explanation,
        ...executed,
        providerUsed: llmRes.providerLabel,
        modelUsed: llmRes.model,
        latencyMs: llmRes.latencyMs,
      });
    } catch (err) {
      res.status(500).json({
        error:
          err instanceof Error
            ? err.message
            : 'Failed to translate natural language query into Cypher.',
      });
    }
  });

  // --- Layer 2: Community Summary Synthesis ---
  app.post(
    '/api/graphrag/community-summary',
    operatorAuth.requireAuth,
    async (req, res) => {
      try {
        const { communityId, providerOverride } = req.body ?? {};
        const state = graphEngine.getState();
        const target = state.communities.find((c) => c.id === communityId);
        if (!target) {
          res.status(404).json({ error: 'Community cluster not found.' });
          return;
        }
        if (target.assetIds.length === 0) {
          res.status(400).json({
            error:
              'This cluster has 0 assets. Register collectibles in this segment before synthesizing a community summary.',
          });
          return;
        }

        const clusterAssets = state.assets
          .filter((a) => target.assetIds.includes(a.id))
          .map((a) => ({
            id: a.id,
            title: a.title,
            franchise: a.franchise,
            valuation: state.valuations[a.id],
          }));

        const llmRes = await invokeSwarmLLM<string>({
          role: 'graphRagSynthesis',
          providerOverride: providerOverride as LLMProviderId | undefined,
          systemInstruction:
            'Write a crisp 2-sentence institutional GraphRAG Community Summary for this collectibles cluster. Cite only the exact deterministic figures provided.',
          prompt: `Cluster: ${target.title} (${target.eraLabel})\nCluster Stats: ${JSON.stringify(target.deterministicStats)}\nMembers: ${JSON.stringify(clusterAssets)}`,
        });

        graphEngine.updateCommunityNarrative(
          target.id,
          llmRes.data,
          `${llmRes.providerLabel} (${llmRes.model})`
        );

        res.json({
          communityId: target.id,
          narrative: llmRes.data,
          providerUsed: `${llmRes.providerLabel} (${llmRes.model})`,
          state: graphEngine.getState(),
        });
      } catch (err) {
        res.status(500).json({
          error:
            err instanceof Error
              ? err.message
              : 'Community summary synthesis failed.',
        });
      }
    }
  );

  // --- Personal Graded Portfolio Endpoints ---
  app.post('/api/portfolio/holdings', operatorAuth.requireAuth, (req, res) => {
    try {
      const {
        assetId,
        grade,
        quantity,
        costBasisUsd,
        acquiredDate,
        certNumber,
        vaultLocation,
        notes,
      } = req.body ?? {};

      if (!assetId || !(Number(costBasisUsd) >= 0)) {
        res.status(400).json({
          error: 'A canonical asset and valid cost basis USD are required.',
        });
        return;
      }

      const created = graphEngine.addPortfolioHolding({
        assetId: String(assetId).trim(),
        grade: normalizeGrade(grade, 'PSA 10'),
        quantity: Math.max(1, Math.round(Number(quantity) || 1)),
        costBasisUsd: Math.max(0, Number(costBasisUsd) || 0),
        acquiredDate: String(
          acquiredDate || new Date().toISOString().slice(0, 10)
        ).slice(0, 10),
        certNumber: certNumber ? String(certNumber).trim() : undefined,
        vaultLocation: String(vaultLocation || 'Personal Vault').trim(),
        notes: notes ? String(notes).trim() : undefined,
      });

      res.status(201).json({ holding: created, state: graphEngine.getState() });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to add portfolio holding.',
      });
    }
  });

  app.delete(
    '/api/portfolio/holdings/:id',
    operatorAuth.requireAuth,
    (req, res) => {
      const deleted = graphEngine.deletePortfolioHolding(req.params.id);
      if (!deleted) {
        res.status(404).json({ error: 'Portfolio holding not found.' });
        return;
      }
      res.json({ deleted: true, state: graphEngine.getState() });
    }
  );

  // --- Layer 3: Alert Rules & Live Webhook Dispatch (Discord / Telegram / Hermes) ---
  app.get('/api/alerts/channels', (_req, res) => {
    res.json(getAlertChannelStatus());
  });

  app.post('/api/alerts/dispatch', operatorAuth.requireAuth, async (req, res) => {
    try {
      const { channel, headline, detail, severity, payload } = req.body ?? {};
      const validChannel: AlertRule['channel'] =
        channel === 'Telegram Bot' ||
        channel === 'Hermes Webhook' ||
        channel === 'Terminal Feed'
          ? channel
          : 'Discord Webhook';

      const receipt = await dispatchAlertToChannel({
        channel: validChannel,
        headline: String(headline || 'SlabGraph Live Alert Test').trim(),
        detail: String(
          detail ||
            'Verified alert dispatch test from your self-hosted SlabGraph instance.'
        ).trim(),
        severity:
          severity === 'CRITICAL' || severity === 'MEDIUM' ? severity : 'HIGH',
        payload:
          payload && typeof payload === 'object'
            ? (payload as Record<string, unknown>)
            : undefined,
      });

      graphEngine.recordAlertDelivery(receipt);
      res.json({ receipt, state: graphEngine.getState() });
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof Error ? err.message : 'Alert webhook dispatch failed.',
      });
    }
  });

  app.post('/api/alerts/rules', operatorAuth.requireAuth, (req, res) => {
    const { name, metric, threshold, scopeSegment, channel } = req.body ?? {};
    if (!name || !metric) {
      res.status(400).json({ error: 'Rule name and metric are required.' });
      return;
    }

    const rule = graphEngine.addAlertRule({
      name: String(name).trim(),
      metric: metric as AlertRule['metric'],
      threshold: Number(threshold) || 10,
      scopeSegment:
        scopeSegment === 'TCG' || scopeSegment === 'SPORTS'
          ? scopeSegment
          : 'ALL',
      channel:
        channel === 'Telegram Bot' ||
        channel === 'Terminal Feed' ||
        channel === 'Hermes Webhook'
          ? channel
          : 'Discord Webhook',
      active: true,
    });

    res.status(201).json({ rule, state: graphEngine.getState() });
  });

  app.patch(
    '/api/alerts/rules/:id/toggle',
    operatorAuth.requireAuth,
    (req, res) => {
      const updated = graphEngine.toggleAlertRule(req.params.id);
      if (!updated) {
        res.status(404).json({ error: 'Alert rule not found.' });
        return;
      }
      res.json({ rule: updated, state: graphEngine.getState() });
    }
  );

  app.delete('/api/alerts/rules/:id', operatorAuth.requireAuth, (req, res) => {
    const deleted = graphEngine.deleteAlertRule(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Alert rule not found.' });
      return;
    }
    res.json({ deleted: true, state: graphEngine.getState() });
  });

  // --- Hermes Agent Bidirectional Gateway & Tool Bridge ---
  app.get('/api/hermes/status', (req, res) => {
    const appOrigin =
      process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL'
        ? process.env.APP_URL
        : `${req.protocol}://${req.get('host')}`;
    res.json(getHermesStatus(appOrigin));
  });

  app.post('/api/hermes/ping', async (_req, res) => {
    try {
      const result = await pingHermesGateway();
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : 'Unable to reach Hermes Gateway.',
      });
    }
  });

  app.post('/api/hermes/chat', operatorAuth.requireAuth, async (req, res) => {
    try {
      const prompt = String(req.body?.prompt || '').trim();
      const includeGraphSnapshot = req.body?.includeGraphSnapshot !== false;
      if (!prompt) {
        res.status(400).json({ error: 'Prompt message is required.' });
        return;
      }
      const result = await sendHermesConsoleMessage(
        prompt,
        includeGraphSnapshot
      );
      res.json(result);
    } catch (err) {
      res.status(502).json({
        error:
          err instanceof Error
            ? err.message
            : 'Hermes Agent chat call failed.',
      });
    }
  });

  app.post(
    '/api/hermes/webhook/dispatch',
    operatorAuth.requireAuth,
    async (req, res) => {
      try {
        const eventType = String(
          req.body?.eventType || 'HERMES_TEST_EVENT'
        ).trim();
        const payload =
          req.body?.payload && typeof req.body.payload === 'object'
            ? (req.body.payload as Record<string, unknown>)
            : {
                message: 'SlabGraph Hermes Webhook verification event',
                topArbitrage: graphEngine
                  .computeArbitrageOpportunities(true)
                  .slice(0, 2),
              };
        const result = await dispatchHermesWebhook(eventType, payload);
        res.json(result);
      } catch (err) {
        res.status(502).json({
          error:
            err instanceof Error
              ? err.message
              : 'Failed to dispatch webhook to Hermes Gateway.',
        });
      }
    }
  );

  app.get('/api/hermes/tools', (_req, res) => {
    res.json({
      service: 'SlabGraph Collectibles Knowledge Graph',
      version: '1.0',
      auth: process.env.HERMES_BRIDGE_TOKEN?.trim()
        ? 'Bearer token required in Authorization header'
        : 'Open mode (set HERMES_BRIDGE_TOKEN in server .env to require Bearer auth)',
      tools: HERMES_TOOL_DEFINITIONS,
    });
  });

  app.post('/api/hermes/tools/execute', (req, res) => {
    const auth = verifyHermesBridgeToken(req.headers.authorization);
    if (!auth.authorized) {
      res.status(401).json({
        error:
          'Unauthorized: valid Authorization: Bearer <HERMES_BRIDGE_TOKEN> header is required.',
      });
      return;
    }

    try {
      const toolName = String(req.body?.tool || '').trim();
      const args =
        req.body?.args && typeof req.body.args === 'object'
          ? (req.body.args as Record<string, unknown>)
          : {};
      if (!toolName) {
        res.status(400).json({ error: 'Tool name is required.' });
        return;
      }
      const execution = executeHermesTool(toolName, args);
      res.json({
        ...execution,
        state:
          toolName === 'ingest_market_listing'
            ? graphEngine.getState()
            : undefined,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Tool execution failed.',
      });
    }
  });

  app.post('/api/hermes/tools/preview', operatorAuth.requireAuth, (req, res) => {
    const requestedWith = req.headers['x-requested-with'];
    const origin = req.headers.origin;
    const host = req.headers['x-forwarded-host'] || req.headers.host;

    if (requestedWith !== 'SlabGraph-UI' || !origin || !host) {
      res.status(403).json({
        error:
          'Sandbox preview is restricted to same-origin UI requests. Use /api/hermes/tools/execute with Bearer authentication.',
      });
      return;
    }

    try {
      const parsedOrigin = new URL(origin);
      const expectedHost = Array.isArray(host) ? host[0] : host;
      if (parsedOrigin.host !== expectedHost) {
        res.status(403).json({
          error:
            'Cross-origin preview blocked; use /api/hermes/tools/execute with Bearer auth.',
        });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid Origin header.' });
      return;
    }

    try {
      const toolName = String(req.body?.tool || '').trim();
      const args =
        req.body?.args && typeof req.body.args === 'object'
          ? (req.body.args as Record<string, unknown>)
          : {};
      if (!toolName) {
        res.status(400).json({ error: 'Tool name is required.' });
        return;
      }
      if (
        toolName === 'ingest_market_listing' &&
        Boolean(process.env.HERMES_BRIDGE_TOKEN?.trim())
      ) {
        res.status(403).json({
          error:
            'HERMES_BRIDGE_TOKEN is active: run write tool ingest_market_listing via /api/hermes/tools/execute with your Bearer token.',
        });
        return;
      }
      const execution = executeHermesTool(toolName, args);
      res.json({
        ...execution,
        state:
          toolName === 'ingest_market_listing'
            ? graphEngine.getState()
            : undefined,
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Tool preview failed.',
      });
    }
  });

  // Serving routes come after the specific routes above but before the /api
  // catch-all: `/api/market/:id` must not shadow `/api/market/observations`.
  mountServingRoutes(app, { repositories: dataRepositories });

  // Return JSON 404 for unknown /api/* paths instead of serving index.html
  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  // --- Vite Dev Middleware / Production Static Hosting ---
  // Tests import createApp() and set SLABGRAPH_TEST_MODE so no dev watcher or
  // static host is attached (neither is needed to exercise the API).
  const testMode = process.env.SLABGRAPH_TEST_MODE === '1';
  const distPath = path.resolve(__dirname, 'dist');
  const isProd =
    !testMode &&
    process.env.NODE_ENV === 'production' &&
    fs.existsSync(distPath);

  if (isProd) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  } else if (!testMode) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  return app;
}

async function startServer() {
  const app = await createApp();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `SlabGraph self-hosted server (${process.env.NODE_ENV === 'production' ? 'production' : 'development'}) listening on http://0.0.0.0:${PORT}`
    );
  });
}

// Auto-start only when invoked directly (node server.ts / tsx server.ts).
// Importing this module from a test must not bind a port or start Vite.
const isMainModule =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  startServer().catch((err) => {
    console.error('Failed to start SlabGraph server:', err);
    process.exit(1);
  });
}
