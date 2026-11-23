// R as lived: the owner texts a reminder and his agent answers it; then a task is made on the dashboard, once after
// that turn ended and once while a turn about another texted request runs. Neither task is tied to a text, so its
// origin reads the dashboard. The agent's own task opened after its turn ended takes no request from that ended turn.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, db, call, turn, reminder, ownerTexts } = box;
const { trackerRouter } = await import('../../gateway/routes/tracker.js');

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const sourceOf = (task: string): string | null =>
  (db().prepare('SELECT source_message_id AS s FROM work WHERE id = ?').get(task) as { s: string | null }).s;
async function boardTask(title: string): Promise<string> {
  const res = await trackerRouter.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
  expect(res.status).toBe(201);
  return ((await res.json()) as { data: { id: string } }).data.id;
}

describe('a task made on the dashboard belongs to no message', () => {
  it('made after the texted reminder was answered: no texted origin, and its card says so', async () => {
    at('2026-03-02T22:33:30Z');
    await reminder('Call the shop', '2026-03-02T22:50:00Z');
    const status = await boardTask('Every 10 minutes, write a one-line status note for me');
    expect(sourceOf(status)).toBeNull();
    const card = await call('work_update', { action: 'get', task_id: status });
    expect(card.content).not.toContain('Call the shop');
  });

  it('made while a turn about another texted request runs: no texted origin', async () => {
    const inbox = ownerTexts('Sort my inbox until it is empty');
    let outbox = '';
    await turn({ kind: 'ask', id: inbox }, async () => { outbox = await boardTask('Outbox step two'); });
    expect(sourceOf(outbox)).toBeNull();
  });

  it("the agent's own task opened after its turn ended is tied to no request of that turn", async () => {
    const made = await call('work_open', { kind: 'task', title: 'Tidy the notes', goal: 'tidy them', allow_duplicate: true });
    expect(sourceOf(/task_id=([\w-]+)/.exec(made.content)![1]!)).toBeNull();
  });
});
