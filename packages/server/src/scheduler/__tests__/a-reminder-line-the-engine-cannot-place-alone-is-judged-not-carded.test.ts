// A reminder run the engine closes on its own, with no hand-in by the agent. Its only line was sent in a turn that
// served two reminders (ambiguous): it is delivered, handed in finished and judged by the free check; no card, no
// "can't be done". Its only line was sent in a turn that served nothing on record: no tie, so the run is undelivered.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
const box = await import('./helpers/reminders-box.js');
const { at, db, turn, line, reminder, openRun, runState, handIn, ghosts, checkScheduledTasks, closeRunsThatDelivered, freeCheckSays, decidedBy } = box;
const { cleanupStaleRuns } = await import('../runner.js');
const realNow = Date.now();

beforeAll(() => box.openBox());
afterAll(() => box.closeBox());

const tick = async (iso: string): Promise<void> => { at(iso); await checkScheduledTasks(); };
const lastHandIn = (task: string): string | null => (db().prepare(
  "SELECT json_extract(payload, '$.outcome') AS o FROM work_events WHERE work_id = ? AND kind = 'handed_in' ORDER BY id DESC LIMIT 1",
).get(task) as { o: string } | undefined)?.o ?? null;

describe('a reminder line the engine cannot place alone', () => {
  it('its only line served two reminders: delivered, handed in finished, judged by the free check, no card', async () => {
    freeCheckSays(true);
    const day = '2026-04-01';
    at(`${day}T07:30:00Z`);
    const cat = await reminder('Cat feeding', `${day}T07:44:00Z`);
    const stretch = await reminder('Stretch reminder', `${day}T07:44:00Z`);
    await tick(`${day}T07:44:25Z`);
    let both = '';
    await turn({ kind: 'occurrence', id: openRun(cat) }, async () => {
      both = line('Time to feed the cat, then stand up and stretch.', 'imessage');
      expect((await handIn(stretch, both)).isError).toBe(false);
    });
    await closeRunsThatDelivered();
    await new Promise((r) => setTimeout(r, 50));
    expect(runState(cat)).toEqual({ state: 'done', result_delivery_id: both });
    expect(lastHandIn(cat), "the engine's hand-in of the cat run").toBe('finished');
    expect(decidedBy(cat), 'the free check read the line as the reminder').toBe('engine');
    expect(ghosts()).toBe(0);
    freeCheckSays(null);
  });

  it('its only line was sent in a turn that served nothing on record: undelivered, one card, never a finished hand-in on it', async () => {
    const T0 = Math.floor(realNow / 60_000) * 60_000;   // the stale sweep reads rows SQLite stamps on its own clock
    const min = (m: number): string => new Date(T0 + m * 60_000).toISOString();
    at(min(0));
    const shop = await reminder('Shop call', min(5));
    await tick(min(5.5));
    const before = ghosts();
    await turn(null, () => { line('Time to call the shop.', 'dashboard'); });
    await closeRunsThatDelivered();
    expect(runState(shop).state, 'no turn tied the line to the run').toBe('open');
    at(min(40));
    cleanupStaleRuns();
    await vi.waitFor(() => expect(ghosts()).toBe(before + 1));
    expect(runState(shop).result_delivery_id).toBeNull();
    expect(lastHandIn(shop)).not.toBe('finished');
  });
});
