export type MarketSegment = 'TCG' | 'SPORTS';

export type GradeLabel = 'PSA 10' | 'BGS 9.5' | 'PSA 9' | 'SGC 10' | 'Raw NM';

export type MarketplaceId =
  | 'ebay_sold'
  | 'tcgplayer'
  | 'cardmarket'
  | 'pwcc'
  | 'goldin'
  | 'fanatics';

export type LLMProviderId = 'gemini' | 'hermes' | 'openai' | 'anthropic' | 'ollama';

export type SwarmAgentRole =
  | 'entityResolution'
  | 'outlierFilter'
  | 'catalystSentiment'
  | 'graphRagSynthesis';

export interface MarketplaceNode {
  id: MarketplaceId;
  name: string;
  region: string;
  sellerFeePct: number;
  settlementType: 'Auction' | 'Buy-It-Now' | 'Orderbook';
}

export interface SetReleaseNode {
  id: string;
  name: string;
  franchise: string;
  segment: MarketSegment;
  releaseYear: number;
  eraCluster: string;
}

export interface SubjectNode {
  id: string;
  name: string;
  role: string;
  segment: MarketSegment;
  franchise: string;
}

export interface GradePopMetric {
  grade: GradeLabel;
  gradingCompany: 'PSA' | 'BGS' | 'SGC' | 'Raw';
  popCount: number;
  gemRatePct: number;
}

export interface AssetNode {
  id: string;
  title: string;
  segment: MarketSegment;
  franchise: string;
  setId: string;
  setName: string;
  releaseYear: number;
  cardNumber: string;
  variant: string;
  subjectId: string;
  subjectName: string;
  communityId: string;
  visualTheme: 'vintage_holo' | 'arcane_artifact' | 'modern_foil' | 'sports_chrome';
  grades: GradePopMetric[];
}

export interface ListingSaleNode {
  id: string;
  assetId: string;
  rawTitle: string;
  grade: GradeLabel;
  priceUsd: number;
  marketplaceId: MarketplaceId;
  date: string;
  status: 'VERIFIED' | 'QUARANTINED';
  outlierReason?: string;
  sourceNotes?: string;
  ingestedBySwarm?: boolean;
}

export interface MarketEventNode {
  id: string;
  title: string;
  date: string;
  category:
    | 'Tournament Meta'
    | 'Set Release'
    | 'Ban List'
    | 'Championship / Milestone'
    | 'Pop Report Shift';
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  impactedAssetIds: string[];
  priceDeltaPct: number;
  windowDays: number;
  summary: string;
}

export interface HistoryPoint {
  date: string;
  psa10: number;
  psa9: number;
  raw: number;
  eventTitle?: string;
}

export interface AssetValuation {
  assetId: string;
  topGradeLabel: GradeLabel;
  topGradeAvg: number;
  topGradeMedian: number;
  midGradeAvg: number;
  rawAvg: number;
  gradeMultiplier: number;
  movingAvg7d: number;
  movingAvg30d: number;
  movingAvg90d: number;
  bidAskSpreadPct: number;
  change30dPct: number;
  verifiedSaleCount: number;
  quarantinedCount: number;
  topGradePop: number;
  gemRatePct: number;
  bestArbSpreadPct: number;
  history: HistoryPoint[];
}

export interface ArbitrageOpportunity {
  id: string;
  assetId: string;
  assetTitle: string;
  franchise: string;
  segment: MarketSegment;
  grade: GradeLabel;
  buyMarketplaceId: MarketplaceId;
  buyMarketplaceName: string;
  buyAvgPrice: number;
  sellMarketplaceId: MarketplaceId;
  sellMarketplaceName: string;
  sellAvgPrice: number;
  sellerFeePct: number;
  netSellProceeds: number;
  netProfitUsd: number;
  netSpreadPct: number;
  supportingSales: number;
}

