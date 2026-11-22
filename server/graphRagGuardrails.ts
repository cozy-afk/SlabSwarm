/**
 * Task 7 — GraphRAG grounding guardrails.
 *
 * Deterministic facts are authority over LLM output. This module turns a raw
 * provider draft into a grounded response envelope, deflecting whenever a
 * claim is not backed by first-party evidence. It is intentionally a pure
 * function (no provider, no I/O) so the grounding rules are directly testable
 * and cannot be bypassed by a misbehaving model.
 *
 * Global constraints enforced here:
 *   - No invented prices: every numeric price in the answer must appear in an
 *     evidence fact that is actually supplied.
 *   - Unsupported claims deflect with "insufficient evidence", never a guess.
 *   - Basis is never defaulted: with no known market basis confidence is
 *     capped at LOW/UNKNOWN rather than assumed HIGH.
 *   - Missing evidence is UNKNOWN: no evidence => confidence UNKNOWN.
 *   - Citations required: a grounded answer must cite at least one evidence id
 *     using the [id] bracket form.
 */

export type GroundingConfidence = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

export interface GraphRagEvidenceFact {
  id: string;
  kind: string;
  detail: string;
}

export interface GraphRagGroundingInput {
  question: string;
  /** Raw synthesis text proposed by the provider (may be empty/undefined-ish). */
  draftSynthesis: string;
  /** Deterministic first-party facts eligible to ground the answer. */
  evidenceFacts: GraphRagEvidenceFact[];
  /** Ids of the supplied evidence facts (first-party only). */
  evidenceIds: string[];
  /** True only if at least one source carries a known basis (SOLD/ASKING/GUIDE/CLAIM). */
  knownBasis: boolean;
  /** Confidence band requested by the provider, capped by deterministic authority. */
  requestedConfidence?: string;
}

export interface GraphRagGroundedResult {
  synthesis: string;
  confidence: GroundingConfidence;
  missingData: string[];
  deflected: boolean;
  citations: string[];
}

const INSUFFICIENT_OPEN = 'Insufficient evidence';

/**
 * Extract currency-formatted numeric prices from text. Only currency amounts
 * (e.g. $1,250.00, $9.50, $20) count as prices — counts, grades and subquestion
 * numbers are deliberately ignored so the verifier does not over-deflect.
 */
export function extractNumericPrices(text: string): string[] {
  if (typeof text !== 'string') return [];
  // Match a dollar sign followed by a number with optional thousands groups
  // and optional decimals. Return the exact token for evidence comparison.
  const matches = text.match(/\$[0-9][0-9,]*(?:\.[0-9]+)?/g) ?? [];
  return matches;
}

function deflectionSynthesis(reason: string): string {
  return `${INSUFFICIENT_OPEN}: ${reason} No values are inferred.`;
}

/**
 * Deterministically ground a draft answer.
 *
 * Steps:
 *  1. No evidence -> deflect, confidence UNKNOWN, enumerate missing data.
 *  2. Reject any numeric price not present in an evidence fact (no invented prices).
 *  3. Require at least one [evidenceId] citation in the answer.
 *  4. Cap confidence: UNKNOWN without evidence, max LOW without known basis,
 *     max MEDIUM with known basis. NEVER HIGH from the model alone.
 */
export function groundGraphRagAnswer(input: GraphRagGroundingInput): GraphRagGroundedResult {
  const facts = Array.isArray(input.evidenceFacts) ? input.evidenceFacts : [];
  const ids = Array.isArray(input.evidenceIds) ? input.evidenceIds : [];
  const missingData: string[] = [];

  // Rule 1: without first-party evidence, no grounded answer is possible.
  if (facts.length === 0 || ids.length === 0) {
    missingData.push(
      'No first-party research sources, observations, or media evidence are available.'
    );
    if (!input.knownBasis) {
      missingData.push('No source with a known market basis (SOLD / ASKING / GUIDE / CLAIM) is available.');
    }
    return {
      synthesis: deflectionSynthesis(
        'no first-party evidence supports a grounded answer'
      ),
      confidence: 'UNKNOWN',
      missingData,
      deflected: true,
      citations: [],
    };
  }

  // Collect the numeric price tokens that the deterministic facts actually
  // contain. A provider may only reuse numbers present in this set.
  const backedPrices = new Set<string>();
  for (const fact of facts) {
    for (const price of extractNumericPrices(fact.detail)) backedPrices.add(price);
  }

  const draft = typeof input.draftSynthesis === 'string' ? input.draftSynthesis.trim() : '';
  const draftPrices = extractNumericPrices(draft);
  const unbackedPrices = draftPrices.filter((price) => !backedPrices.has(price));

  // Citations: evidence ids the draft actually references in [id] form.
  const citations = ids.filter((id) => draft.includes(`[${id}]`));

  // Rule 2 + Rule 3: invented prices or missing citations force deflection.
  if (unbackedPrices.length > 0 || citations.length === 0 || !draft) {
    if (unbackedPrices.length > 0) {
      missingData.push(
        `Unsupported numeric price(s) not present in first-party evidence: ${unbackedPrices.join(', ')}.`
      );
    }
    if (citations.length === 0) {
      missingData.push('Answer cites no first-party evidence id.');
    }
    if (!draft) {
      missingData.push('No synthesis was produced by the research provider.');
    }
    missingData.push('A cited, evidence-backed synthesis is required to answer with confidence.');
    return {
      synthesis: deflectionSynthesis(
        'the proposed answer is not grounded in cited first-party evidence'
      ),
      confidence: 'LOW',
      missingData,
      deflected: true,
      citations: [],
    };
  }

  // Rule 4: deterministic authority caps provider confidence. Basis is never
  // defaulted, so HIGH is never granted on the model's word alone.
  const requested = String(input.requestedConfidence ?? '').toUpperCase();
  let confidence: GroundingConfidence = 'LOW';
  if (input.knownBasis && (requested === 'MEDIUM' || requested === 'HIGH')) {
    confidence = 'MEDIUM';
  }

  if (missingData.length === 0) {
    missingData.push('No verified price comps are attached to this question.');
  }

  return {
    synthesis: draft,
    confidence,
    missingData,
    deflected: false,
    citations,
  };
}
