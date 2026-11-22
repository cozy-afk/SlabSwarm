/**
 * First-party media evidence store (Task 5).
 *
 * Raw image bytes are immutable: they are written once to `data/media/` under
 * a content-addressed filename and never modified. All derived data (OCR text,
 * recognition candidates/confidence, parser version) lives on the MediaAssetNode
 * record, separate from the bytes. A record requires license metadata; source
 * URL / checksum provenance is preserved. Duplicate checksums dedupe to the
 * first record — the canonical bytes are never overwritten.
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  MediaAssetDerivedPatch,
  MediaAssetNode,
  MediaKind,
} from '../src/types/graph.ts';
import { graphEngine } from './graphEngine.ts';

/** Lowercase 64-hex-digit SHA-256 digest, required for all stored checksums. */
export const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

export function isValidSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_PATTERN.test(value);
}

export interface StoreMediaAssetInput {
  /** Explicit id (used when attaching derived fields to an existing asset). */
  id?: string;
  kind: MediaKind;
  /** Raw bytes. Provide either bytes or uri (never both; bytes wins). */
  bytes?: Buffer;
  /** URL reference when bytes are not hosted locally. */
  uri?: string | null;
  /** Caller-supplied checksum for URL references (required for dedupe). */
  checksumSha256?: string | null;
  mimeType: string;
  width?: number | null;
  height?: number | null;
  /** Required license metadata for commercial use. */
  license: string;
  attribution?: string | null;
  sourceUrl?: string | null;
  sourceTerms?: string | null;
  usageRights?: string | null;
  observedAt: string;
  capturedAt?: string;
  tenantId?: string;
  sourceId?: string;
  sourceRecordId?: string;
  targetType?: MediaAssetNode['target_type'];
  targetId?: string | null;

  // Derived fields — stored on the record, never on the raw bytes.
  ocrText?: string | null;
  recognitionCandidates?: Record<string, unknown>[] | null;
  recognitionConfidence?: number | null;
  parserVersion?: string | null;
  visibleFacets?: string[];
}

function resolveMediaDir(): string {
  const configured = process.env.SLABGRAPH_DATA_DIR?.trim();
  const baseDir = configured ? path.resolve(configured) : path.resolve(process.cwd(), 'data');
  const mediaDir = path.resolve(baseDir, 'media');
  if (!mediaDir.startsWith(baseDir + path.sep)) {
    throw new Error('Invalid media storage path configuration.');
  }
  return mediaDir;
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

/**
 * Validate an optional image dimension: must be a finite positive integer
 * when supplied (null/undefined meaning "unknown" is allowed).
 */
function validateDimension(value: number | null | undefined, label: string): void {
  if (value === undefined || value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a finite positive integer.`);
  }
}

/** Require a caller-supplied checksum to be a lowercase 64-hex SHA-256 digest. */
function requireChecksum(value: unknown): string {
  if (!isValidSha256Hex(value)) {
    throw new Error('checksumSha256 must be a lowercase 64-character hex SHA-256 digest.');
  }
  return value;
}

/**
 * Store a media asset. Returns the canonical record — a duplicate checksum
 * returns the original record unchanged (except optional derived fields,
 * explicitly attached to the same record, never to a new one).
 */
export function storeMediaAsset(input: StoreMediaAssetInput): MediaAssetNode {
  const license = requireText(input.license, 'license');
  const mimeType = requireText(input.mimeType, 'mimeType');
  const observedAt = requireText(input.observedAt, 'observedAt');
  requireText(input.kind, 'kind');
  validateDimension(input.width, 'width');
  validateDimension(input.height, 'height');

  const bytes = input.bytes;
  const uri = input.uri ?? null;
  if (!bytes && !uri) throw new Error('Either bytes or uri is required.');
  if (bytes && uri) throw new Error('Provide either bytes or uri, not both.');
  if (uri !== null && typeof uri !== 'string') {
    throw new Error('uri must be a string.');
  }

  const checksum = bytes
    ? createHash('sha256').update(bytes).digest('hex')
    : requireChecksum(input.checksumSha256);

  // Deterministic dedupe: checksum is a fact about immutable raw content.
  const existing = graphEngine.getMediaAssetByChecksum(checksum);
  if (existing) {
    const derivedPatch: MediaAssetDerivedPatch = {};
    if (input.ocrText !== undefined) derivedPatch.ocr_text = input.ocrText;
    if (input.recognitionCandidates !== undefined) {
      derivedPatch.recognition_candidates = input.recognitionCandidates ?? undefined;
    }
    if (input.recognitionConfidence !== undefined) {
      derivedPatch.recognition_confidence = input.recognitionConfidence;
    }
    if (input.parserVersion !== undefined) derivedPatch.parser_version = input.parserVersion;
    if (input.visibleFacets !== undefined) derivedPatch.visible_facets = input.visibleFacets;
    return Object.keys(derivedPatch).length > 0
      ? graphEngine.updateMediaAssetDerived(existing.id, derivedPatch) ?? existing
      : existing;
  }

  let blobRef: string | null = null;
  if (bytes) {
    const mediaDir = resolveMediaDir();
    fs.mkdirSync(mediaDir, { recursive: true });
    // Content-addressed filename: no overwrite of an existing raw blob.
    const blobPath = path.join(mediaDir, `${checksum}.blob`);
    if (!fs.existsSync(blobPath)) fs.writeFileSync(blobPath, bytes, { flag: 'wx' });
    blobRef = `media/${checksum}.blob`;
  }

  const record: MediaAssetNode = {
    id: input.id ?? `media-${randomUUID()}`,
    media_id: input.id,
    kind: input.kind,
    target_type: input.targetType ?? 'unresolved',
    target_id: input.targetId ?? null,
    uri,
    blob_ref: blobRef,
    storage_provider: blobRef ? 'first-party-local' : null,
    checksum_sha256: checksum,
    mime_type: mimeType,
    width: input.width ?? null,
    height: input.height ?? null,
    file_size_bytes: bytes ? bytes.length : null,
    visible_facets: input.visibleFacets ?? [],
    ocr_text: input.ocrText ?? null,
    recognition_candidates: input.recognitionCandidates ?? [],
    recognition_confidence: input.recognitionConfidence ?? null,
    license,
    attribution: input.attribution ?? null,
    usage_rights: input.usageRights ?? null,
    source_url: input.sourceUrl ?? null,
    source_terms: input.sourceTerms ?? null,
    observed_at: observedAt,
    captured_at: input.capturedAt ?? observedAt,
    parser_version: input.parserVersion ?? null,
    tenantId: input.tenantId,
    sourceId: input.sourceId,
    source_record_id: input.sourceRecordId,
  };
  return graphEngine.addMediaAsset(record);
}

/** Retrieve a media record by id. Derived fields travel with the record. */
export function getMediaAsset(id: string): MediaAssetNode | undefined {
  return graphEngine.getMediaAssetById(id);
}
