// When the router finds every model it could use rate-limited, the model selection ends the turn as a provider error
// with the earliest reset on the turn, so finalize makes the request wait for it instead of counting a silence.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../db/connection.js', async () => (await import('../../agent/v2/__tests__/helpers/reply-sender.js')).connectionMock());
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../../router/decide.js', () => ({
  decideTier: async () => ({ tier: 'standard', method: 'rules', confidence: 1, scores: [], rawScore: 0, latencyMs: 0, headVersion: null, queryPreview: '' }),
}));
vi.mock('../../router/routing-view.js', () => ({ routingView: () => [] }));
vi.mock('../../router/selector.js', () => ({
  selectModel: () => null, logRouterDecision: () => {},
  routedSkipReasons: () => [{ modelId: 'm-late', skip: 'rate_limit' }, { modelId: 'm-soon', skip: 'rate_limit' }],
}));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1_000 }));

import { runMigrations } from '../../db/migrations.js';
import { updateRateLimits, clearRateLimits } from '../../router/rate-limits.js';
import { selectModel } from '../../agent/v2/steps/call-llm/model-selection.js';
import { initState } from '../../agent/v2/state.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { freshReplyDb, AGENT, T0 } from '../../agent/v2/__tests__/helpers/reply-sender.js';

const limitedUntil = (modelId: string, at: number): void =>
  updateRateLimits(modelId, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': new Date(at).toISOString() });

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  freshReplyDb(runMigrations);
  clearRateLimits();
});

describe('a routed pick that finds every model limited ends the turn as a provider wait', () => {
  it('the turn ends as provider_error with the earliest reset on it', async () => {
    limitedUntil('m-late', T0 + 20 * 60_000);
    limitedUntil('m-soon', T0 + 7 * 60_000);
    const bag = openTurnContext(AGENT);
    try {
      const state = initState({ agentId: AGENT, turnNumber: 1, contextWindow: 128_000, isAutoRouted: true, configuredModelId: 'auto' } as Parameters<typeof initState>[0]);
      const out = await selectModel(state, {
        agentId: AGENT, isAutoRouted: true, configuredModelId: 'auto', lastUserMessageContent: 'hello', conversationId: null,
        turnNumber: 1, turnContext: {} as never, revertTriggerStampOnAbort: () => {},
      });
      expect(out.said).toContain('rate-limited');
      expect(out.state.engineCutExit).toBe('provider_error');
      expect(bag.retryAt).toBe(T0 + 7 * 60_000);
    } finally { endTurnContext(AGENT); }
  });
});
