// The promise floor fires on the decision model's verdict and stands down on a receipt; with no
// decision model on the box it never fires.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kit = { db: null as unknown };
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), insertMessageIfAbsent: vi.fn(), insertEngineEventIfAbsent: vi.fn(),
}));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => kit.db }));

import { endTurn, fakeDb, modelSays, steered } from './post-call-kit.js';
import { judgment } from '../../../../decision-ask.js';
import { installJudgment } from '../../../../decision-hooks.js';

const PROMISE = 'On it. Let me pull up all your calendars.';
beforeEach(() => { kit.db = fakeDb; });

describe('the promise floor reads the decision model', () => {
  it('a yes with no receipt this turn gets exactly one steer', async () => {
    modelSays({ only_promises_to_start: true });
    const out = await endTurn(PROMISE);
    expect(out.directive).toBe('continue');
    expect(steered(out).filter((f) => f === 'promise-floor')).toHaveLength(1);
  });

  it('a yes with a receipt this turn gets none', async () => {
    modelSays({ only_promises_to_start: true });
    const out = await endTurn(PROMISE, [{ name: 'send_email', arguments: { to: 'a@example.com' } }]);
    expect(steered(out)).not.toContain('promise-floor');
  });

  it('a standing promise and a board claim are steered on their own verdicts', async () => {
    modelSays({ standing_promise: true });
    expect(steered(await endTurn('From now on I will text you when it fires.'))).toContain('promise-floor');
    modelSays({ asserts_board_state: true });
    expect(steered(await endTurn('Still on deck: the parking pass renewal.'))).toContain('promise-floor');
  });

  it('with no decision model on the box it never fires', async () => {
    installJudgment(judgment);
    const out = await endTurn(PROMISE);
    expect(steered(out)).not.toContain('promise-floor');
  });
});
