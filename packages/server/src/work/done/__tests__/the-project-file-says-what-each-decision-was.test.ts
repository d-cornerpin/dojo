// The project file reads each decision on its tasks as what it was: an approval, a send-back, a cancel, or the
// owner's own close, never a cancel or a close shown as a send-back.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { doneDb } from './helpers/done-db.js';
import { freshBoard, MAIN, TASK } from './helpers/decision-world.js';
import { appendWorkEvent } from '../../store.js';
import { workFile } from '../../project-file.js';

beforeEach(() => {
  freshBoard();
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
     VALUES ('proj-1', 'project', ?, 'owner', 'tracker', 'proj-1', 'open', 'task', 1, 0, 'Quarterly report', ?, ?)`,
  ).run(MAIN, at, at);
  doneDb().prepare("UPDATE work SET parent_id = 'proj-1' WHERE id = ?").run(TASK);
});

describe('the project file says what each decision was', () => {
  it('a cancel and the owner\'s close read as themselves', () => {
    appendWorkEvent(TASK, 'decided', 'owner', { verdict: 'cancel', reason: 'The owner no longer needs it' });
    appendWorkEvent(TASK, 'decided', 'owner', { verdict: 'owner_done', reason: 'The owner finished it himself' });
    const file = workFile(TASK, 4000);
    expect(file).toContain('"Write the report" cancelled: The owner no longer needs it');
    expect(file).toContain('"Write the report" closed by the owner: The owner finished it himself');
    expect(file).not.toContain('sent back');
  });

  it('an approval and a send-back read as before', () => {
    appendWorkEvent(TASK, 'decided', 'pm', { verdict: 'send_back', reason: 'The totals page is missing' });
    appendWorkEvent(TASK, 'decided', 'pm', { verdict: 'approve', reason: 'The report meets the goal' });
    const file = workFile(TASK, 4000);
    expect(file).toContain('"Write the report" sent back: The totals page is missing');
    expect(file).toContain('"Write the report" approved: The report meets the goal');
  });
});
