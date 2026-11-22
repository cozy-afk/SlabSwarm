import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Express } from 'express';
import type { MediaAssetNode } from '../src/types/graph.ts';

// Isolate both the JSON store and the media blob directory.
const originalDataDir = process.env.SLABGRAPH_DATA_DIR;
const originalTestMode = process.env.SLABGRAPH_TEST_MODE;
let tempDataDir: string;
let storeMediaAsset: typeof import('../server/mediaStore.ts')['storeMediaAsset'];
let getMediaAsset: typeof import('../server/mediaStore.ts')['getMediaAsset'];
let createApp: typeof import('../server.ts')['createApp'];
let server: Server;
let baseUrl: string;

/** A tiny but valid PNG signature + payload, enough to hash and classify. */
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
    '0000000a49444154789c636000020000050001a5f645400000000049454e44ae426082',
  'hex',
);
const JPEG_BYTES = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffd9',
  'hex',
);
/** Distinct bytes for the API URI case so it does not dedupe to the module case. */
const API_JPEG_BYTES = Buffer.from(
  'ffd8ffe000104a46494600010100000100010000ffd9ffd8ffd9',
  'hex',
);
function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const API_PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000200000002080600000072b60d0900000000',
  'hex',
);

before(async () => {
  tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slabswarm-media-store-'));
  process.env.SLABGRAPH_DATA_DIR = tempDataDir;
  process.env.SLABGRAPH_TEST_MODE = '1';
  // Dynamic import AFTER overrides: graphEngine loads the temp store on import.
  ({ storeMediaAsset, getMediaAsset } = await import('../server/mediaStore.ts'));
  ({ createApp } = await import('../server.ts'));
  const app: Express = await createApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  if (server) server.close();
  if (originalDataDir === undefined) delete process.env.SLABGRAPH_DATA_DIR;
  else process.env.SLABGRAPH_DATA_DIR = originalDataDir;
  if (originalTestMode === undefined) delete process.env.SLABGRAPH_TEST_MODE;
  else process.env.SLABGRAPH_TEST_MODE = originalTestMode;
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Store module: bytes, metadata, dedupe, immutability
// ---------------------------------------------------------------------------

test('storeMediaAsset: image bytes create a record with checksum, MIME, dimensions, license and source', () => {
  const record = storeMediaAsset({
    kind: 'CARD_FRONT',
    bytes: PNG_BYTES,
    mimeType: 'image/png',
    width: 1,
    height: 1,
    license: 'CC-BY-4.0',
    attribution: 'Photographer A',
    sourceUrl: 'https://example.com/front.png',
    observedAt: '2026-11-22T00:00:00.000Z',
  });

  assert.ok(record.id, 'record must have an id');
  assert.equal(record.kind, 'CARD_FRONT');
  assert.equal(record.checksum_sha256, sha256(PNG_BYTES));
  assert.equal(record.mime_type, 'image/png');
  assert.equal(record.width, 1);
  assert.equal(record.height, 1);
  assert.equal(record.file_size_bytes, PNG_BYTES.length);
  assert.equal(record.license, 'CC-BY-4.0');
  assert.equal(record.attribution, 'Photographer A');
  assert.equal(record.source_url, 'https://example.com/front.png');
  assert.equal(record.observed_at, '2026-11-22T00:00:00.000Z');
  assert.equal(record.uri, null, 'bytes-backed asset has no external URI');
  assert.ok(record.blob_ref, 'bytes-backed asset must have a blob reference');
});

test('storeMediaAsset: raw bytes are written immutably under data/media/', () => {
  const bytes = Buffer.from('immutable raw payload - do not modify');
  const record = storeMediaAsset({
    kind: 'SLAB_LABEL',
    bytes,
    mimeType: 'image/png',
    license: 'ALL_RIGHTS_RESERVED',
    observedAt: '2026-11-22T00:00:00.000Z',
  });
  const blobPath = path.join(tempDataDir, 'media', path.basename(record.blob_ref!));
  assert.ok(fs.existsSync(blobPath), 'blob must be persisted under data/media/');
  assert.deepEqual(
    fs.readFileSync(blobPath),
    bytes,
    'persisted blob must equal the original bytes exactly',
  );
  assert.equal(record.checksum_sha256, sha256(bytes));
});

test('storeMediaAsset: URL reference stores uri + checksum without downloading', () => {
  const record = storeMediaAsset({
    kind: 'SELLER_PHOTO',
    uri: 'https://example.com/seller-listing.jpg',
    checksumSha256: sha256(JPEG_BYTES),
    mimeType: 'image/jpeg',
    license: 'CC0-1.0',
    sourceUrl: 'https://example.com/listing',
    observedAt: '2026-11-22T00:00:00.000Z',
  });
  assert.equal(record.uri, 'https://example.com/seller-listing.jpg');
  assert.equal(record.checksum_sha256, sha256(JPEG_BYTES));
  assert.equal(record.mime_type, 'image/jpeg');
  assert.equal(record.license, 'CC0-1.0');
  assert.equal(record.blob_ref, null, 'URL-only asset has no local blob');
});

test('storeMediaAsset: duplicate checksum dedupes to the original record', () => {
  const bytes = Buffer.from('dedupe-checksum-payload');
  const first = storeMediaAsset({
    kind: 'CARD_FRONT',
    bytes,
    mimeType: 'image/png',
    license: 'CC-BY-4.0',
    observedAt: '2026-11-22T00:00:00.000Z',
  });
  const second = storeMediaAsset({
    kind: 'CARD_BACK',
    bytes,
    mimeType: 'image/png',
    license: 'CC-BY-4.0',
    observedAt: '2026-11-23T00:00:00.000Z',
  });
  assert.equal(second.id, first.id, 'same checksum must return the same record');
  assert.equal(second.kind, first.kind, 'dedupe must not mutate the original');
});

test('storeMediaAsset: license is required for commercial use metadata', () => {
  assert.throws(
    () =>
      storeMediaAsset({
        kind: 'CARD_FRONT',
        bytes: PNG_BYTES,
        mimeType: 'image/png',
        license: '',
        observedAt: '2026-11-22T00:00:00.000Z',
      }),
    /license/i,
    'empty license must be rejected',
  );
});

test('storeMediaAsset: derived OCR/recognition fields live on the record, not on raw bytes', () => {
  const bytes = Buffer.from('ocr-derived-fields-payload');
  const stored = storeMediaAsset({
    kind: 'OCR_IMAGE',
    bytes,
    mimeType: 'image/png',
    license: 'CC-BY-4.0',
    observedAt: '2026-11-22T00:00:00.000Z',
  });
  assert.equal(stored.ocr_text ?? null, null, 'no derived OCR supplied => null');

  const derived = storeMediaAsset({
    id: stored.id,
    kind: 'OCR_IMAGE',
    bytes,
    mimeType: 'image/png',
    license: 'CC-BY-4.0',
    observedAt: '2026-11-22T00:00:00.000Z',
    ocrText: 'PSA 10 CHARIZARD',
    recognitionCandidates: [{ label: 'Charizard', score: 0.9 }],
    recognitionConfidence: 0.9,
    parserVersion: 'ocr-v2',
  });
  assert.equal(derived.id, stored.id, 'derived fields must attach to same asset');
  assert.equal(derived.ocr_text, 'PSA 10 CHARIZARD');
  assert.deepEqual(derived.recognition_candidates, [{ label: 'Charizard', score: 0.9 }]);
  assert.equal(derived.recognition_confidence, 0.9);
  assert.equal(derived.parser_version, 'ocr-v2');
  assert.equal(
    derived.checksum_sha256,
    stored.checksum_sha256,
    'derived fields cannot change the raw checksum',
  );
});

test('getMediaAsset: returns stored record by id and undefined for unknown id', () => {
  const stored = storeMediaAsset({
    kind: 'BOX',
    bytes: Buffer.from('get-by-id-payload'),
    mimeType: 'image/png',
    license: 'CC0-1.0',
    observedAt: '2026-11-22T00:00:00.000Z',
  });
  const found = getMediaAsset(stored.id);
  assert.ok(found, 'stored asset must be retrievable');
  assert.equal(found.id, stored.id);
  assert.equal(found.checksum_sha256, stored.checksum_sha256);
  assert.equal(getMediaAsset('does-not-exist'), undefined);
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

test('POST /api/media/ingest: stores bytes and returns a media record', async () => {
  const payload = {
    kind: 'SCREENSHOT',
    bytesBase64: API_PNG_BYTES.toString('base64'),
    mimeType: 'image/png',
    width: 2,
    height: 2,
    license: 'CC-BY-4.0',
    sourceUrl: 'https://example.com/screenshot.png',
    observedAt: '2026-11-22T00:00:00.000Z',
  };
  const res = await fetch(`${baseUrl}/api/media/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(
    res.status,
    201,
    `ingest should return 201, got ${res.status}`,
  );
  const body = (await res.json()) as { media?: MediaAssetNode };
  assert.ok(body.media, 'response must include the media record');
  assert.equal(body.media.kind, 'SCREENSHOT');
  assert.equal(body.media.checksum_sha256, sha256(API_PNG_BYTES));
  assert.equal(body.media.mime_type, 'image/png');
  assert.equal(body.media.license, 'CC-BY-4.0');
  assert.ok(body.media.id);

  const getRes = await fetch(`${baseUrl}/api/media/${body.media.id}`);
  assert.equal(getRes.status, 200);
  const fetched = (await getRes.json()) as { media?: MediaAssetNode };
  assert.equal(fetched.media?.id, body.media.id);
  assert.equal(fetched.media?.checksum_sha256, sha256(API_PNG_BYTES));
});

test('POST /api/media/ingest: URL reference with checksum is accepted', async () => {
  const payload = {
    kind: 'SELLER_PHOTO',
    uri: 'https://example.com/listing-photo.jpg',
    checksumSha256: sha256(API_JPEG_BYTES),
    mimeType: 'image/jpeg',
    license: 'CC0-1.0',
    sourceUrl: 'https://example.com/listing',
    observedAt: '2026-11-22T00:00:00.000Z',
  };
  const res = await fetch(`${baseUrl}/api/media/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  assert.equal(
    res.status,
    201,
    `ingest should return 201, got ${res.status}`,
  );
  const body = (await res.json()) as { media?: MediaAssetNode };
  assert.equal(body.media?.uri, payload.uri);
  assert.equal(body.media?.checksum_sha256, payload.checksumSha256);
  assert.equal(body.media?.blob_ref ?? null, null);
});

test('POST /api/media/ingest: duplicate checksum dedupes via the API', async () => {
  const bytes = Buffer.from('api-dedupe-payload');
  const payload = {
    kind: 'CARD_FRONT',
    bytesBase64: bytes.toString('base64'),
    mimeType: 'image/png',
    license: 'CC-BY-4.0',
    observedAt: '2026-11-22T00:00:00.000Z',
  };
  const first = await fetch(`${baseUrl}/api/media/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const second = await fetch(`${baseUrl}/api/media/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, kind: 'CARD_BACK' }),
  });
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  const a = (await first.json()) as { media: MediaAssetNode };
  const b = (await second.json()) as { media: MediaAssetNode };
  assert.equal(b.media.id, a.media.id, 'API must dedupe identical checksums');
});

test('POST /api/media/ingest: missing license is rejected', async () => {
  const res = await fetch(`${baseUrl}/api/media/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      kind: 'CARD_FRONT',
      bytesBase64: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
      observedAt: '2026-11-22T00:00:00.000Z',
    }),
  });
  assert.equal(res.status, 400, 'missing license must return 400');
});

test('GET /api/media/:id: unknown id returns 404', async () => {
  const res = await fetch(`${baseUrl}/api/media/no-such-id`);
  assert.equal(res.status, 404);
});
