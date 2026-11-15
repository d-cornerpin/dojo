// work_update given the bare 12 hex of a commitment id says it is a promise, as it does for the cmt: form.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { freshDoneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { openCommitment } from '../../work/store.js';
import { resolveTaskId, formatResolveError } from '../schema.js';

const errorFor = (typed: string): string => {
  const r = resolveTaskId(typed, 'agent-1');
  if (r.ok) throw new Error('the id resolved as a task');
  return formatResolveError('task', typed, r);
};

beforeEach(() => { freshDoneDb(); runMigrations(); });

describe('a promise id typed into a task call', () => {
  it('is named a promise in both forms, and an unknown 12 hex is still just not found', () => {
    const id = openCommitment({ agentId: 'agent-1', description: 'email the roof quote', conversationId: null, turnNumber: 3, sourceMessageId: null }) as string;
    const bare = id.slice('cmt:'.length);
    expect(errorFor(id)).toContain('is a promise you made');
    expect(errorFor(bare)).toContain('is a promise you made');
    expect(errorFor('0123456789ab')).toContain('Task not found');
  });
});
