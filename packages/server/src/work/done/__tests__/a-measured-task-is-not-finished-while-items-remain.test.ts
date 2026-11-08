// A measured task is not finished while its measure lists items (the owner's rule for measured work).
// The one door asks it: a "finished" hand-in with items left is refused naming the count; the items
// that cannot or should not be done are a remainder, handed in as can't be done with a reason.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { handIn } from '../hand-in.js';
import { freshBoard, deliveredToOwner, stateOf, WORKER, TASK } from './helpers/decision-world.js';
import { doneDb } from './helpers/done-db.js';

function measured(left: number, initial = 12): string {
  doneDb().prepare("UPDATE work SET measure_json = ?, measure_initial = ?, measure_remaining = ?, measure_at = ? WHERE id = ?")
    .run(JSON.stringify({ tool: 'gmail_search', args: { query: 'label:Inbox' }, unit: 'messages' }), initial, left, Date.now(), TASK);
  return String(doneDb().prepare("INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, 'measured', '{}', 'engine', ?)").run(TASK, Date.now()).lastInsertRowid);
}
const by = { kind: 'worker' as const, agentId: WORKER };

describe('a measured task is not finished while items remain', () => {
  it('a finished hand-in with items left is refused with the count, and nothing moves', () => {
    freshBoard();
    measured(3);
    const r = handIn({ workId: TASK, by, outcome: 'finished', items: [{ kind: 'delivery', ref: deliveredToOwner() }], note: 'Sorted the inbox' });
    expect(r.kind).toBe('refused');
    expect(r.text).toMatch(/still lists 3 items/);
    expect(stateOf()).toBe('claimed');
  });

  it('the items left, named with a reason, are handed in as can\'t be done', () => {
    freshBoard();
    measured(3);
    const r = handIn({ workId: TASK, by, outcome: 'cant_be_done', items: [{ kind: 'remainder', ref: '3 messages', facts: { reason: 'three are legal holds the owner keeps in the inbox' } }], note: 'Three left on purpose' });
    expect(r.kind).toBe('handed_in');
  });

  it('a measure that came down to 0 is proof of a finished hand-in', () => {
    freshBoard();
    const ref = measured(0);
    const r = handIn({ workId: TASK, by, outcome: 'finished', items: [{ kind: 'measure', ref }], note: 'Inbox at zero' });
    expect(r.kind).toBe('handed_in');
    expect(stateOf()).toBe('handed_in');
  });
});
