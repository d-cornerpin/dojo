// Every memory write this turn refused and a reply ending the turn: one steer, whatever the reply says.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const kit = { db: null as unknown };
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()), insertMessageIfAbsent: vi.fn(), insertEngineEventIfAbsent: vi.fn(),
}));
vi.mock('../../../../../services/presence.js', () => ({ getPresence: () => 'away' }));
vi.mock('../../../../../db/connection.js', () => ({ getDb: () => kit.db }));

import { endTurn, fakeDb, modelSays, steered } from './post-call-kit.js';

const REFUSED = { name: 'vault_remember', isError: true, content: 'REJECTED' };
beforeEach(() => { kit.db = fakeDb; modelSays(null); });

describe('a refused save is corrected whatever the reply says', () => {
  it('a reply that never mentions saving still gets exactly one steer', async () => {
    for (const reply of ['Saved that for you.', 'Here is the weather for tomorrow.']) {
      const out = await endTurn(reply, [REFUSED]);
      expect(out.directive, reply).toBe('continue');
      expect(steered(out).filter((f) => f === 'failed-save-claim'), reply).toHaveLength(1);
    }
  });

  it('one write that went through means nothing to correct', async () => {
    const out = await endTurn('Saved that for you.', [REFUSED, { name: 'vault_remember', content: 'stored' }]);
    expect(steered(out)).not.toContain('failed-save-claim');
  });
});