export interface CommunitySummary {
  id: string;
  title: string;
  segment: MarketSegment | 'CROSS_MARKET';
  eraLabel: string;
  assetIds: string[];
  deterministicStats: {
    assetCount: number;
    avg30dChangePct: number;
    avgGradeMultiplier: number;
    totalVerifiedVolumeUsd: number;
    activeCatalysts: number;
  };
  narrative: string;
  lastUpdated: string;
  providerUsed?: string;
}

export interface LLMProviderInfo {
  id: LLMProviderId;
  label: string;
  defaultModel: string;
  configured: boolean;
  envHint: string;
  description: string;
  credentialFields: string[];
  hasStoredCredentials: boolean;
}

export interface SwarmRoutingConfig {
  entityResolution: LLMProviderId;
  outlierFilter: LLMProviderId;
  catalystSentiment: LLMProviderId;
  graphRagSynthesis: LLMProviderId;
}

export interface QueuedRawListing {
  id: string;
  kind: 'LISTING' | 'CATALYST';
  rawTitle: string;
  marketplaceId: MarketplaceId;
  priceUsd: number;
  date: string;
  sellerNotes: string;
  expectedSignalHint: string;
}

export interface SwarmStepTrace {
  agent:
    | 'Deterministic Parser'
    | 'Entity Resolution Agent'
    | 'Outlier & Fraud Filter'
    | 'Catalyst & Sentiment Agent'
    | 'Graph Writer';
  status: 'PASSED' | 'FLAGGED' | 'SKIPPED' | 'COMMITTED';
  provider: string;
  latencyMs: number;
  summary: string;
  payload: Record<string, unknown>;
}

export interface SwarmRunRecord {
  id: string;
  timestamp: string;
  kind: 'LISTING' | 'CATALYST';
  rawTitle: string;
  marketplaceId: MarketplaceId;
  priceUsd: number;
  verdict: 'COMMITTED_VERIFIED' | 'QUARANTINED_OUTLIER' | 'CATALYST_INJECTED';
  resolvedAssetId: string | null;
  resolvedAssetTitle: string | null;
  resolvedGrade: GradeLabel | null;
  steps: SwarmStepTrace[];
  graphDiff: string;
}

export interface GraphRagQueryResult {
  question: string;
  cypherQuery: string;
  matchedAssetIds: string[];
  matchedEventIds: string[];
  deterministicFacts: Array<{
    label: string;
    value: string;
    context: string;
  }>;
  synthesis: string;
  providerUsed: string;
  modelUsed: string;
  latencyMs: number;
}

export interface CypherQueryPlan {
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
}

export interface CypherSubgraphEdge {
  id: string;
  fromId: string;
  fromLabel: string;
  fromType: 'ASSET' | 'MARKETPLACE' | 'EVENT';
  toId: string;
  toLabel: string;
  toType: 'ASSET' | 'MARKETPLACE' | 'EVENT';
  edgeType: 'SOLD_ON' | 'IMPACTED';
  relationLabel: string;
  metricText: string;
}

export interface CypherBuilderResult {
  naturalLanguage: string;
  cypherQuery: string;
  explanation: string;
  plan: CypherQueryPlan;
  matchedAssetIds: string[];
  matchedMarketplaceIds: string[];
  matchedEventIds: string[];
  relationships: CypherSubgraphEdge[];
  providerUsed: string;
  modelUsed: string;
  latencyMs: number;
}

export interface AlertRule {
  id: string;
  name: string;
  metric: 'ARB_SPREAD_PCT' | 'PRICE_SWING_30D' | 'OUTLIER_DETECTED' | 'CATALYST_IMPACT';
  threshold: number;
  scopeSegment: MarketSegment | 'ALL';
  channel: 'Discord Webhook' | 'Telegram Bot' | 'Hermes Webhook' | 'Terminal Feed';
  active: boolean;
}

export interface TriggeredAlert {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: 'HIGH' | 'MEDIUM' | 'CRITICAL';
  channel: AlertRule['channel'];
  assetId?: string;
  assetTitle?: string;
  headline: string;
  deterministicDetail: string;
  timestamp: string;
  webhookPayload: Record<string, unknown>;
}

