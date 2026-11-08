// Handed-in work is never driven again by a prompt queued for it: the hand-in retires every unserved
// engine event carrying the task's id, and an older notice that names the task only in its text. Another
// task's notice, a served row and ordinary chat are untouched; and the serve boundary reads handed-in
// work as spent, so a prompt that slipped past is not served either.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { insertEngineEvent } from '../../../memory/message-store.js';
import { spentTask } from '../../../agent/v2/work-lineage.js';
import { freshBoard, handedIn, WORKER, OTHER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const notice = (id: string, agentId: string, taskId: string | null, about = TASK): void => {
  insertEngineEvent({
    id, agentId, content: `[SOURCE: TRACKER TASK ASSIGNMENT] Begin working on this task. ID: ${about}`,
    sourceAgentId: null, originIntent: 'tracker', work: taskId ? { taskId } : null,
  } as never);
};
const swept = (id: string): boolean =>
  (doneDb().prepare('SELECT swept_at FROM messages WHERE id = ?').get(id) as { swept_at: number | null }).swept_at !== null;

describe('a hand-in retires the prompts queued for its work', () => {
  it('keyed and older text-only notices for the task retire; nothing else does', async () => {
    freshBoard();
    notice('m-keyed', WORKER, TASK);
    notice('m-legacy', WORKER, null);
    notice('m-other-task', WORKER, 'task-other', 'task-other');
    notice('m-other-agent', OTHER, null);
    notice('m-served', WORKER, TASK);
    doneDb().prepare('UPDATE messages SET served_by_turn = 7 WHERE id = ?').run('m-served');
    await handedIn();
    expect(swept('m-keyed')).toBe(true);
    expect(swept('m-legacy')).toBe(true);
    expect(swept('m-other-task')).toBe(false);
    expect(swept('m-other-agent')).toBe(false);
    expect(swept('m-served')).toBe(false);
  });

  it('the serve boundary reads a handed-in task as spent', async () => {
    freshBoard();
    expect(spentTask(TASK)).toBeNull();
    await handedIn();
    expect(spentTask(TASK)).toEqual({ reason: 'task_handed_in', state: 'task handed in' });
  });
});
