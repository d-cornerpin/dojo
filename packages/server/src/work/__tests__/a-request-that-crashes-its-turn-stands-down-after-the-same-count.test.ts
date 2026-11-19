// A request whose turn dies with its process is handed back at boot as a crash: served again at once the first time,
// then after 1, 2, 4, 8 minutes, and at the sixth death it stands down like any other engine failure.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { reconcileOrphanedClaims } from '../orphaned-claims.js';
import { freshReplyDb, testDb, AGENT, T0 } from '../../agent/v2/__tests__/helpers/reply-sender.js';
import { samAsks, servedBy, askOf, countsOf } from './helpers/a-request-handed-back.js';

/** The turn serving it started and never ended: the process died under it. */
function diesIn(turn: number): void {
  servedBy('m-1', turn);
  testDb().prepare(`INSERT INTO turns (agent_id, turn_number, started_at, answered) VALUES (?, ?, datetime('now'), 0)`).run(AGENT, turn);
  reconcileOrphanedClaims();
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  samAsks('m-1');
});

describe('a request that crashes its turn stands down after the same count', () => {
  it('served again at once, then backed off, and held owed at the sixth death', () => {
    const waits: number[] = [];
    for (let turn = 1; turn <= 5; turn++) {
      diesIn(turn);
      expect(askOf('m-1').state, `death ${turn}`).toBe('open');
      waits.push((askOf('m-1').due! - Date.now()) / 60_000);
    }
    expect(waits).toEqual([0, 1, 2, 4, 8]);
    diesIn(6);
    expect(askOf('m-1').state).toBe('blocked');
    expect(countsOf('m-1')).toEqual({ silence: 0, engine: 5 });
  });
});
