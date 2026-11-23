// Deterministic identity resolution and canonical promotion for free-feed
// proposals. No model call, no simulation, no price invention: every canonical
// value is copied from the source record, and every decision is computed from
// normalized fields with an explicit, auditable tie-break.
//
// This module's only value exports are the two names required by the brief:
// resolveCandidate() computes a decision; promoteToCanonical() commits it.

import { createHash } from 'node:crypto';
import type { MarketBasis, MarketObservation } from '../contracts/dataProduct.ts';
import type { FreeFeedRecord } from '../contracts/freeFeed.ts';
import {
  createDefaultRepositories,
  type Card,
  type IdentityDecisionRow,
  type AliasRow,
  type Repositories,
} from '../db/repositories/index.ts';
import {
  promoteCandidates,
  type PromotionResult,
} from '../ingest/promotion.ts';
import { sanitizeError } from '../ingest/runner.ts';
import type { ConfidenceBand, IngestCandidate } from '../ingest/types.ts';

const UNKNOWN = 'UNKNOWN';
const VALID_BASES: ReadonlySet<string> = new Set<MarketBasis>([
  'SOLD', 'ASKING', 'OFFER', 'GUIDE', 'CLAIM', 'POPULATION', 'UNKNOWN',
]);
const VALID_CONFIDENCES: ReadonlySet<string> = new Set([
  'HIGH', 'MEDIUM', 'LOW', 'UNKNOWN',
]);
const CONFIDENCE_SCORE: Record<ConfidenceBand, number> = {
  HIGH: 0.9, MEDIUM: 0.6, LOW: 0.3, UNKNOWN: 0,
};
const TRUST_RANK: Record<string, number> = {
  HIGH: 4, MEDIUM: 3, LOW: 2, UNKNOWN: 1,
};

/** Optional provenance a canonical proposal must carry, plus internal seams.
 * These are deliberately not part of the frozen FreeFeedRecord contract. */
interface Proposal extends FreeFeedRecord {
  capturedAt?: unknown;
  lineage?: unknown;
  confidence?: unknown;
  trustTier?: unknown;
  /** Test/host injection of canonical repositories; production uses default. */
  repositories?: unknown;
  /** Deterministic audit timestamp for tests; defaults to the wall clock. */
  now?: unknown;
}

export type IdentityRule =
  | 'EXACT_MATCH'
  | 'EXPLICIT_ALIAS'
  | 'UNKNOWN_COMPONENT';

export interface IdentityInputs {
  vertical: string;
  property: string;
  name: string;
  set: string;
  number: string;
  variant: string;
  rawName: string;
  rawSet: string;
  rawNumber: string;
  rawFinish: string;
}

export interface IdentityDecision {
  /** Deterministic exact-match key (candidate-scoped when a field is UNKNOWN). */
  identityKey: string;
  /** Surviving first-party card id: existing canonical id or deterministic id. */
  canonicalId: string;
  rule: IdentityRule;
  matchSource: 'NEW' | 'EXISTING_KEY' | 'EXPLICIT_ALIAS';
  inputs: IdentityInputs;
  evidenceId: string;
  candidateEvidenceIds: string[];
  /** Source ids absorbed into the survivor; empty unless a merge happened. */
  aliases: string[];
  merged: boolean;
  tieBreak: {
    reason: string;
    trustTier: ConfidenceBand;
    observedAt: string;
    evidenceId: string;
  };
  confidence: ConfidenceBand;
  decidedAt: string;
  /** Keys needed to reconstruct the pre-merge state; merges stay reversible. */
  originalIdentityKeys: string[];
  /** Card that survived, when one already existed. */
  survivorCardId: string | null;
}

