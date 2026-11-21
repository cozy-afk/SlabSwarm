import crypto from 'crypto';
import { GoogleGenAI } from '@google/genai';
import type {
  AssetNode,
  MarketEventNode,
  SemanticSearchHit,
  VectorIndexStatus,
} from '../src/types/graph.ts';
import type { StoredEmbeddingRecord } from './storage.ts';

const DEFAULT_GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';

function sha256Short(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function buildAssetEmbeddingText(asset: AssetNode): string {
  return [
    asset.title,
    asset.franchise,
    asset.segment,
    asset.setName,
    String(asset.releaseYear),
    asset.cardNumber,
    asset.variant,
    asset.subjectName,
  ]
    .filter(Boolean)
    .join(' | ');
}

export function buildEventEmbeddingText(ev: MarketEventNode): string {
  return [ev.title, ev.category, ev.sentiment, ev.summary]
    .filter(Boolean)
    .join(' | ');
}

export function isEmbeddingConfigured(): {
  configured: boolean;
  provider: 'gemini' | 'openai' | 'none';
  model: string;
} {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey && geminiKey !== 'MY_GEMINI_API_KEY') {
    return {
      configured: true,
      provider: 'gemini',
      model: process.env.GEMINI_EMBEDDING_MODEL?.trim() || DEFAULT_GEMINI_EMBEDDING_MODEL,
    };
  }
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  if (openaiKey) {
    return {
      configured: true,
      provider: 'openai',
      model: process.env.OPENAI_EMBEDDING_MODEL?.trim() || 'text-embedding-3-small',
    };
  }
  return { configured: false, provider: 'none', model: DEFAULT_GEMINI_EMBEDDING_MODEL };
}

export async function generateEmbeddingVector(
  text: string
): Promise<{ vector: number[]; model: string }> {
  const cfg = isEmbeddingConfigured();
  if (!cfg.configured) {
    throw new Error(
      'No server embedding provider configured. Set GEMINI_API_KEY (for gemini-embedding-2) or OPENAI_API_KEY on the server.'
    );
  }

  if (cfg.provider === 'gemini') {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY!,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });

    const response = await ai.models.embedContent({
      model: cfg.model,
      contents: text,
    });

    const values = response.embeddings?.[0]?.values;
    if (!values || values.length === 0) {
      throw new Error('Gemini embedding API returned an empty vector.');
    }
    return { vector: values, model: cfg.model };
  }

  // OpenAI-compatible embeddings fallback
  const baseUrl = (
    process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1'
  ).replace(/\/+$/, '');
  const res = await fetch(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: cfg.model, input: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding request failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const values = json.data?.[0]?.embedding;
  if (!values || values.length === 0) {
    throw new Error('OpenAI-compatible embedding API returned an empty vector.');
  }
  return { vector: values, model: cfg.model };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dot / denom : 0;
}

export function computeVectorIndexStatus(
  assets: AssetNode[],
  events: MarketEventNode[],
  store: Record<string, StoredEmbeddingRecord>
): VectorIndexStatus {
  const cfg = isEmbeddingConfigured();
  let indexedAssets = 0;
  let indexedEvents = 0;
  let lastIndexedAt: string | null = null;

  for (const a of assets) {
    const rec = store[`ASSET:${a.id}`];
    if (rec && rec.vector.length > 0) {
      indexedAssets += 1;
      if (!lastIndexedAt || rec.updatedAt > lastIndexedAt) {
        lastIndexedAt = rec.updatedAt;
      }
    }
  }

  for (const ev of events) {
    const rec = store[`EVENT:${ev.id}`];
    if (rec && rec.vector.length > 0) {
      indexedEvents += 1;
      if (!lastIndexedAt || rec.updatedAt > lastIndexedAt) {
        lastIndexedAt = rec.updatedAt;
      }
    }
  }

  return {
    configured: cfg.configured,
    provider: cfg.provider,
    model: cfg.model,
    indexedAssets,
    totalAssets: assets.length,
    indexedEvents,
    totalEvents: events.length,
    lastIndexedAt,
  };
}

