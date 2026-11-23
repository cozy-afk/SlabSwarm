// Task 16: deterministic hard-attribute extraction from noisy listing titles.
// No network, no model and no clock: the same title must always produce the
// same normalized attributes, spans and per-attribute confidence.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  extractHardAttributes,
  type HardAttributeName,
} from '../../server/identity/hardAttributes.ts';

const NAMES: HardAttributeName[] = [
  'gradingCompany', 'numericGrade', 'certNumber', 'serialRun', 'cardNumber',
];

test('extracts all five hard attributes from a noisy slab listing title', () => {
  const title = 'Pokemon Charizard Base Set #4 PSA 10 GEM MT cert #12345678 1/1';
  const attrs = extractHardAttributes(title);

  assert.equal(attrs.gradingCompany, 'PSA');
  assert.equal(attrs.numericGrade, '10');
  assert.equal(attrs.certNumber, '12345678');
  assert.equal(attrs.serialRun, '1/1');
  assert.equal(attrs.cardNumber, '4');
  assert.deepEqual(attrs.attributes.map((a) => a.name).sort(), [...NAMES].sort());
  for (const attribute of attrs.attributes) {
    assert.equal(title.slice(attribute.start, attribute.end), attribute.raw);
    assert.ok(attribute.confidence > 0 && attribute.confidence <= 1);
    assert.equal(attribute.source, 'TITLE');
  }
  assert.deepEqual(
    attrs.attributes.map((a) => a.start),
    [...attrs.attributes.map((a) => a.start)].sort((a, b) => a - b),
    'spans are ordered for audit',
  );
});

test('a bare long digit run is a lower-confidence cert candidate, never a card number', () => {
  const labeled = extractHardAttributes('Charizard PSA 10 cert #12345678 #4');
  const bare = extractHardAttributes('Charizard 12345678');

  assert.equal(labeled.certNumber, '12345678');
  assert.equal(bare.certNumber, '12345678');
  assert.equal(bare.cardNumber, null, 'an eight-digit run is not a card number');
  const labeledCert = labeled.attributes.find((a) => a.name === 'certNumber')!;
  const bareCert = bare.attributes.find((a) => a.name === 'certNumber')!;
  assert.ok(labeledCert.confidence > bareCert.confidence);
});

test('grade numbers, prices and dates are not misread as card numbers or certs', () => {
  const attrs = extractHardAttributes('BGS 9.5 Charizard sold $1234.00 on 11/23/2026');

  assert.equal(attrs.gradingCompany, 'BGS');
  assert.equal(attrs.numericGrade, '9.5');
  assert.equal(attrs.cardNumber, null);
  assert.equal(attrs.certNumber, null);
  assert.equal(attrs.serialRun, null);
});

test('serial runs keep their exact run notation and card numbers need an explicit marker', () => {
  const serialized = extractHardAttributes('Charizard #23/99 PSA 9');
  const oneOfOne = extractHardAttributes('Charizard 1/1 BGS 9.5');
  const printedNumber = extractHardAttributes('Charizard Card No. 4 SGC 8');
  const slashOnly = extractHardAttributes('Charizard /99 CGC 10');

  assert.equal(serialized.serialRun, '23/99');
  assert.equal(serialized.numericGrade, '9');
  assert.equal(oneOfOne.serialRun, '1/1');
  assert.equal(printedNumber.cardNumber, '4');
  assert.equal(slashOnly.serialRun, '/99');
  assert.equal(slashOnly.cardNumber, null);
});

test('normalized runs, grade labels and empty titles never invent attribute values', () => {
  const mixed = extractHardAttributes('charizard psa gem mint 10  CERTIFICATE: 00012345  #004');
  assert.equal(mixed.gradingCompany, 'PSA');
  assert.equal(mixed.numericGrade, '10');
  assert.equal(mixed.certNumber, '00012345', 'cert digits are copied verbatim');
  assert.equal(mixed.cardNumber, '004', 'card numbers are copied verbatim');

  for (const title of ['', '   ', 'a completely unstructured title']) {
    const empty = extractHardAttributes(title);
    for (const name of NAMES) assert.equal(empty[name], null, `${name} stays UNKNOWN`);
    assert.deepEqual(empty.attributes, []);
  }

  assert.deepEqual(extractHardAttributes('PSA 10'), extractHardAttributes('PSA 10'));
});
