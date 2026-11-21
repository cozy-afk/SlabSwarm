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
