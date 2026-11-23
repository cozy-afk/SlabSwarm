// Deterministic match-confidence assessment and configured quarantine floor.
//
// This module never calls a model and never decides canonical identity. It
// scores only hard attributes extracted by deterministic patterns, compares
// them with source-provided expectations (if any), and reports an explainable
// ACCEPT / QUARANTINE decision. A model may propose or explain a title; it is
// never a voting member of this gate.

import {
  extractHardAttributes,
  type HardAttributeName,
  type HardAttributeSet,
} from './hardAttributes.ts';

export const MATCH_CONFIDENCE_FLOOR_ENV = 'SLABGRAPH_MATCH_CONFIDENCE_FLOOR';
export const DEFAULT_MATCH_CONFIDENCE_FLOOR = 0.75;

const ATTRIBUTE_NAMES: HardAttributeName[] = [
  'gradingCompany', 'numericGrade', 'certNumber', 'serialRun', 'cardNumber',
];

export type MatchDecision = 'ACCEPT' | 'QUARANTINE';

export interface ExpectedAttributes {
  gradingCompany?: string | null;
  numericGrade?: string | null;
  certNumber?: string | null;
  serialRun?: string | null;
  cardNumber?: string | null;
}

export interface MatchAssessment {
  decision: MatchDecision;
  score: number;
  floor: number;
  titlePresent: boolean;
  attributes: HardAttributeSet;
  matched: HardAttributeName[];
  conflicts: HardAttributeName[];
  missing: HardAttributeName[];
  reasons: string[];
}

export interface AssessMatchInput {
  title?: unknown;
  expected?: ExpectedAttributes | null;
  floor?: number;
  /** Pre-extracted attributes; otherwise derived from `title`. */
  attributes?: HardAttributeSet;
}

/** Parse a configured floor without letting a bad value silently disable the gate. */
export function resolveConfidenceFloor(
  raw?: unknown,
  env: Record<string, string | undefined> = process.env,
): number {
  const value = raw !== undefined
    ? raw
    : env[MATCH_CONFIDENCE_FLOOR_ENV];
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1
    ? parsed
    : DEFAULT_MATCH_CONFIDENCE_FLOOR;
}

function comparable(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '') return '';
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) return String(Number(trimmed));
  return trimmed.toUpperCase().replace(/\s+/g, ' ');
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * Score hard-attribute agreement. Extraction quality contributes 60% and
 * corroboration of source-provided expectations 40%; each hard conflict costs
 * half a point. A title with no hard attributes has zero evidence and is
 * quarantined. No time, randomness or model output is consulted.
 */
export function assessMatch(input: AssessMatchInput): MatchAssessment {
  const title = typeof input.title === 'string' ? input.title : '';
  const titlePresent = title.trim() !== '';
  const attributes = input.attributes ?? extractHardAttributes(title);
  const floor = resolveConfidenceFloor(input.floor);

  if (!titlePresent && attributes.attributes.length === 0) {
    return {
      decision: 'ACCEPT',
      score: 1,
      floor,
      titlePresent: false,
      attributes,
      matched: [],
      conflicts: [],
      missing: [],
      reasons: ['NO_LISTING_TITLE'],
    };
  }

  const matched: HardAttributeName[] = [];
  const conflicts: HardAttributeName[] = [];
  const missing: HardAttributeName[] = [];
  const expected = input.expected ?? {};
  const expectedNames = ATTRIBUTE_NAMES.filter((name) => {
    const value = expected[name];
    return typeof value === 'string' && comparable(value) !== '';
  });

  for (const name of expectedNames) {
    const extracted = attributes[name];
    const wanted = comparable(expected[name]);
    if (extracted === null) {
      missing.push(name);
    } else if (comparable(extracted) === wanted) {
      matched.push(name);
    } else {
      conflicts.push(name);
    }
  }

  const found = attributes.attributes;
  const extractionScore = found.length === 0
    ? 0
    : found.reduce((sum, attribute) => sum + attribute.confidence, 0) / found.length;
  const supportScore = expectedNames.length === 0
    ? extractionScore
    : matched.length / expectedNames.length;
  const score = round(Math.max(0, Math.min(1,
    0.6 * extractionScore + 0.4 * supportScore - 0.5 * conflicts.length,
  )));

  const reasons: string[] = [];
  if (found.length === 0) reasons.push('NO_HARD_ATTRIBUTES');
  for (const name of conflicts) reasons.push(`HARD_ATTRIBUTE_CONFLICT:${name}`);
  if (score < floor) reasons.push('BELOW_CONFIDENCE_FLOOR');
  if (expectedNames.length === 0 && found.length > 0) reasons.push('NO_EXPECTED_ATTRIBUTES');
  if (conflicts.length === 0 && expectedNames.length > 0
    && matched.length === expectedNames.length && score >= floor) {
    reasons.push('HARD_ATTRIBUTES_CORROBORATED');
  }

  return {
    decision: conflicts.length === 0 && score >= floor ? 'ACCEPT' : 'QUARANTINE',
    score,
    floor,
    titlePresent,
    attributes,
    matched,
    conflicts,
    missing,
    reasons,
  };
}

/** Convenience for gates that only need the binary disposition. */
export function isQuarantined(assessment: MatchAssessment): boolean {
  return assessment.decision === 'QUARANTINE';
}

export default assessMatch;
