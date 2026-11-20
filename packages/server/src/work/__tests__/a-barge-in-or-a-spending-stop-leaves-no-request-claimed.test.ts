// A barge-in (preempt) or a spending stop (budget) is nobody's failure: the request is open again at once, with no due
// and nothing counted, and never left claimed by the ended turn.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import { freshReplyDb, T0 } from '../../agent/v2/__tests__/helpers/reply-sender.js';
import { samAsks, servedBy, turnEnds, askOf, countsOf } from './helpers/a-request-handed-back.js';

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  samAsks('m-1');
});

describe('a barge-in or a spending stop leaves no request claimed', () => {
  it.each(['preempt', 'budget'])('%s re-opens the request at once and counts nothing', (exit) => {
    servedBy('m-1', 1);
    turnEnds(1, exit);
    expect(askOf('m-1')).toEqual({ state: 'open', due: null });
    expect(countsOf('m-1')).toEqual({ silence: 0, engine: 0 });
  });
});