export interface CanonicalWriteReport {
  /** True only when every expected canonical row (including the decision row
   * and, for a priced candidate, the observation) committed successfully. */
  accepted: boolean;
  evidenceId: string;
  /** Why the report is not a full commit, or an explicit catalog-only note. */
  reasons: string[];
  /** Promotion diagnostics and any commit failure, sanitised. */
  errors: string[];
  /** Candidate ids the deterministic promotion guard left without an observation. */
  unpromotedPriced: string[];
  decision: IdentityDecision | null;
  card: Card | null;
  observation: MarketObservation | null;
  aliases: AliasRow[];
  identityDecision: IdentityDecisionRow | null;
  promotion: PromotionResult | null;
}

function text(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : UNKNOWN;
}

function isUnknown(value: string): boolean {
  return value === UNKNOWN || value.trim() === '';
}

function normalize(value: string): string {
  return value.normalize('NFC').toLowerCase().trim();
}

/** Uppercase set codes per the design; UNKNOWN is preserved verbatim. */
function normalizeSet(value: string): string {
  return isUnknown(value) ? UNKNOWN : normalize(value).toUpperCase();
}

/** Strip leading '#' and leading zeros; '0' and '001' -> '0' and '1'. */
function normalizeNumber(value: string): string {
  if (isUnknown(value)) return UNKNOWN;
  return normalize(value).replace(/^#+/, '').replace(/^0+(?=\d)/, '');
}

function normalizeVariant(value: string): string {
  return isUnknown(value) ? UNKNOWN : normalize(value);
}

function normalizeBand(value: unknown): ConfidenceBand {
  return typeof value === 'string' && VALID_CONFIDENCES.has(value)
    ? value as ConfidenceBand
    : 'UNKNOWN';
}

function evidenceIdOf(proposal: Proposal): string {
  return `${text(proposal.sourceId)}:${text(proposal.externalId)}`;
}

function sourceScopedKey(evidenceId: string): string {
  return `free-feed\u001fsource\u001f${evidenceId}`;
}

function identityKeyOf(inputs: IdentityInputs, evidenceId: string, complete: boolean): string {
  const core = [
    'free-feed', inputs.vertical, inputs.property,
    inputs.name, inputs.set, inputs.number, inputs.variant,
  ].join('\u001f');
  // An incomplete record is never merged: its key is scoped to the one
  // candidate that supplied it. UNKNOWN survives as a value, never as zero.
  return complete ? core : `${core}\u001fUNKNOWN_COMPONENT\u001f${evidenceId}`;
}

function canonicalIdOf(identityKey: string): string {
  return `card-${createHash('sha256').update(identityKey).digest('hex').slice(0, 24)}`;
}

function repositoriesOf(proposal: Proposal): Repositories {
  const injected = proposal.repositories;
  if (
    injected && typeof injected === 'object'
    && 'cards' in injected && 'identityDecisions' in injected && 'aliases' in injected
  ) {
    return injected as Repositories;
  }
  return createDefaultRepositories();
}

/**
 * All canonical reads and writes for one proposal run in a single repository
 * transaction. Bundles built by createRepositories always provide `transaction`;
 * a legacy injected bundle without it still works but loses atomicity.
 */
function runInTransaction<T>(
  repos: Repositories,
  fn: (tx: Repositories) => Promise<T>,
): Promise<T> {
  return typeof repos.transaction === 'function' ? repos.transaction(fn) : fn(repos);
}

function decidedAtOf(proposal: Proposal): string {
  const now = proposal.now;
  const at = typeof now === 'function' ? (now as () => Date)() : undefined;
  return at instanceof Date && Number.isFinite(at.getTime())
    ? at.toISOString()
    : new Date().toISOString();
}

function facetsOf(card: Card): Record<string, unknown> {
  return card.facets && typeof card.facets === 'object'
    ? card.facets as Record<string, unknown>
    : {};
}

function evidenceIdFromCard(card: Card): string {
  return text(facetsOf(card).evidenceId) === UNKNOWN ? card.id : text(facetsOf(card).evidenceId);
}

/** Source schemes that are not first-party canonical ids. */
function isExternalCardId(id: string): boolean {
  return /^(tcg:|TCG-|scryfall:|pokemontcg:|carddex:|cardex:|web:)/i.test(id);
}

function trustOf(card: Card): ConfidenceBand {
  const facets = facetsOf(card);
  return normalizeBand(facets.trustTier ?? facets.confidence);
}

/**
 * Tie-break from the design: first accepted first-party id, then highest trust
 * tier (HIGH > MEDIUM > LOW > UNKNOWN), then earliest observedAt, then the
 * lexicographically smallest evidence id, then the card id as a final guard.
 */
function compareCards(a: Card, b: Card): number {
  const firstParty = Number(isExternalCardId(a.id)) - Number(isExternalCardId(b.id));
  if (firstParty !== 0) return firstParty;
  const trust = TRUST_RANK[trustOf(b)]! - TRUST_RANK[trustOf(a)]!;
  if (trust !== 0) return trust;
  const aObserved = text(facetsOf(a).observed_at) === UNKNOWN ? a.createdAt : text(facetsOf(a).observed_at);
  const bObserved = text(facetsOf(b).observed_at) === UNKNOWN ? b.createdAt : text(facetsOf(b).observed_at);
  const observed = aObserved.localeCompare(bObserved);
  if (observed !== 0) return observed;
  const evidence = evidenceIdFromCard(a).localeCompare(evidenceIdFromCard(b));
  if (evidence !== 0) return evidence;
  return a.id.localeCompare(b.id);
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function validateProposal(proposal: Proposal): string[] {
  const reasons: string[] = [];
  if (isUnknown(text(proposal.sourceId))) reasons.push('source is required (FreeFeedRecord.sourceId)');
  if (isUnknown(text(proposal.externalId))) reasons.push('source record id is required (FreeFeedRecord.externalId)');
  if (isUnknown(text(proposal.name))) reasons.push('name is required; UNKNOWN cannot form an identity');
  if (
    typeof proposal.observedAt !== 'string'
    || proposal.observedAt.trim() === ''
    || !Number.isFinite(Date.parse(proposal.observedAt))
  ) reasons.push('observed_at is required (FreeFeedRecord.observedAt)');
  if (
    typeof proposal.capturedAt !== 'string'
    || proposal.capturedAt.trim() === ''
    || !Number.isFinite(Date.parse(proposal.capturedAt))
  ) reasons.push('captured_at is required for a canonical write');
  if (
    !Array.isArray(proposal.lineage)
    || proposal.lineage.length === 0
    || !proposal.lineage.every((item) => typeof item === 'string' && item.trim() !== '')
  ) reasons.push('lineage is required for a canonical write');
  if (!VALID_CONFIDENCES.has(String(proposal.confidence))) {
    reasons.push('confidence is required (HIGH/MEDIUM/LOW/UNKNOWN)');
  }
  if (typeof proposal.basis !== 'string' || !VALID_BASES.has(proposal.basis)) {
    reasons.push('basis must be explicit (MarketBasis, UNKNOWN if not supplied)');
  }
  // UNKNOWN is an explicit sentinel for a catalog-only record, not a missing
  // value: an absent/empty currency is rejected, 'UNKNOWN' is accepted.
  if (typeof proposal.currency !== 'string' || proposal.currency.trim() === '') {
    reasons.push('currency is required (UNKNOWN if not supplied)');
  }
  if (isUnknown(text(proposal.license))) reasons.push('declared license is required');
  if (isUnknown(text(proposal.attribution))) reasons.push('attribution is required');
  return reasons;
}

/**
 * Compute the deterministic identity decision. Read-only: no canonical row is
 * written here; promoteToCanonical() is the only committing path.
 */
export async function resolveCandidate(candidate: FreeFeedRecord): Promise<IdentityDecision> {
  const proposal = candidate as Proposal;
  const repos = repositoriesOf(proposal);
  const evidenceId = evidenceIdOf(proposal);
  const rawName = text(proposal.name);
  const rawSet = text(proposal.set);
  const rawNumber = text(proposal.number);
  const rawFinish = text(proposal.finish);
  const inputs: IdentityInputs = {
    vertical: normalize(text(proposal.vertical)),
    property: normalize(text(proposal.property)),
    name: normalize(rawName),
    set: normalizeSet(rawSet),
    number: normalizeNumber(rawNumber),
    variant: normalizeVariant(rawFinish),
    rawName, rawSet, rawNumber, rawFinish,
  };
  const complete = !isUnknown(rawName) && !isUnknown(rawSet)
    && !isUnknown(rawNumber) && !isUnknown(text(proposal.property));
  const rule: IdentityRule = complete ? 'EXACT_MATCH' : 'UNKNOWN_COMPONENT';
  const identityKey = identityKeyOf(inputs, evidenceId, complete);
  const confidence = normalizeBand(proposal.confidence ?? proposal.trustTier);
  const decidedAt = decidedAtOf(proposal);
  const observedAt = text(proposal.observedAt);
  const incoming: IdentityDecision['tieBreak'] = {
    reason: 'NEW_FIRST_PARTY_ID',
    trustTier: confidence,
    observedAt,
    evidenceId,
  };

  const [byKey, aliasByEvidence, aliasByExternal] = await Promise.all([
    repos.cards.list({ identityKey }),
    repos.aliases.list({ alias: evidenceId }),
    repos.aliases.list({ alias: text(proposal.externalId) }),
  ]);
  const aliases = new Map<string, typeof aliasByEvidence[number]>();
  for (const row of [...aliasByEvidence, ...aliasByExternal]) aliases.set(row.id, row);
  const aliasCards = await Promise.all(
    [...aliases.values()].map((row) => repos.cards.get(row.entityId)),
  );
  const existing = new Map<string, Card>();
  for (const card of [...byKey, ...aliasCards]) {
    if (card && !existing.has(card.id)) existing.set(card.id, card);
  }

  if (existing.size === 0) {
    return {
      identityKey,
      canonicalId: canonicalIdOf(identityKey),
      rule,
      matchSource: 'NEW',
      inputs,
      evidenceId,
      candidateEvidenceIds: [evidenceId],
      aliases: [],
      merged: false,
      tieBreak: incoming,
      confidence,
      decidedAt,
      originalIdentityKeys: uniqueSorted([identityKey, sourceScopedKey(evidenceId)]),
      survivorCardId: null,
    };
  }

  const ordered = [...existing.values()].sort(compareCards);
  const survivor = ordered[0]!;
  const absorbed = ordered.slice(1);
  const survivorEvidenceId = evidenceIdFromCard(survivor);
  const absorbedEvidenceIds = absorbed.map(evidenceIdFromCard);
  const aliasesAbsorbed = uniqueSorted([
    ...absorbedEvidenceIds,
    ...(survivorEvidenceId === evidenceId ? [] : [evidenceId]),
  ]);
  const explicitAlias = byKey.length === 0 && aliases.size > 0;
  const decisionTieBreak: IdentityDecision['tieBreak'] = {
    reason: explicitAlias ? 'EXPLICIT_ALIAS_TARGET' : 'FIRST_ACCEPTED_CANONICAL_ID',
    trustTier: trustOf(survivor),
    observedAt: text(facetsOf(survivor).observed_at) === UNKNOWN
      ? survivor.createdAt
      : text(facetsOf(survivor).observed_at),
    evidenceId: survivorEvidenceId,
  };
  return {
    identityKey,
    canonicalId: survivor.id,
    rule: explicitAlias && complete ? 'EXPLICIT_ALIAS' : rule,
    matchSource: explicitAlias ? 'EXPLICIT_ALIAS' : 'EXISTING_KEY',
    inputs,
    evidenceId,
    candidateEvidenceIds: uniqueSorted([survivorEvidenceId, ...absorbedEvidenceIds, evidenceId]),
    aliases: aliasesAbsorbed,
    merged: aliasesAbsorbed.length > 0,
    tieBreak: decisionTieBreak,
    confidence,
    decidedAt,
    originalIdentityKeys: uniqueSorted([
      identityKey,
      ...ordered.map((card) => card.identityKey),
      sourceScopedKey(evidenceId),
    ]),
    survivorCardId: survivor.id,
  };
}

/** Validate provenance, then run every canonical write in one transaction.
 * `accepted` is true only when the card, aliases, decision row and (for a
 * priced proposal) the observation all committed; any failure rolls the whole
 * unit back and is reported, never hidden behind a partial success. */
export async function promoteToCanonical(candidate: FreeFeedRecord): Promise<CanonicalWriteReport> {
  const proposal = candidate as Proposal;
  const repos = repositoriesOf(proposal);
  const evidenceId = evidenceIdOf(proposal);
  const report: CanonicalWriteReport = {
    accepted: false,
    evidenceId,
    reasons: [],
    errors: [],
    unpromotedPriced: [],
    decision: null,
    card: null,
    observation: null,
    aliases: [],
    identityDecision: null,
    promotion: null,
  };

  // Nothing is written until every canonical provenance field is present.
  report.reasons = validateProposal(proposal);
  if (report.reasons.length > 0) return report;

  const provenance = {
    source: text(proposal.sourceId),
    basis: proposal.basis,
    currency: text(proposal.currency),
    observed_at: text(proposal.observedAt),
    captured_at: text(proposal.capturedAt),
    lineage: [...(proposal.lineage as string[])],
    confidence: proposal.confidence as ConfidenceBand,
    license: text(proposal.license),
    attribution: text(proposal.attribution),
  };
  const amount = proposal.amount;
  const priced = typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
  const hasPrice = priced && proposal.basis !== 'UNKNOWN';

  try {
    await runInTransaction(repos, async (tx) => {
      // Resolve inside the transaction: the surviving id is chosen against
      // the same state that this commit is about to mutate.
      const decision = await resolveCandidate(
        { ...proposal, repositories: tx } as FreeFeedRecord,
      );
      report.decision = decision;

      let card: Card | null = null;
      let observation: MarketObservation | null = null;
      const aliases: AliasRow[] = [];
      let decisionRow: IdentityDecisionRow | null = null;
      let promotion: PromotionResult | null = null;

      // Surviving card rows are never rewritten; only a new identity is inserted.
      const existingCard = decision.survivorCardId
        ? await tx.cards.get(decision.survivorCardId)
        : (await tx.cards.list({ identityKey: decision.identityKey }))[0] ?? null;
      const cardFromId = existingCard ?? await tx.cards.get(decision.canonicalId);
      card = cardFromId ?? await tx.cards.upsert({
        id: decision.canonicalId,
        name: text(proposal.name),
        setId: text(proposal.set),
        cardNumber: text(proposal.number),
        variant: decision.inputs.variant === UNKNOWN ? null : decision.inputs.variant,
        identityKey: decision.identityKey,
        facets: {
          vertical: text(proposal.vertical),
          property: text(proposal.property),
          set: text(proposal.set),
          number: text(proposal.number),
          finish: text(proposal.finish),
          normalizedName: decision.inputs.name,
          evidenceId,
          rule: decision.rule,
          matchSource: decision.matchSource,
          candidateEvidenceIds: decision.candidateEvidenceIds,
          ...provenance,
        },
        rawPayload: {
          sourceId: text(proposal.sourceId),
          externalId: text(proposal.externalId),
          sourceUrl: text(proposal.sourceUrl),
          license: text(proposal.license),
          attribution: text(proposal.attribution),
        },
      });
      const canonicalId = card.id;

      // A merge is reversible: absorbed ids are aliases and every original
      // identity key is kept in the decision row written below.
      for (const alias of decision.aliases) {
        aliases.push(await tx.aliases.upsert({
          entityId: canonicalId,
          alias,
          source: 'identity-resolver',
          confidence: CONFIDENCE_SCORE[decision.confidence],
        }));
      }

      if (hasPrice) {
        const ingestCandidate: IngestCandidate = {
          evidenceId,
          targetIdentityRef: canonicalId,
          basis: proposal.basis,
          amount,
          currency: text(proposal.currency),
          marketplace: null,
          observedAt: text(proposal.observedAt),
          status: 'RAW',
          parseStatus: 'PARSED',
          warnings: [],
          sourceId: text(proposal.sourceId),
          capturedAt: text(proposal.capturedAt),
          lineage: [...(proposal.lineage as string[])],
          confidence: proposal.confidence as ConfidenceBand,
          priceComponents: { ...provenance },
        };
        // Same deterministic promotion path, now bound to the transaction's
        // observation repository: no second valuation, no invented amount.
        promotion = await promoteCandidates({
          candidates: { list: async () => [ingestCandidate] },
          marketObservations: tx.marketObservations,
        });
        report.promotion = promotion;
        report.errors.push(...promotion.errors);
        report.unpromotedPriced = [...promotion.unpromotedPriced];
      }

      const observations = await tx.marketObservations.list({
        evidenceId,
        targetIdentityRef: canonicalId,
        basis: proposal.basis,
      });
      observation = observations[0] ?? null;

      if (
        hasPrice
        && (!observation
          || (promotion !== null && promotion.errors.length > 0)
          || (promotion !== null && promotion.unpromotedPriced.length > 0))
      ) {
        const detail = [
          promotion && promotion.errors.length > 0
            ? `promotion errors: ${promotion.errors.join('; ')}` : '',
          promotion && promotion.unpromotedPriced.length > 0
            ? `unpromoted priced candidates: ${promotion.unpromotedPriced.join(', ')}` : '',
          !observation ? `no canonical observation was committed for ${evidenceId}` : '',
        ].filter(Boolean).join('; ');
        // Throwing rolls back card/alias/decision writes too: a priced
        // proposal without its observation is never a committed success.
        throw new Error(`priced candidate ${evidenceId} has no fully committed observation: ${detail}`);
      }
      if (!hasPrice) {
        // Explicit, accepted exception: catalog-only rows have no price fact.
        report.reasons.push(
          `catalog-only: amount or basis is UNKNOWN; no price observation written for ${evidenceId}`,
        );
      }

      decisionRow = await tx.identityDecisions.create({
        targetRef: canonicalId,
        status: decision.merged ? 'MERGED' : 'ACCEPTED',
        candidates: decision.candidateEvidenceIds.map((item) => ({
          evidenceId: item,
          identityKey: decision.identityKey,
          rule: decision.rule,
        })),
        scores: {
          rule: decision.rule,
          matchSource: decision.matchSource,
          inputs: decision.inputs,
          identityKey: decision.identityKey,
          confidence: decision.confidence,
          basis: proposal.basis,
          currency: text(proposal.currency),
          observedAt: text(proposal.observedAt),
          capturedAt: text(proposal.capturedAt),
          lineage: [...(proposal.lineage as string[])],
          tieBreak: decision.tieBreak,
          aliases: decision.aliases,
          originalIdentityKeys: decision.originalIdentityKeys,
        },
        votes: [],
        contradictions: [],
        createdAt: decision.decidedAt,
      });

      // Publish canonical artifacts only after every row write succeeded.
      report.card = card;
      report.observation = observation;
      report.aliases = aliases;
      report.identityDecision = decisionRow;
    });
  } catch (error) {
    const message = sanitizeError(error);
    report.accepted = false;
    report.errors.push(message);
    report.reasons.push(`canonical commit failed for ${evidenceId}: ${message}`);
    // Diagnostics stay visible; no rolled-back row is reported as canonical.
    report.card = null;
    report.observation = null;
    report.aliases = [];
    report.identityDecision = null;
    return report;
  }

  report.accepted = true;
  return report;
}
