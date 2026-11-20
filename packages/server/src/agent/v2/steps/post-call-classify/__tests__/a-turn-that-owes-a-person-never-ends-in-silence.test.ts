// ════════════════════════════════════════════════════════════════════════════════════════
// t125 — A TURN THAT OWES A PERSON NEVER ENDS IN SILENCE. THE SCREENSHOT IS THE SPEC.
//
// ── THE FIELD EVIDENCE ───────────────────────────────────────────────────────────────────
// The owner's PM agent, twice in one conversation: he asked a question, the model returned
// `history_search` tool calls and NO text block, the searches ran, the next iteration came
// back empty — and the turn ended. Nothing on his screen. His follow-ups ("That didn't
// answer my question", "Hello?") were then charged against the model's own anti-repetition
// ladder, because the exit recorded `no_reply_intended` — a claim about the MODEL'S INTENT
// for a turn the model was never asked a second time.
//
// ── THE DEFECT, AND WHY IT WAS PER-TRANSPORT ─────────────────────────────────────────────
// `empty-response.ts` computed the right predicate — `owesAPerson` — and then consulted it
// ONLY inside a branch gated on `contract.answersInReasoning`. That field is true for
// DeepSeek and false for everything else (`agent/model-contract.ts`:
// `ANSWERS_IN_REASONING_MODELS = /deepseek/i`; `BASE_CONTRACT.answersInReasoning: false`).
// So the engine's only door out of silence was DeepSeek-only BY CONSTRUCTION, and on the
// owner's Claude-backed PM it was unreachable.
//
// That is why this file is a PER-TRANSPORT CENSUS and not one test. A fix verified on one
// seam would reproduce the original defect's own shape — a behaviour that depends on who is
// serving. The census is driven through the REAL contract resolver (`contractForModel`, no
// faked contract object) so each row is the contract the product would actually resolve for
// that seam, and it asserts BOTH WAYS on every one of them:
//
//   · a person is owed      → the turn NEVER exits mute: the silent retry, then the required reply.
//   · nobody is owed        → the "did work, nothing to say" exit is byte-identical.
//
// It also asserts the seams are genuinely DIFFERENT (their `answersInReasoning` values do
// not all agree), because a census over rows that happened to be identical would prove
// nothing about the gate that caused the defect.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolCall } from '@dojo/shared';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

// The honest end of the ladder is a DURABLE platform-voice row, and this is the module that
// writes it. Mocked so the assertion is about WHAT THE PERSON GETS, not about a DB.
const ghostSpy = vi.fn(() => ({ eventId: null, noticeId: 'notice-1' }));
vi.mock('../../../floor-ghost.js', () => ({
  recordFloorGhost: (...a: unknown[]) => ghostSpy(...(a as [])),
  MAX_FLOOR_STEER_ATTEMPTS: 2,
}));

// The steer rung writes a durable row too; the ladder's bound is what this file tests, not
// that write. `persistEngineSteer`'s own tests own the row.
vi.mock('../../../engine-steer.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return { ...real };
});

// THE CONTRACT IS RESOLVED FOR REAL. `contractForConfiguredModel` is the registry door (it
// needs a database); the seam under it, `contractForModel`, is a pure function of the three
// provider facts. So the door is redirected at the model id and the real resolver answers.
import { contractForModel, type ModelContract } from '../../../../model-contract.js';

let CONTRACT: ModelContract;
vi.mock('../../../../model.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  contractForConfiguredModel: () => CONTRACT,
}));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runEmptyResponse } from '../empty-response.js';
import { steerFired } from '../../../steer-queue.js';
import type { PostCallClassifyContext } from '../index.js';

/**
 * THE TRANSPORTS, as the product configures them. Each row is the provider facts
 * `contractForModel` is handed (`config/schema.ts` types the four provider kinds:
 * anthropic · openai · openai-compatible · ollama), resolved here rather than asserted.
 *
 * Anthropic carries NO base URL on purpose: it is a separate SDK transport
 * (`providers/anthropic-sdk.ts`) whose provider row has no OpenAI-style root, which is
 * exactly how it lands on the base contract — and the base contract is where the DeepSeek
 * gate made the engine mute.
 */