export async function indexMissingNodes(
  assets: AssetNode[],
  events: MarketEventNode[],
  store: Record<string, StoredEmbeddingRecord>,
  forceAll = false
): Promise<{ newlyIndexed: number; totalIndexed: number; model: string }> {
  const cfg = isEmbeddingConfigured();
  if (!cfg.configured) {
    throw new Error(
      'Embedding model unavailable: configure GEMINI_API_KEY or OPENAI_API_KEY on the server.'
    );
  }

  let newlyIndexed = 0;

  for (const asset of assets) {
    const key = `ASSET:${asset.id}`;
    const text = buildAssetEmbeddingText(asset);
    const textHash = sha256Short(text);
    const existing = store[key];
    if (!forceAll && existing && existing.textHash === textHash && existing.vector.length > 0) {
      continue;
    }
    const { vector, model } = await generateEmbeddingVector(text);
    store[key] = {
      id: asset.id,
      kind: 'ASSET',
      textHash,
      model,
      vector,
      updatedAt: new Date().toISOString(),
    };
    newlyIndexed += 1;
  }

  for (const ev of events) {
    const key = `EVENT:${ev.id}`;
    const text = buildEventEmbeddingText(ev);
    const textHash = sha256Short(text);
    const existing = store[key];
    if (!forceAll && existing && existing.textHash === textHash && existing.vector.length > 0) {
      continue;
    }
    const { vector, model } = await generateEmbeddingVector(text);
    store[key] = {
      id: ev.id,
      kind: 'EVENT',
      textHash,
      model,
      vector,
      updatedAt: new Date().toISOString(),
    };
    newlyIndexed += 1;
  }

  // Prune stale keys no longer in the graph
  const validKeys = new Set([
    ...assets.map((a) => `ASSET:${a.id}`),
    ...events.map((e) => `EVENT:${e.id}`),
  ]);
  for (const key of Object.keys(store)) {
    if (!validKeys.has(key)) delete store[key];
  }

  return {
    newlyIndexed,
    totalIndexed: Object.keys(store).length,
    model: cfg.model,
  };
}

export async function searchSemanticNodes(
  query: string,
  assets: AssetNode[],
  events: MarketEventNode[],
  store: Record<string, StoredEmbeddingRecord>,
  topK = 8
): Promise<{ hits: SemanticSearchHit[]; mode: 'vector' | 'lexical'; model: string }> {
  const cfg = isEmbeddingConfigured();
  const assetMap = new Map(assets.map((a) => [a.id, a]));
  const eventMap = new Map(events.map((e) => [e.id, e]));

  const hasStoredVectors = Object.values(store).some((r) => r.vector.length > 0);

  if (cfg.configured && hasStoredVectors) {
    const { vector: queryVec, model } = await generateEmbeddingVector(query);
    const scored: SemanticSearchHit[] = [];

    for (const rec of Object.values(store)) {
      const score = cosineSimilarity(queryVec, rec.vector);
      if (rec.kind === 'ASSET') {
        const asset = assetMap.get(rec.id);
        if (!asset) continue;
        scored.push({
          id: asset.id,
          kind: 'ASSET',
          title: asset.title,
          subtitle: `${asset.franchise} · ${asset.setName} (${asset.releaseYear})`,
          score: Number(score.toFixed(4)),
        });
      } else {
        const ev = eventMap.get(rec.id);
        if (!ev) continue;
        scored.push({
          id: ev.id,
          kind: 'EVENT',
          title: ev.title,
          subtitle: `${ev.category} · ${ev.date}`,
          score: Number(score.toFixed(4)),
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return { hits: scored.slice(0, topK), mode: 'vector', model };
  }

  // Deterministic lexical fallback when vectors haven't been indexed yet
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);
  const scored: SemanticSearchHit[] = [];

  for (const a of assets) {
    const hay = buildAssetEmbeddingText(a).toLowerCase();
    const matches = tokens.filter((t) => hay.includes(t)).length;
    if (matches > 0 || tokens.length === 0) {
      scored.push({
        id: a.id,
        kind: 'ASSET',
        title: a.title,
        subtitle: `${a.franchise} · ${a.setName} (${a.releaseYear})`,
        score: tokens.length > 0 ? Number((matches / tokens.length).toFixed(4)) : 0,
      });
    }
  }

  for (const ev of events) {
    const hay = buildEventEmbeddingText(ev).toLowerCase();
    const matches = tokens.filter((t) => hay.includes(t)).length;
    if (matches > 0) {
      scored.push({
        id: ev.id,
        kind: 'EVENT',
        title: ev.title,
        subtitle: `${ev.category} · ${ev.date}`,
        score: Number((matches / tokens.length).toFixed(4)),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return { hits: scored.slice(0, topK), mode: 'lexical', model: 'lexical-fallback' };
}
