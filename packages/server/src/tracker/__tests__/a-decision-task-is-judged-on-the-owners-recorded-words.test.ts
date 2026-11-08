// A task whose deliverable is a decision (no file, no effectful call). The owner settled it in a LATER
// message; the turn that served it handed the task in with the decision in its note. The PM's review
// must carry the owner's recorded words (the engine's newer-instruction link), so the close is
// judged on that record, not on the agent's prose. With no such record and no proof, the engine refuses
// the uphold at the PM's door; the request does not carry that rule as prompt text.
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
import { runPMReview } from '../pm-agent.js';
import { getPMAgentId, clearPlatformConfigCache } from '../../config/platform.js';

const db = (): Database.Database => mockDb.current!;
const TASK = 'task-decision-base';
/** The task handed in with its note, and the PM's review of it: the report it was given. */
async function reviewText(): Promise<string> {
  db().prepare("UPDATE work SET state = 'handed_in' WHERE id = ?").run(TASK);
  db().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES (?, 'handed_in', 'helper', json_object('outcome', 'finished', 'items', json('[]'), 'note', 'The owner chose a timber frame on slabs.', 'filedBy', 'helper'), ?)").run(TASK, Date.now());
  await runPMReview();
  return (db().prepare("SELECT content FROM messages WHERE origin_intent = 'pm_review' ORDER BY seq DESC LIMIT 1").get() as { content: string }).content;
}
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
  clearPlatformConfigCache();
  db().prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES (?, 'PM', 'idle', 'm-a', 'sensei')`).run(getPMAgentId());
  seedTrackerTask(db(), { id: TASK, agentId: 'helper', status: 'in_progress', title: 'Plan the base', opened_at: Date.now(), updated_at: Date.now(), priority: 'normal' } as never);
});

describe('a decision-type close is judged on the owner\'s recorded words', () => {
  it('carries the owner\'s later message word for word, and says that record settles a decision task', async () => {
    ownerMessage('msg-base-1', 'the base will be a timber frame on paving slabs rather than a concrete pad.');
    writeTaskLog({ taskId: TASK, fromEntity: 'engine', entryKind: 'newer_instruction', reason: 'msg-base-1' });
    const text = await reviewText();
    expect(text).toContain('timber frame on paving slabs rather than a concrete pad');
    expect(text).toContain('msg-base-1'.slice(0, 8));
    expect(text).toContain('a task whose job is a decision is met by the owner\'s recorded words');
  });

  it('with no owner words on record, the request says so (the refusal itself is the engine\'s, at the PM\'s door)', async () => {
    const text = await reviewText();
    expect(text).toContain('Owner words recorded on this task: none');
    expect(text).not.toContain('With no such record and nothing touched, reject it');
  });
});
