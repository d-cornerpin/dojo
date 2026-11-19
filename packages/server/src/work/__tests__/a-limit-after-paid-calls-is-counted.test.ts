// A provider limit on the turn's first call waits for the reset uncounted; after paid calls the same limit is a counted
// cut that waits for the later of the reset and the backoff, so the paid calls are repeated at most five times.
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

describe('a limit after paid calls is counted', () => {
  it('on the first call it waits for the reset and counts nothing', () => {
    servedBy('m-1', 1);
    turnEnds(1, 'provider_error', { retryAt: T0 + 300_000, paidBeforeLimit: false });
    expect(askOf('m-1')).toEqual({ state: 'open', due: T0 + 300_000 });
    expect(countsOf('m-1')).toEqual({ silence: 0, engine: 0 });
  });

  it('after paid calls it is counted and waits for the later of the reset and the backoff', () => {
    servedBy('m-1', 1);
    turnEnds(1, 'provider_error', { retryAt: T0 + 300_000, paidBeforeLimit: true });
    expect(askOf('m-1')).toEqual({ state: 'open', due: T0 + 300_000 });
    servedBy('m-1', 2);
    turnEnds(2, 'provider_error', { retryAt: T0 + 30_000, paidBeforeLimit: true });
    expect(askOf('m-1')).toEqual({ state: 'open', due: T0 + 120_000 });
    expect(countsOf('m-1')).toEqual({ silence: 0, engine: 2 });
  });
});
