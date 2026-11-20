// A routed agent whose models are all rate-limited does not ask its person to write again: the turn waits for the
// earliest reset among them, and the request is served then, uncounted.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../router/selector.js', () => ({
  routedSkipReasons: () => [{ modelId: 'm-late', skip: 'rate_limit' }, { modelId: 'm-soon', skip: 'rate_limit' }],
}));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1_000 }));

import { runMigrations } from '../../db/migrations.js';
import { updateRateLimits, clearRateLimits } from '../../router/rate-limits.js';
import { tellOwnerNoPickHolds } from '../../agent/v2/steps/call-llm/no-pick-holds.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { freshReplyDb, AGENT, T0 } from '../../agent/v2/__tests__/helpers/reply-sender.js';
import { samAsks, servedBy, turnEnds, askOf, countsOf } from './helpers/a-request-handed-back.js';

const limitedUntil = (modelId: string, at: number): void =>
  updateRateLimits(modelId, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': new Date(at).toISOString() });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  clearRateLimits();
  samAsks('m-1');
  servedBy('m-1', 1);
});

describe('a routed agent whose models are all limited answers when one clears', () => {
  it('the turn waits for the earliest reset, and the request is due then, uncounted', async () => {
    limitedUntil('m-late', T0 + 20 * 60_000);
    limitedUntil('m-soon', T0 + 7 * 60_000);
    const bag = openTurnContext(AGENT);
    await tellOwnerNoPickHolds({ agentId: AGENT, turnNumber: 1, tier: 'standard', excluded: [], turnContext: {} as never, revertTrigger: () => {} });
    expect(bag.retryAt).toBe(T0 + 7 * 60_000);
    turnEnds(1, 'provider_error', { retryAt: bag.retryAt });
    endTurnContext(AGENT);
    expect(askOf('m-1')).toEqual({ state: 'open', due: T0 + 7 * 60_000 });
    expect(countsOf('m-1')).toEqual({ silence: 0, engine: 0 });
  });
});