export interface HermesToolDefinition {
  name: string;
  description: string;
  method: 'POST';
  endpoint: string;
  sampleArgs: Record<string, unknown>;
}

export interface HermesToolRunResult {
  tool: string;
  executedAt: string;
  latencyMs: number;
  result: Record<string, unknown>;
}

export interface HermesWebhookDispatchResult {
  delivered: boolean;
  httpStatus: number;
  latencyMs: number;
  signed: boolean;
  eventType: string;
  responsePreview: string;
}

export interface HermesStatusPayload {
  apiGateway: {
    configured: boolean;
    endpointPreview: string | null;
    model: string;
    apiKeyConfigured: boolean;
  };
  webhookGateway: {
    configured: boolean;
    endpointPreview: string | null;
    hmacSigningEnabled: boolean;
  };
  inboundBridge: {
    manifestUrl: string;
    executeUrl: string;
    bearerTokenProtected: boolean;
    toolCount: number;
  };
  tools: HermesToolDefinition[];
  snippets: {
    hermesEnv: string;
    hermesConfigYaml: string;
    curlBridge: string;
  };
}

export interface PortfolioHolding {
  id: string;
  assetId: string;
  grade: GradeLabel;
  quantity: number;
  costBasisUsd: number;
  acquiredDate: string;
  certNumber?: string;
  vaultLocation: string;
  notes?: string;
}

export interface PortfolioHoldingValuation extends PortfolioHolding {
  assetTitle: string;
  franchise: string;
  segment: MarketSegment;
  unitMarketValueUsd: number;
  totalCostBasisUsd: number;
  totalMarketValueUsd: number;
  unrealizedPnlUsd: number;
  unrealizedPnlPct: number;
  pricingSource: 'VERIFIED_GRADE_COMP' | 'NO_VERIFIED_COMPS';
}

export interface PortfolioSummary {
  holdings: PortfolioHoldingValuation[];
  totalHoldingsCount: number;
  totalUnits: number;
  totalCostBasisUsd: number;
  totalMarketValueUsd: number;
  totalUnrealizedPnlUsd: number;
  totalUnrealizedPnlPct: number;
}

export interface AlertChannelStatus {
  discord: { configured: boolean; hint: string };
  telegram: { configured: boolean; hint: string };
  hermes: { configured: boolean; hint: string };
}

export interface AlertDeliveryReceipt {
  id: string;
  channel: AlertRule['channel'];
  headline: string;
  delivered: boolean;
  httpStatus: number;
  timestamp: string;
  detail: string;
}

export interface VectorIndexStatus {
  configured: boolean;
  provider: 'gemini' | 'openai' | 'none';
  model: string;
  indexedAssets: number;
  totalAssets: number;
  indexedEvents: number;
  totalEvents: number;
  lastIndexedAt: string | null;
}

export interface SemanticSearchHit {
  id: string;
  kind: 'ASSET' | 'EVENT';
  title: string;
  subtitle: string;
  score: number;
}

export interface AuthStatusPayload {
  locked: boolean;
  source: 'env' | 'claimed' | 'open';
  authenticated: boolean;
}

export interface StorageStatusPayload {
  engine: string;
  filePath: string;
  fileSizeBytes: number;
  lastSavedAt: string | null;
}

export interface GraphStatePayload {
  assets: AssetNode[];
  sets: SetReleaseNode[];
  subjects: SubjectNode[];
  marketplaces: MarketplaceNode[];
  sales: ListingSaleNode[];
  events: MarketEventNode[];
  valuations: Record<string, AssetValuation>;
  arbitrage: ArbitrageOpportunity[];
  communities: CommunitySummary[];
  queuedFeed: QueuedRawListing[];
  swarmRuns: SwarmRunRecord[];
  alertRules: AlertRule[];
  triggeredAlerts: TriggeredAlert[];
  alertDeliveries: AlertDeliveryReceipt[];
  alertChannels: AlertChannelStatus;
  portfolio: PortfolioSummary;
  vectorIndex: VectorIndexStatus;
  storage: StorageStatusPayload;
  onboardingCompleted: boolean;
  kpis: {
    canonicalAssets: number;
    verifiedSales: number;
    quarantinedOutliers: number;
    activeArbitrageCount: number;
    topArbitrageSpreadPct: number;
    trackedFranchises: string[];
  };
}