const TRANSPORTS = [
  { seam: 'anthropic (claude, own SDK)', facts: { providerBaseUrl: null, apiModelId: 'claude-opus-4-5-20260101' } },
  { seam: 'openai (gpt, /v1)', facts: { providerBaseUrl: 'https://api.openai.com/v1', apiModelId: 'gpt-5' } },
  { seam: 'openai-compatible (local vLLM/LM-Studio)', facts: { providerBaseUrl: 'http://localhost:8000/v1', apiModelId: 'qwen3-32b' } },
  { seam: 'openrouter proxy (non-deepseek model)', facts: { providerBaseUrl: 'https://openrouter.ai/api/v1', apiModelId: 'anthropic/claude-opus-4.5' } },
  { seam: 'openrouter proxy (deepseek model)', facts: { providerBaseUrl: 'https://openrouter.ai/api/v1', apiModelId: 'deepseek/deepseek-v4' } },
  { seam: 'deepseek native (bare host)', facts: { providerBaseUrl: 'https://api.deepseek.com', apiModelId: 'deepseek-chat' } },
  { seam: 'openai-compatible declaring behaves_like deepseek-native', facts: { providerBaseUrl: 'http://localhost:8000/v1', apiModelId: 'local-v4', providerBehavesLike: 'deepseek-native' } },
] as const;

const reArmSpy = vi.fn();

const modelResult = (
  over: Partial<{ content: string; toolCalls: ToolCall[]; stopReason: string; reasoningContent: string }> = {},
): PostCallClassifyContext['result'] => ({
  content: '', toolCalls: [] as ToolCall[],
  inputTokens: 10, outputTokens: 300, stopReason: 'end_turn', ...over,
} as unknown as PostCallClassifyContext['result']);

const turnCtx = (over: Record<string, unknown> = {}): PostCallClassifyContext['turnCtx'] => ({
  startAckSteerRequested: false,
  startAckSteerArmedThisTurn: false,
  engineStartAckDeliveredThisTurn: false,
  root: null,
  conversationId: 'conv-1',
  ...over,
} as unknown as PostCallClassifyContext['turnCtx']);

/**
 * THE OWNER'S TURN. He asked a concrete question, the engine holds his unanswered row, and
 * the model's whole output this round was tool calls — so there is no deferred reply stashed
 * anywhere and nothing for finalize to route.
 */
