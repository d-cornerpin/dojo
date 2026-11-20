// A request whose turn the engine keeps cutting (a stalled stream) waits 1, 2, 4, 8, 16 minutes between tries, is not
// waiting while its due is ahead, and stands down at the sixth hand-back.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { getWaitingHumanConversations } from '../../agent/v2/counterparty.js';
import { freshReplyDb, AGENT, T0 } from '../../agent/v2/__tests__/helpers/reply-sender.js';
import { samAsks, servedBy, turnEnds, askOf, countsOf } from './helpers/a-request-handed-back.js';

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  samAsks('m-1');
});

describe('a stalled provider backs off instead of re-serving', () => {
  it('each cut waits twice as long as the one before, and the sixth stands the request down', () => {
    const waits: number[] = [];
    for (let turn = 1; turn <= 5; turn++) {
      servedBy('m-1', turn);
      turnEnds(turn, 'stream_idle');
      expect(askOf('m-1').state).toBe('open');
      waits.push((askOf('m-1').due! - Date.now()) / 60_000);
    }
    expect(waits).toEqual([1, 2, 4, 8, 16]);
    servedBy('m-1', 6);
    turnEnds(6, 'stream_idle');
    expect(askOf('m-1').state).toBe('blocked');
    expect(countsOf('m-1')).toEqual({ silence: 0, engine: 5 });
  });

  it('a request whose due is ahead is not waiting; it is once the due passes', () => {
    servedBy('m-1', 1);
    turnEnds(1, 'stream_idle');
    expect(getWaitingHumanConversations(AGENT)).toEqual([]);
    vi.setSystemTime(T0 + 60_000);
    expect(getWaitingHumanConversations(AGENT).map((c) => c.workId)).toEqual(['ask:m-1']);
  });
});