// ---------------------------------------------------------------------------
// First-party commercial research and market schema (additive).
// These types are normative: external APIs are adapters that write into them,
// never the source of the schema. Existing interfaces above are unchanged.
// ---------------------------------------------------------------------------

export type MarketBasis =
  | 'SOLD'
  | 'ASKING'
  | 'OFFER'
  | 'GUIDE'
  | 'CLAIM'
  | 'POPULATION'
  | 'UNKNOWN';

export type ValuationBasisPolicy =
  | 'buyer_landed_cost'
  | 'seller_net_proceeds'
  | 'item_only'
  | 'guide'
  | 'asking'
  | 'offer'
  | 'derived_model';

/**
 * Single source of truth for the supported first-party media kinds. The
 * `MediaKind` type is derived from this tuple so runtime validation and the
 * type system can never drift apart.
 */
export const MEDIA_KINDS = [
  'CARD_FRONT',
  'CARD_BACK',
  'SLAB_LABEL',
  'PACK',
  'BOX',
  'SELLER_PHOTO',
  'SCREENSHOT',
  'OCR_IMAGE',
] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

// First-party grade label for market observations. Grading is source-provided
// text (e.g. "PSA 10", "BGS 9.5", "CGC 8.5", "Raw NM"), validated by the
// grading_company / certificate_number provenance on the observation rather
// than by the legacy GradeLabel union.
export type MarketGradeLabel = string;

// Typed evidence extractable from a research source. These are the facet and
// evidence kinds named by the design spec (identity-resolution facets plus the
// claim/price/population evidence kinds used by the research layer).
export type ResearchObservationKind =
  | 'CLAIM'
  | 'ISSUER'
  | 'SET'
  | 'NUMBER'
  | 'NAME'
  | 'FINISH'
  | 'PARALLEL'
  | 'RARITY'
  | 'LANGUAGE'
  | 'GRADE'
  | 'SERIAL'
  | 'CONDITION'
  | 'QUANTITY'
  | 'PRICE'
  | 'POPULATION'
  | 'MARKET'
  | 'OTHER';

export interface PriceComponents {
  listed_amount: number;
  item_amount: number | null;
  shipping_amount: number | null;
  shipping_included: boolean | null;
  shipping_estimated: boolean | null;
  shipping_source: string | null;
  buyer_premium: number | null;
  platform_fee: number | null;
  seller_fee: number | null;
  tax_amount: number | null;
  fee_basis: string | null;
  lot_quantity: number;
  lot_total_amount: number | null;
  per_card_allocation_method: string | null;
  currency: string;
  fx_rate_to_base: number | null;
  fx_source: string | null;
  fx_as_of: string | null;
  // Real-value outputs: unknown is null, never zero. Derived with FX provenance
  // from the raw components above; never overwrite listed_amount.
  landed_cost_buyer: number | null;
  net_seller_proceeds: number | null;
  normalized_item_value: number | null;
  normalization_reason_codes: string[];
  normalization_confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';
}

export interface MarketObservation {
  id: string;
  tenantId: string;
  targetIdentityRef: string;
  sourceId: string;
  sourceFeedType: string;
  nativeSourceRecordId: string;
  observed_at: string;
  source_date: string | null;
  source_timeframe: string | null;
  source_date_assumed: boolean;
  captured_at: string;
  basis: MarketBasis;
  currency: string;
  amount: number;
  fees: number | null;
  shipping_amount: number | null;
  tax_amount: number | null;
  quantity: number;
  price_kind: string;
  marketplace: string;
  region: string;
  seller_hashed_id: string | null;
  buyer_hashed_id: string | null;
  condition: string | null;
  condition_source: string | null;
  language: string | null;
  finish: string | null;
  grade: MarketGradeLabel | null;
  grading_company: string | null;
  certificate_number: string | null;
  raw_evidence: Record<string, unknown>;
  checksum_sha256: string | null;
  mime_type: string | null;
  source_url: string | null;
  confidence: number;
  confidence_band: 'HIGH' | 'MEDIUM' | 'LOW';
  confidence_reasons: string[];
  exact_dedupe_key: string | null;
  near_dedupe_key: string | null;
  cluster_id: string | null;
  reconciliation_policy: string | null;
  status: 'ACTIVE' | 'QUARANTINED' | 'SUPERSEDED' | 'RECONCILED';
  lineage_pointer: string | null;
  priceComponents: PriceComponents;
}

