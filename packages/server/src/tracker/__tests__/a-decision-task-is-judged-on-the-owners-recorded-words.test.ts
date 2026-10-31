// The t153 shape: a task whose deliverable is a decision (no file, no effectful call). The owner settled
// it in a LATER message; the turn that served it closed the task with the decision in its notes. The PM's
// validation request must carry the owner's recorded words (the engine's newer-instruction link), so the
// close is judged on that record, not on the agent's prose. With no such record and nothing touched, the
// request tells the PM to refuse.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-decision-task', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: vi.fn(async () => undefined) }), stopAgent: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';
import { writeTaskLog } from '../task-log.js';
import { unvalidatedCompleteText } from '../validation-request.js';

const db = (): Database.Database => mockDb.current!;
const TASK = 'task-decision-base';
const parts = (): import('../validation-request.js').ValidationRequestParts => ({
  title: 'Plan the base', agentName: 'Helper', goal: 'the base type is chosen', result: 'The owner chose a timber frame on slabs.',
  priority: 'normal', revertCount: 0, headExtras: '', evidenceBlock: '    (no evidence array)',
});
function ownerMessage(id: string, content: string): void {
  db().prepare(`INSERT INTO messages (id, agent_id, role, content, lane, conversation_id, created_at) VALUES (?, 'helper', 'user', ?, 'owner', 'conv-1', ?)`)
    .run(id, content, Date.now());
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  db().prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES ('helper', 'Helper', 'idle', 'm-a', 'apprentice')`).run();
  seedTrackerTask(db(), { id: TASK, agentId: 'helper', status: 'in_progress', title: 'Plan the base', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
});

describe('a decision-type close is judged on the owner\'s recorded words', () => {
  it('carries the owner\'s later message word for word, and says that record settles a decision task', () => {
    ownerMessage('msg-base-1', 'the base will be a timber frame on paving slabs rather than a concrete pad.');
    writeTaskLog({ taskId: TASK, fromEntity: 'engine', entryKind: 'newer_instruction', reason: 'msg-base-1' });
    const text = unvalidatedCompleteText(TASK, parts());
    expect(text).toContain('timber frame on paving slabs rather than a concrete pad');
    expect(text).toContain('msg-base-1'.slice(0, 8));
    expect(text).toContain('A task whose job is a decision');
  });

  it('with no owner words on record and nothing touched, the request says so and tells the PM to refuse', () => {
    const text = unvalidatedCompleteText(TASK, parts());
    expect(text).toContain('Owner words recorded on this task: none');
    expect(text).toContain('With no such record and nothing touched, reject it');
  });
});
