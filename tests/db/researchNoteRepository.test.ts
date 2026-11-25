import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createResearchNoteRepository } from '../../server/db/repositories/researchNote.ts';
import { createMemoryStore } from '../../server/db/store.ts';

test('upsert preserves createdAt for an existing research note', async () => {
  const repo = createResearchNoteRepository(createMemoryStore());
  const first = await repo.upsert({
    id: 'research-note-test',
    question: 'original question',
    evidenceIds: ['ev-1'],
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const second = await repo.upsert({
    id: 'research-note-test',
    question: 'updated question',
    evidenceIds: ['ev-2'],
  });

  assert.equal(first.createdAt, '2026-01-01T00:00:00.000Z');
  assert.equal(second.createdAt, first.createdAt, 'createdAt must not change on idempotent rerun');
  assert.equal(second.question, 'updated question');
  assert.deepEqual(second.evidenceIds, ['ev-2']);
});