const ctxFor = (over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext => ({
  agentId: 'pm-agent',
  configuredModelId: 'configured-1',
  result: modelResult(),
  reArmIfStrandedNoAnswer: reArmSpy,
  turnCtx: turnCtx(),
  turnNumber: 41,
  chosenConvKey: 'conv-1',
  isA2ATurn: false,
  isEngineTurn: false,
  counterpartyIsAgentSender: false,
  hasUnansweredUser: true,
  triggerRow: { rowid: 1, content: 'why do you keep reassigning the email project?' },
  ...over,
} as unknown as PostCallClassifyContext);

/** Nobody is waiting: no unanswered row, no trigger ask, no start-ack owed. */
const NOBODY_OWED: Partial<PostCallClassifyContext> = { hasUnansweredUser: false, triggerRow: null };

/** The state after the two `history_search` calls the screenshot shows have run. */
function afterHistorySearches(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({
    agentId: 'pm-agent', contextWindow: 200_000, isAutoRouted: false,
    configuredModelId: 'configured-1', turnNumber: 41, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null,
    lastUserMessageContent: 'why do you keep reassigning the email project?',
    lastUserMessageId: 'msg-owner-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, {
    phase: 'postCallClassify', loopCount: 2, modelId: 'configured-1',
    toolCallsExecutedThisTurn: 2, ...over,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  CONTRACT = contractForModel(TRANSPORTS[0].facts);
});

describe('t125 — the silent turns (Q2): a turn that owes a person never ends in silence', () => {
  it('THE SEAMS ARE REALLY DIFFERENT — otherwise this census would prove nothing', () => {
    const resolved = TRANSPORTS.map((t) => contractForModel(t.facts));
    // The gate that caused the defect genuinely splits these rows.
    expect(new Set(resolved.map((c) => c.answersInReasoning))).toEqual(new Set([true, false]));
    // And the seam the owner is on is on the FALSE side — the side that had no door.
    expect(contractForModel(TRANSPORTS[0].facts).answersInReasoning).toBe(false);
    expect(contractForModel(TRANSPORTS[0].facts).id).toBe('generic-openai-compatible');
  });

  describe('THE CENSUS, both ways, on every transport', () => {
    for (const { seam, facts } of TRANSPORTS) {
      describe(seam, () => {
        beforeEach(() => { CONTRACT = contractForModel(facts); });

        it('a person is owed: the turn does NOT end — it walks the ladder', () => {
          const out = runEmptyResponse(afterHistorySearches(), ctxFor());
          expect(out.directive).toBe('continue');
          if (out.directive !== 'continue') throw new Error('unreachable');
          // The ladder's own latch, shared with the wrong-channel door, so a turn still gets
          // exactly ONE silent re-run no matter which seam is serving.
          expect(out.state.retriedEmptyResponse).toBe(true);
        });

        it('nobody is owed: the not-a-failure exit is byte-identical', () => {
          const out = runEmptyResponse(afterHistorySearches(), ctxFor(NOBODY_OWED));
          expect(out.directive).toBe('exit');
          if (out.directive !== 'exit') throw new Error('unreachable');
          expect(out.reason).toBe('empty-response-after-tools');
          // No ghost, no toast, no re-arm: a legitimate quiet end stays quiet.
          expect(ghostSpy).not.toHaveBeenCalled();
          expect(broadcastSpy).not.toHaveBeenCalled();
          expect(reArmSpy).not.toHaveBeenCalled();
        });

        it('a person is owed: after the silent retry the turn ends into the required reply, never mute here', () => {
          const first = runEmptyResponse(afterHistorySearches(), ctxFor());
          expect(first.directive).toBe('continue');
          if (first.directive !== 'continue') throw new Error('unreachable');
          // Still empty: no nudge and no card here; the loop's exit makes the required reply (forced-reply.ts).
          const second = runEmptyResponse(first.state, ctxFor());
          expect(second.directive).toBe('exit');
          if (second.directive !== 'exit') throw new Error('unreachable');
          expect(second.reason).toBe('empty-response-owed');
          expect(steerFired(second.state.steerQueue, 'empty-response')).toBe(false);
          // Not an engine cut: the model's silence is what the request's count and its hold read.
          expect(second.state.engineCutExit).toBeNull();
          expect(ghostSpy).not.toHaveBeenCalled();
          expect(reArmSpy).not.toHaveBeenCalled();
        });

        it('the required reply that comes back empty ends the turn at once, with no retry', () => {
          const out = runEmptyResponse(afterHistorySearches(), ctxFor({ turnCtx: turnCtx({ forcedReplySpent: true }) }));
          expect(out.directive).toBe('exit');
          if (out.directive !== 'exit') throw new Error('unreachable');
          expect(out.reason).toBe('forced-reply-empty');
          expect(out.state.retriedEmptyResponse).toBe(false);
        });
      });
    }
  });

  describe('who counts as a person — unchanged on every transport', () => {
    for (const { seam, facts } of TRANSPORTS) {
      it(`${seam}: an A2A peer, an engine turn and an agent sender are not people`, () => {
        CONTRACT = contractForModel(facts);
        for (const over of [{ isA2ATurn: true }, { isEngineTurn: true }, { counterpartyIsAgentSender: true }]) {
          const out = runEmptyResponse(afterHistorySearches(), ctxFor(over));
          expect(out.directive).toBe('exit');
          if (out.directive !== 'exit') throw new Error('unreachable');
          expect(out.reason).toBe('empty-response-after-tools');
        }
        expect(ghostSpy).not.toHaveBeenCalled();
      });

      it(`${seam}: an owed START-ACK is a person too, with no unanswered row`, () => {
        CONTRACT = contractForModel(facts);
        const out = runEmptyResponse(afterHistorySearches(), ctxFor({
          ...NOBODY_OWED, turnCtx: turnCtx({ startAckSteerRequested: true }),
        }));
        expect(out.directive).toBe('continue');
      });

      // ⚠ EACH HALF OF THE OWED PREDICATE, ALONE. Added after two mutants SURVIVED the
      // first census: dropping `hasUnansweredUser` and dropping `triggerRow` each left the
      // whole suite green, because every fixture above sets BOTH and either one alone keeps
      // the predicate true. A census that cannot tell which half is load-bearing is not a
      // census of the predicate — it is a census of their disjunction.
      it(`${seam}: an UNANSWERED USER alone is a person, with no trigger ask`, () => {
        CONTRACT = contractForModel(facts);
        const out = runEmptyResponse(afterHistorySearches(), ctxFor({
          hasUnansweredUser: true, triggerRow: null,
        }));
        expect(out.directive).toBe('continue');
      });

      it(`${seam}: a TRIGGER ASK alone is a person, with nothing recorded as unanswered`, () => {
        CONTRACT = contractForModel(facts);
        const out = runEmptyResponse(afterHistorySearches(), ctxFor({
          hasUnansweredUser: false, triggerRow: { rowid: 9, content: 'where are we on the email project?' },
        }));
        expect(out.directive).toBe('continue');
      });
    }
  });
});
