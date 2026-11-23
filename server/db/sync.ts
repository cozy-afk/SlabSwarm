/** Sync the durable ingest ledger into the canonical Postgres repositories.
 *
 * The runtime ledger is the operational source of truth for ingestion. This
 * module projects it into the canonical tables without mutating the ledger or
 * inventing facts. It is idempotent and safe to rerun.
 */

import type { Repositories } from './repositories/index.ts';

type Row = Record<string, unknown>;

export interface SyncSnapshot {
  evidence: Row[];
  observations: Row[];
}

export interface SyncReport {
  evidence: number;
  cards: number;
  observations: number;
  errors: string[];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function payloadOf(row: Row): Row {
  const payload = row.parsedPayload;
  return payload && typeof payload === 'object' ? (payload as Row) : {};
}

/** Derive low-confidence catalog identity from evidence, never from guesswork. */
export function cardFromEvidence(row: Row): Row | null {
  const payload = payloadOf(row);
  const name = text(payload.name);
  if (!name) return null;
  const identityKey = text(payload.targetIdentityRef) ?? text(row.sourceRecordId);
  if (!identityKey) return null;
  return {
    name,
    identityKey,
    setId: text(payload.expansionName) ?? text(payload.setId) ?? null,
    cardNumber: text(payload.number) ?? text(payload.cardNumber) ?? null,
    variant: text(payload.variant) ?? text(payload.finish) ?? null,
    facets: payload,
    rawPayload: payload,
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function syncLedgerToPostgres(
  repos: Repositories,
  snapshot: SyncSnapshot,
): Promise<SyncReport> {
  const report: SyncReport = { evidence: 0, cards: 0, observations: 0, errors: [] };
  const cardKeys = new Set<string>();

  for (const row of snapshot.evidence ?? []) {
    const sourceId = text(row.sourceId);
    const sourceRecordId = text(row.sourceRecordId);
    const checksum = text(row.checksum);
    const mimeType = text(row.mimeType);
    const rawRef = text(row.rawRef);
    const capturedAt = text(row.capturedAt);
    const observedAt = text(row.observedAt);
    if (!sourceId || !sourceRecordId || !checksum || !mimeType || !rawRef || !capturedAt || !observedAt) {
      report.errors.push(`Evidence ${text(row.id) ?? '(unknown)'} is missing required provenance`);
      continue;
    }
    try {
      await repos.evidence.upsert({
        id: text(row.id) ?? undefined,
        sourceId,
        sourceRecordId,
        sourceUri: text(row.sourceUri) ?? null,
        capturedAt,
        observedAt,
        checksum,
        mimeType,
        license: text(row.license) ?? null,
        rawRef,
        parsedPayload: payloadOf(row),
        trustTier: (text(row.trustTier) as 'UNKNOWN' | 'LOW' | 'MEDIUM' | 'HIGH' | undefined) ?? undefined,
      } as Parameters<Repositories['evidence']['upsert']>[0]);
      report.evidence += 1;
    } catch (error) {
      report.errors.push(`Evidence ${text(row.id) ?? sourceRecordId}: ${errorText(error)}`);
      continue;
    }

    const card = cardFromEvidence(row);
    if (card && !cardKeys.has(String(card.identityKey))) {
      cardKeys.add(String(card.identityKey));
      try {
        await repos.cards.upsert(card as unknown as Parameters<Repositories['cards']['upsert']>[0]);
        report.cards += 1;
      } catch (error) {
        report.errors.push(`Card ${String(card.identityKey)}: ${errorText(error)}`);
      }
    }
  }

  for (const row of snapshot.observations ?? []) {
    const evidenceId = text(row.evidenceId);
    const targetIdentityRef = text(row.targetIdentityRef);
    const basis = text(row.basis);
    const currency = text(row.currency);
    const observedAt = text(row.observedAt);
    const amount = row.amount;
    if (!evidenceId || !targetIdentityRef || !basis || !currency || !observedAt ||
        typeof amount !== 'number' || !Number.isFinite(amount)) {
      report.errors.push(`Observation ${text(row.id) ?? '(unknown)'} is missing required provenance`);
      continue;
    }
    try {
      await repos.marketObservations.upsert({
        evidenceId,
        targetIdentityRef,
        basis: basis as Parameters<Repositories['marketObservations']['upsert']>[0]['basis'],
        amount,
        currency,
        marketplace: text(row.marketplace) ?? null,
        observedAt,
        priceComponents: row.priceComponents && typeof row.priceComponents === 'object'
          ? (row.priceComponents as Record<string, unknown>) : null,
        status: (text(row.status) as Parameters<Repositories['marketObservations']['upsert']>[0]['status']) ?? undefined,
      } as Parameters<Repositories['marketObservations']['upsert']>[0]);
      report.observations += 1;
    } catch (error) {
      report.errors.push(`Observation ${text(row.id) ?? evidenceId}: ${errorText(error)}`);
    }
  }

  return report;
}
