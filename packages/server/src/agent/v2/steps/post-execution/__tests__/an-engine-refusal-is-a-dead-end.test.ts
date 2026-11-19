import { describe, it, expect, vi } from 'vitest';
import { advance, initState, type AgentTurnState, type ToolResultRecord } from '../../../state.js';
import { steerFired } from '../../../steer-queue.js';
import { runPostExecution, POST_EXECUTION_PHASE, type PostExecutionContext } from '../index.js';

vi.mock('../../../../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/message-store.js')>()),
  insertMessageIfAbsent: () => null,
}));

const stateInStep = (overrides: Partial<AgentTurnState> = {}): AgentTurnState => advance(initState({
  agentId: 'helper', contextWindow: 200000, isAutoRouted: false, configuredModelId: 'deepseek-v4-flash', turnNumber: 3,
  triggeredByIMessage: false, triggeredByA2AReplyIntent: null, lastUserMessageContent: 'hello', lastUserMessageId: 'msg-1',
  inboundChannel: 'dashboard', inboundContext: null,
}), { phase: POST_EXECUTION_PHASE, loopCount: 1, ...overrides });

const refused = (content: string): ToolResultRecord[] => [{ toolCallId: 'tc-1', name: 'file_write', content, isError: true }];
const ctx = (turnToolResults: ToolResultRecord[]): PostExecutionContext =>
  ({ agentId: 'helper', turnNumber: 3, turnToolResults, broadcast: () => {} });

const POLICY = '[BLOCKED by engine] file_write is not available to this agent (denied by policy). The request was not performed.';
const GATE = "[BLOCKED by engine: destructive-action gate] This command requires the primary agent's approval, and the approval request could not be filed.";

describe('an engine refusal is a dead end', () => {
  it('a pass whose every call the engine refused counts', () => {
    const out = runPostExecution(stateInStep(), ctx(refused(POLICY)));
    expect(out.state.deadEndPasses).toBe(1);
    expect(out.directive).toBe('proceed');
  });

  it('a second such pass steers the agent', () => {
    const out = runPostExecution(stateInStep({ deadEndPasses: 1 }), ctx(refused(POLICY)));
    expect(out.directive).toBe('continue');
    expect(steerFired(out.state.steerQueue, 'dead-end')).toBe(true);
  });

  it("the destructive gate's refusal counts too", () => {
    const out = runPostExecution(stateInStep(), ctx(refused(GATE)));
    expect(out.state.deadEndPasses).toBe(1);
  });
});
