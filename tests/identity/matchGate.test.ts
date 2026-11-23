// Task 16: deterministic match-confidence gate and configured floor. The gate
// reads only extracted hard attributes; no model proposes or decides identity.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_MATCH_CONFIDENCE_FLOOR,
  MATCH_CONFIDENCE_FLOOR_ENV,
  assessMatch,
  resolveConfidenceFloor,
  type ExpectedAttributes,
} from '../../server/identity/matchGate.ts';

const EXPECTED: ExpectedAttributes = {
  gradingCompany: 'PSA',
  numericGrade: '10',
  certNumber: '12345678',
  cardNumber: '4',
};

test('the confidence floor is configured from env with a validated default', () => {
  assert.equal(resolveConfidenceFloor(undefined, {}), DEFAULT_MATCH_CONFIDENCE_FLOOR);
  assert.equal(resolveConfidenceFloor('0.81', {}), 0.81);
  assert.equal(resolveConfidenceFloor(0.9, {}), 0.9);
  assert.equal(resolveConfidenceFloor('nonsense', {}), DEFAULT_MATCH_CONFIDENCE_FLOOR);
  assert.equal(resolveConfidenceFloor('2', {}), DEFAULT_MATCH_CONFIDENCE_FLOOR);
  assert.equal(
    resolveConfidenceFloor(undefined, { [MATCH_CONFIDENCE_FLOOR_ENV]: '0.88' }),
    0.88,
  );
});

test('a record with no listing title is accepted unchanged for legacy facts', () => {
  const decision = assessMatch({ title: undefined });

  assert.equal(decision.titlePresent, false);
  assert.equal(decision.decision, 'ACCEPT');
  assert.equal(decision.score, 1);
  assert.ok(decision.reasons.includes('NO_LISTING_TITLE'));
  assert.deepEqual(decision.attributes.attributes, []);
});

test('a fully corroborated hard-attribute title is accepted above the floor', () => {
  const decision = assessMatch({
    title: 'Charizard #4 PSA 10 GEM MT cert #12345678',
    expected: EXPECTED,
    floor: 0.75,
  });

  assert.equal(decision.decision, 'ACCEPT');
  assert.ok(decision.score >= decision.floor, `score ${decision.score}`);
  assert.deepEqual([...decision.matched].sort(), ['cardNumber', 'certNumber', 'gradingCompany', 'numericGrade']);
  assert.deepEqual(decision.conflicts, []);
  assert.ok(decision.reasons.includes('HARD_ATTRIBUTES_CORROBORATED'));
  assert.deepEqual(assessMatch({
    title: 'Charizard #4 PSA 10 GEM MT cert #12345678',
    expected: EXPECTED,
    floor: 0.75,
  }), decision, 'the assessment is deterministic');
});

test('a conflicting cert or grading company is quarantined even with a high extraction score', () => {
  const decision = assessMatch({
    title: 'Charizard #4 PSA 10 cert #87654321',
    expected: EXPECTED,
    floor: 0.75,
  });

  assert.equal(decision.decision, 'QUARANTINE');
  assert.deepEqual(decision.conflicts, ['certNumber']);
  assert.ok(decision.reasons.some((reason) => reason.startsWith('HARD_ATTRIBUTE_CONFLICT:')));
  assert.ok(decision.score < decision.floor);
});

test('a weak uncorroborated title falls below the configured floor', () => {
  const decision = assessMatch({
    title: 'mystery slab maybe 7',
    expected: { gradingCompany: 'PSA' },
    floor: 0.9,
  });

  assert.equal(decision.decision, 'QUARANTINE');
  assert.ok(decision.score < decision.floor);
  assert.ok(decision.reasons.includes('BELOW_CONFIDENCE_FLOOR'));
  assert.ok(decision.missing.includes('gradingCompany'));
});

test('a title with no extractable hard attributes cannot establish an identity', () => {
  const decision = assessMatch({ title: 'beautiful vintage cardboard', floor: 0.5 });
  assert.equal(decision.decision, 'QUARANTINE');
  assert.equal(decision.score, 0);
  assert.ok(decision.reasons.includes('NO_HARD_ATTRIBUTES'));
});