export interface MediaAssetNode {
  id: string;
  media_id?: string;
  tenantId?: string;
  sourceId?: string;
  source_record_id?: string;
  kind: MediaKind;
  target_type:
    | 'Card'
    | 'Printing'
    | 'PrintingInstance'
    | 'SealedProduct'
    | 'CustomCollectible'
    | 'unresolved';
  target_id: string | null;
  uri: string | null;
  blob_ref?: string | null;
  storage_provider?: string | null;
  checksum_sha256: string;
  mime_type: string;
  width?: number | null;
  height?: number | null;
  file_size_bytes?: number | null;
  crop_geometry?: Record<string, unknown> | null;
  perspective_correction?: Record<string, unknown> | null;
  visible_facets?: string[];
  ocr_text?: string | null;
  recognition_candidates?: Record<string, unknown>[];
  recognition_confidence?: number | null;
  license: string;
  attribution?: string | null;
  usage_rights?: string | null;
  source_url?: string | null;
  source_terms?: string | null;
  retention_state?: string | null;
  observed_at: string;
  captured_at?: string;
  parser_version?: string | null;
  decision_id?: string | null;
}

/**
 * Fields that may be attached to an existing media asset after ingest.
 * Derived data (OCR/recognition/parser) is mutable; immutable raw-content
 * fields (kind, bytes, checksum, license, mime, dimensions, source) are not.
 */
export type MediaAssetDerivedPatch = Pick<
  MediaAssetNode,
  | 'ocr_text'
  | 'recognition_candidates'
  | 'recognition_confidence'
  | 'parser_version'
  | 'visible_facets'
>;

export interface ResearchSourceNode {
  id: string;
  type:
    | 'USER_NOTE'
    | 'RAW_LISTING'
    | 'CSV_IMPORT'
    | 'SCREENSHOT'
    | 'NEWS'
    | 'EVENT'
    | 'PACK_PULL'
    | 'POPULATION_REPORT'
    | 'API_RESULT';
  title: string;
  rawText: string;
  tags: string[];
  basis: MarketBasis;
  capturedAt: string;
  tenantId?: string;
  raw_payload?: Record<string, unknown>;
  checksum_sha256?: string | null;
  source_url?: string | null;
}

export interface ResearchObservationNode {
  id: string;
  sourceId: string;
  kind: ResearchObservationKind;
  value: string;
  confidence: number;
  evidenceIds: string[];
  createdAt: string;
}

export interface ResearchNoteNode {
  id: string;
  question: string;
  subquestions: string[];
  evidenceIds: string[];
  synthesis: string;
  confidence: number;
  missingData: string[];
  createdAt: string;
}

export interface ResearchProjectionNode {
  id: string;
  assetId: string;
  horizon: string;
  currentValue: number;
  projectedValue: number;
  currency: string;
  drivers: string[];
  invalidationConditions: string[];
  confidence: number;
  createdAt: string;
}

export interface IdentityDecision {
  id: string;
  version: number;
  targetRef: string;
  status: 'RESOLVED' | 'AMBIGUOUS' | 'QUARANTINED' | 'REJECTED';
  candidates: Array<{ ref: string; score: number }>;
  scores: Record<string, number>;
  votes: Array<{ role: SwarmAgentRole; vote: string }>;
  contradictions: string[];
  reviewerAction: 'PENDING' | 'APPROVED' | 'REJECTED' | 'NONE';
  decidedAt: string;
}
