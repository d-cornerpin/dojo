// work_update given the id of a promise says it is a promise, only for the agent's own open one.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { openCommitment } from '../../work/store.js';
import { resolveTaskId, formatResolveError } from '../schema.js';

const errorFor = (typed: string, agent = 'agent-1'): string => {
  const r = resolveTaskId(typed, agent);
  if (r.ok) throw new Error('the id resolved as a task');
  return formatResolveError('task', typed, r);
};
const open = (agentId: string): string =>
  openCommitment({ agentId, description: `email the roof quote ${agentId}`, conversationId: null, turnNumber: 3, sourceMessageId: null }) as string;

beforeEach(() => { freshDoneDb(); runMigrations(); });

describe('a promise id typed into a task call', () => {
  it("names the agent's own open promise, with or without the cmt: prefix", () => {
    const id = open('agent-1');
    expect(errorFor(id)).toContain('is a promise you made');
    expect(errorFor(id.slice('cmt:'.length))).toContain('is a promise you made');
  });

  it("says plain not found for another agent's promise, a closed one, and an unknown id", () => {
    const other = open('agent-2');
    const closed = open('agent-1');
    doneDb().prepare("UPDATE work SET state = 'abandoned', closed_at = 1700000000000 WHERE id = ?").run(closed);
    for (const typed of [other, other.slice(4), closed, closed.slice(4), '0123456789ab']) {
      expect(errorFor(typed)).toContain('Task not found');
    }
  });
});
