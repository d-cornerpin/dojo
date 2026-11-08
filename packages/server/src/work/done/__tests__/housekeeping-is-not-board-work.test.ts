// A service agent's own housekeeping is nobody's assigned work: it is off the board, and when its worker
// hands it in the engine settles it on its own receipt, with no decision asked of anyone. Work the main
// agent assigns TO a service agent is board work like any other, decided by the main agent.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { listTasks } from '../../../tracker/schema.js';
import { clearPlatformConfigCache } from '../../../config/platform.js';
import { whoDecides } from '../who-decides.js';
import { freshBoard, call, stateOf, eventCount, PM, MAIN, OTHER } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

const opened = (content: string): string => /task_id=([0-9a-f-]{36})/.exec(content)![1];
const rootKind = (id: string): string => (doneDb().prepare('SELECT root_kind FROM work WHERE id = ?').get(id) as { root_kind: string }).root_kind;

describe('housekeeping is not board work', () => {
  it('a service agent\'s own task is off the board and settles on the engine\'s receipt, with no decision', async () => {
    freshBoard();
    doneDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', ?)").run(OTHER);
    clearPlatformConfigCache();
    const r = await call(OTHER, 'work_open', { kind: 'task', title: 'Prune the review ledger', goal: 'The ledger holds only live rows', allow_duplicate: true });
    const id = opened(r.content);
    expect(rootKind(id)).toBe('service');
    expect(listTasks({}).some((t) => t.id === id), 'never on the board').toBe(false);
    const done = await call(OTHER, 'work_update', { action: 'hand_in', task_id: id, outcome: 'finished', proof: [], note: 'pruned' });
    expect(done.isError, done.content).toBe(false);
    expect(stateOf(id)).toBe('done');
    expect(eventCount('handed_in', id) + eventCount('decided', id) + eventCount('validation_escalated', id)).toBe(0);
  });

  it('work the main agent assigns to the PM is board work, decided by the main agent', async () => {
    freshBoard();
    const r = await call(MAIN, 'work_open', { kind: 'task', title: 'Review the release notes', goal: 'The notes are checked', assigned_to: PM, allow_duplicate: true });
    const id = opened(r.content);
    expect(rootKind(id)).toBe('tracker');
    const handed = await call(PM, 'work_update', {
      action: 'hand_in', task_id: id, outcome: 'cant_be_done', note: 'the appendix is missing',
      proof: [{ kind: 'remainder', ref: 'the appendix', reason: 'the appendix was never attached to the notes' }],
    });
    expect(handed.isError, handed.content).toBe(false);
    expect(stateOf(id)).toBe('handed_in');
    expect(whoDecides(id)).toEqual({ kind: 'agent', agentId: MAIN });
  });
});
