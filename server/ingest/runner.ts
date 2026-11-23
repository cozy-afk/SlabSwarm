// Ingest runner: fetch -> immutable evidence -> deterministic candidate
// observations -> run record. Cursors/watermarks come from the last
// successful run for the source; errors are captured, never thrown to the
// caller, and are sanitised so secrets cannot leak into a run record.

import { computeChecksum, createEvidenceService } from './evidence.ts';
import { normalizeRawItem } from './normalizer.ts';
import type {
  IngestAdapter,
  IngestCandidate,
  IngestRepositories,
  IngestRun,
  RunIngestOptions,
  RunIngestResult,
  RunCounts,
  RunError,
  StoredEvidenceRecord,
} from './types.ts';

export function sanitizeError(message: unknown, secrets: string[] = []): string {
  let text = message instanceof Error ? message.message : String(message ?? '');
  const envKey = process.env.TCGAPI_KEY ?? '';
  const all = [...secrets, envKey].filter(
    (value): value is string => typeof value === 'string' && value.length >= 4,
  );
  for (const secret of all) text = text.split(secret).join('[REDACTED]');
  return text.slice(0, 2000);
}

function emptyCounts(): RunCounts {
  return { fetched: 0, created: 0, duplicates: 0, failed: 0, candidates: 0 };
}

export async function runIngest(
  adapterOrId: IngestAdapter | string,
  repos: IngestRepositories,
  opts: RunIngestOptions = {},
): Promise<RunIngestResult> {
  let adapter: IngestAdapter;
  if (typeof adapterOrId === 'string') {
    if (!opts.registry) throw new Error(`registry required to resolve adapter: ${adapterOrId}`);
    adapter = opts.registry.get(adapterOrId);
  } else {
    adapter = adapterOrId;
  }

  const mode = opts.mode ?? 'forward';
  const capturedAt = opts.capturedAt ?? new Date().toISOString();
  const secrets = opts.secrets ?? [];
  const previous = mode === 'forward' ? await repos.runs.lastSuccessful(adapter.sourceId) : null;
  const watermarkIn = mode === 'forward' ? (previous?.watermarkOut ?? null) : null;
  const cursorIn = opts.cursor ?? (mode === 'forward' ? (previous?.cursorOut ?? null) : null);

  const run = await repos.runs.create({
    sourceId: adapter.sourceId,
    adapterId: adapter.id,
    mode,
    status: 'RUNNING',
    startedAt: capturedAt,
    finishedAt: null,
    cursorIn,
    cursorOut: cursorIn,
    watermarkIn,
    watermarkOut: watermarkIn,
    counts: emptyCounts(),
    errors: [],
    meta: {},
  });

  const counts = emptyCounts();
  const errors: RunError[] = [];
  const evidenceRecords: StoredEvidenceRecord[] = [];
  const candidates: IngestCandidate[] = [];
  const evidenceService = createEvidenceService(repos);
  let cursorOut = cursorIn;
  let meta: Record<string, unknown> = {};
  let status: IngestRun['status'] = 'COMPLETED';

  try {
    const fetched = await adapter.fetch({
      mode,
      since: watermarkIn,
      cursor: cursorIn,
      capturedAt,
      options: opts.options ?? {},
    });
    const items = Array.isArray(fetched.items) ? fetched.items : [];
    cursorOut = fetched.cursor ?? cursorIn;
    meta = fetched.meta ?? {};

    const parseErrors = Array.isArray(meta.parseErrors) ? (meta.parseErrors as RunError[]) : [];
    for (const parseError of parseErrors) {
      errors.push({
        nativeId: parseError.nativeId ?? null,
        message: sanitizeError(parseError.message, secrets),
      });
      counts.failed += 1;
    }

    // Forward mode is enforced here as well as in adapters: a buggy adapter
    // cannot re-emit records at or before the stored watermark.
    const eligible =
      mode === 'forward' && watermarkIn
        ? items.filter((item) => item.observedAt > watermarkIn)
        : items;
    counts.fetched = eligible.length;
    const observed: string[] = [];

    for (const item of eligible) {
      try {
        const checksum = item.checksum ?? computeChecksum(item.payload);
        const { record, created } = await evidenceService.createIdempotent({
          sourceId: adapter.sourceId,
          sourceRecordId: item.nativeId,
          sourceUri: item.sourceUri ?? null,
          capturedAt,
          observedAt: item.observedAt,
          checksum,
          mimeType: item.mimeType ?? 'application/json',
          license: null,
          rawRef: `ingest://${adapter.sourceId}/${encodeURIComponent(item.nativeId)}/${checksum}`,
          parsedPayload: item.payload,
          trustTier: 'UNKNOWN',
          lineage: [adapter.id, run.id],
        });
        evidenceRecords.push(record);
        if (created) counts.created += 1;
        else counts.duplicates += 1;

        const candidate = normalizeRawItem(item, record);
        const storedCandidate = await repos.candidates.create(candidate);
        const candidateId = (storedCandidate as { id?: string }).id ?? candidate.evidenceId;
        if (!candidates.some((existing) => (existing as { id?: string }).id === candidateId)) {
          candidates.push(storedCandidate);
          counts.candidates += 1;
        }
        observed.push(item.observedAt);
      } catch (error) {
        counts.failed += 1;
        errors.push({ nativeId: item.nativeId, message: sanitizeError(error, secrets) });
      }
    }

    const watermarkOut = observed.length
      ? observed.slice().sort().at(-1) ?? watermarkIn
      : watermarkIn;
    status = errors.length
      ? counts.created + counts.duplicates > 0
        ? 'PARTIAL'
        : 'FAILED'
      : 'COMPLETED';
    await repos.runs.update(run.id, {
      status,
      counts,
      errors,
      watermarkOut,
      cursorOut,
      meta,
      finishedAt: new Date().toISOString(),
    });
  } catch (error) {
    errors.push({ nativeId: null, message: sanitizeError(error, secrets) });
    counts.failed += 1;
    status = 'FAILED';
    await repos.runs.update(run.id, {
      status,
      counts,
      errors,
      cursorOut,
      meta,
      finishedAt: new Date().toISOString(),
    });
  }

  const finalRun = (await repos.runs.get(run.id)) ?? run;
  return { run: finalRun, evidence: evidenceRecords, candidates };
}
