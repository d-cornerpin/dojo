// R as lived (the shop run, then stand-up run 2): a delivered run is decided by the engine, never the manager; a
// stand-up run handed in in its own turn while a review opens is not offered, and the engine decides it when its turn
// ends. If the Dojo dies with the run waiting, the first sweep after the boot takes it up and the engine decides it.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: async () => {} }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage: async () => 'ran' }) }));
const box = await import('./helpers/reminders-box.js');
const { at, db, turn, line, reminder, openRun, handIn, checkScheduledTasks, closeRunsThatDelivered, decidedBy } = box;
const { runPMReview } = await import('../../tracker/pm-agent.js');

beforeAll(() => {
  box.openBox();
  db().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db().prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('pm', 'Manager', 'm', 'idle', '{}', 'sensei')").run();
});
afterAll(() => box.closeBox());

const reviewsOffered = (): string => (db().prepare("SELECT GROUP_CONCAT(content, '\n') AS c FROM messages WHERE agent_id = 'pm' AND origin_intent = 'pm_review'")
  .get() as { c: string | null }).c ?? '';
const handedInOwnTurn = (task: string, text: string, ended = true) =>
  turn({ kind: 'occurrence', id: openRun(task) }, async () => { expect((await handIn(task, line(text, 'imessage'))).isError).toBe(false); }, ended);

describe('a run waiting for its turn is not reviewed by the manager', () => {
  it('the review that opens during the stand-up run turn leaves it out; the engine decides it at the turn end', async () => {
    at('2026-03-02T22:40:00Z');
    const shop = await reminder('Call the shop', '2026-03-02T22:50:00Z');
    const standUp = await reminder('Stand-up note', '2026-03-02T22:50:00Z', 10, 3);
    at('2026-03-02T22:50:25Z'); await checkScheduledTasks();
    await handedInOwnTurn(shop, 'Time to call the shop.');
    await closeRunsThatDelivered();
    expect(decidedBy(shop), 'delivered on its own turn: the engine decides it').toBe('engine');
    at('2026-03-02T22:50:57Z');
    await turn({ kind: 'occurrence', id: openRun(standUp) }, async () => {
      await handIn(standUp, line('Stand-up: all three tasks are on track.', 'imessage'));
      await runPMReview();
    });
    expect(reviewsOffered()).not.toContain(`[${shop}]`);
    expect(reviewsOffered()).not.toContain(`[${standUp}]`);
    await closeRunsThatDelivered();
    expect(decidedBy(standUp)).toBe('engine');
  });

  it('the Dojo dies while the run waits for its turn: after the boot the sweep takes it up and the engine decides it', async () => {
    at('2026-03-03T22:40:00Z');
    const standUp = await reminder('Morning stand-up', '2026-03-03T22:50:00Z', 10, 3);
    at('2026-03-03T22:50:25Z'); await checkScheduledTasks();
    await handedInOwnTurn(standUp, 'Stand-up: nothing new today.', false);
    at('2026-03-03T23:40:00Z');
    await closeRunsThatDelivered();     // the reaper's sweep, its first tick after the boot
    await runPMReview();
    expect(decidedBy(standUp)).toBe('engine');
    expect(reviewsOffered()).not.toContain(`[${standUp}]`);
  });
});
