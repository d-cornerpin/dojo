// The report tool refused this turn and a reply ending the turn: one steer, whatever the reply says.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kit = { db: null as unknown };
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), insertMessageIfAbsent: vi.fn(), insertEngineEventIfAbsent: vi.fn(),
}));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => kit.db }));

import { endTurn, fakeDb, modelSays, steered } from './post-call-kit.js';

const REFUSED = { name: 'dojo_report', isError: true, content: 'Report 067df9fa is cancelled, there is no brief to submit.' };
beforeEach(() => { kit.db = fakeDb; modelSays(null); });

describe('a refused report is corrected whatever the reply says', () => {
  it('a claim and a plain line each get exactly one steer quoting the tool', async () => {
    for (const reply of ['Submitted!', 'Let me know what else you need.']) {
      const out = await endTurn(reply, [REFUSED]);
      expect(out.directive, reply).toBe('continue');
      const fired = out.state.steerQueue.fired.filter((e) => e.floor === 'false-delivery-claim');
      expect(fired, reply).toHaveLength(1);
      expect(fired[0].content).toContain('no brief to submit');
    }
  });

  it('a report call that went through means nothing to correct', async () => {
    const out = await endTurn('Submitted!', [REFUSED, { name: 'dojo_report', content: 'Report submitted.' }]);
    expect(steered(out)).not.toContain('false-delivery-claim');
  });
});
