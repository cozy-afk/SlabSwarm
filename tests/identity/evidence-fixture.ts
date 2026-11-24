// Shared fixture: canonical evidence rows are required for a canonical
// observation to cite. This mirrors the projection the harvest shim performs
// from immutable ledger evidence (exact source + sourceRecordId).

import type { Repositories } from '../../server/db/repositories/index.ts';

export async function seedCanonicalEvidence(
  repos: Repositories,
  sourceId: string,
  externalId: string,
  observedAt = '2026-11-22T10:00:00.000Z',
): Promise<string> {
  const evidence = await repos.evidence.create({
    sourceId,
    sourceRecordId: externalId,
    checksum: `sha256-${sourceId}-${externalId}`,
    capturedAt: observedAt,
    observedAt,
    mimeType: 'application/json',
    rawRef: `ingest://${sourceId}/${externalId}`,
    parsedPayload: { record: { externalId } },
  });
  return evidence.id;
}
