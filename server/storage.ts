import fs from 'fs';
import path from 'path';
import type {
  AlertDeliveryReceipt,
  AlertRule,
  AssetNode,
  IdentityDecision,
  ListingSaleNode,
  MarketEventNode,
  MarketObservation,
  MediaAssetNode,
  PortfolioHolding,
  QueuedRawListing,
  ResearchNoteNode,
  ResearchObservationNode,
  ResearchProjectionNode,
  ResearchSourceNode,
  SetReleaseNode,
  SubjectNode,
  SwarmRunRecord,
} from '../src/types/graph.ts';

export interface StoredEmbeddingRecord {
  id: string;
  kind: 'ASSET' | 'EVENT';
  textHash: string;
  model: string;
  vector: number[];
  updatedAt: string;
}

export interface PersistedGraphDatabase {
  schemaVersion: number;
  onboardingCompleted: boolean;
  adminPasscodeHash: string | null;
  sets: SetReleaseNode[];
  subjects: SubjectNode[];
  assets: AssetNode[];
  sales: ListingSaleNode[];
  events: MarketEventNode[];
  queuedFeed: QueuedRawListing[];
  swarmRuns: SwarmRunRecord[];
  alertRules: AlertRule[];
  alertDeliveries: AlertDeliveryReceipt[];
  portfolioHoldings: PortfolioHolding[];
  customCommunityNarratives: Record<
    string,
    { narrative: string; lastUpdated: string; providerUsed: string }
  >;
  embeddings: Record<string, StoredEmbeddingRecord>;
  // First-party commercial research collections (additive in schemaVersion 2).
  researchSources: ResearchSourceNode[];
  researchObservations: ResearchObservationNode[];
  researchNotes: ResearchNoteNode[];
  researchProjections: ResearchProjectionNode[];
  mediaAssets: MediaAssetNode[];
  marketObservations: MarketObservation[];
  identityDecisions: IdentityDecision[];
  updatedAt: string;
}

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), 'data');

function resolveDataFilePath(): { dir: string; filePath: string } {
  const configured = process.env.SLABGRAPH_DATA_DIR?.trim();
  const baseDir = configured ? path.resolve(configured) : DEFAULT_DATA_DIR;
  const filePath = path.resolve(baseDir, 'slabgraph-db.json');

  // Strict directory confinement check
  if (!filePath.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid SLABGRAPH_DATA_DIR path configuration.');
  }

  return { dir: baseDir, filePath };
}

export function createEmptyDatabase(): PersistedGraphDatabase {
  return {
    schemaVersion: 2,
    onboardingCompleted: false,
    adminPasscodeHash: null,
    sets: [],
    subjects: [],
    assets: [],
    sales: [],
    events: [],
    queuedFeed: [],
    swarmRuns: [],
    alertRules: [],
    alertDeliveries: [],
    portfolioHoldings: [],
    customCommunityNarratives: {},
    embeddings: {},
    researchSources: [],
    researchObservations: [],
    researchNotes: [],
    researchProjections: [],
    mediaAssets: [],
    marketObservations: [],
    identityDecisions: [],
    updatedAt: new Date().toISOString(),
  };
}

export function loadPersistedDatabase(): PersistedGraphDatabase {
  const { dir, filePath } = resolveDataFilePath();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(filePath)) {
    const empty = createEmptyDatabase();
    savePersistedDatabase(empty);
    return empty;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PersistedGraphDatabase>;
    const base = createEmptyDatabase();
    return {
      ...base,
      ...parsed,
      // Additive migration: legacy v1 files gain the new collections and are
      // treated as v2 in memory. All existing fields from `parsed` are kept.
      schemaVersion: 2,
      sets: Array.isArray(parsed.sets) ? parsed.sets : [],
      subjects: Array.isArray(parsed.subjects) ? parsed.subjects : [],
      assets: Array.isArray(parsed.assets) ? parsed.assets : [],
      sales: Array.isArray(parsed.sales) ? parsed.sales : [],
      events: Array.isArray(parsed.events) ? parsed.events : [],
      queuedFeed: Array.isArray(parsed.queuedFeed) ? parsed.queuedFeed : [],
      swarmRuns: Array.isArray(parsed.swarmRuns) ? parsed.swarmRuns : [],
      alertRules: Array.isArray(parsed.alertRules) ? parsed.alertRules : [],
      alertDeliveries: Array.isArray(parsed.alertDeliveries)
        ? parsed.alertDeliveries
        : [],
      portfolioHoldings: Array.isArray(parsed.portfolioHoldings)
        ? parsed.portfolioHoldings
        : [],
      customCommunityNarratives:
        parsed.customCommunityNarratives &&
        typeof parsed.customCommunityNarratives === 'object'
          ? parsed.customCommunityNarratives
          : {},
      embeddings:
        parsed.embeddings && typeof parsed.embeddings === 'object'
          ? parsed.embeddings
          : {},
      researchSources: Array.isArray(parsed.researchSources)
        ? parsed.researchSources
        : [],
      researchObservations: Array.isArray(parsed.researchObservations)
        ? parsed.researchObservations
        : [],
      researchNotes: Array.isArray(parsed.researchNotes) ? parsed.researchNotes : [],
      researchProjections: Array.isArray(parsed.researchProjections)
        ? parsed.researchProjections
        : [],
      mediaAssets: Array.isArray(parsed.mediaAssets) ? parsed.mediaAssets : [],
      marketObservations: Array.isArray(parsed.marketObservations)
        ? parsed.marketObservations
        : [],
      identityDecisions: Array.isArray(parsed.identityDecisions)
        ? parsed.identityDecisions
        : [],
    };
  } catch (err) {
    console.error('Failed to parse persisted SlabGraph store, initializing clean store:', err);
    return createEmptyDatabase();
  }
}

export function savePersistedDatabase(db: PersistedGraphDatabase): void {
  const { dir, filePath } = resolveDataFilePath();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db.updatedAt = new Date().toISOString();
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

export function getStorageStatus(): {
  engine: string;
  filePath: string;
  fileSizeBytes: number;
  lastSavedAt: string | null;
} {
  const { filePath } = resolveDataFilePath();
  let fileSizeBytes = 0;
  let lastSavedAt: string | null = null;
  if (fs.existsSync(filePath)) {
    const stat = fs.statSync(filePath);
    fileSizeBytes = stat.size;
    lastSavedAt = stat.mtime.toISOString();
  }
  return {
    engine: 'Self-Hosted Atomic Disk Store (JSON WAL)',
    filePath: path.relative(process.cwd(), filePath) || filePath,
    fileSizeBytes,
    lastSavedAt,
  };
}
