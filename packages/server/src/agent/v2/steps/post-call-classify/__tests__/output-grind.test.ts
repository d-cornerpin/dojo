// ════════════════════════════════════════════════════════════════════════════════════════
// SWEEP-A TB8 JOB 1 — THE GRIND: DETECT, AND RESTART.
//
// The owner's question: *"Should an agent get stuck grinding? How do we detect and
// restart?"* The class, from the record: a model call that reasons endlessly, makes NO tool
// call, produces NO deliverable, and runs to the provider's output cap.
//
// ── STEP 1: THE BOUND, DERIVED FROM THE DURABLE SINK, NEVER INVENTED (#14) ───────────────
// `cost_records` joined to `models` — 19,124 completed model calls carrying a known cap,
// 2026-07-27 → 2026-08-06, spanning all four batteries:
//
//   calls that reached their model's OWN configured `max_output_tokens`      17  (0.089%)
//   … and every recorded runaway is one of them, including T14's pair
//     (2026-08-05 04:31:35, 149,516 ms) and (05:04:04, 142,663 ms) and
//     BATTERY4's single instance (2026-08-06 01:00:54, 169,550 ms)
//   … on TWO different models and TWO different caps (deepseek-v4-flash @16,384
//     ×16, and qwen3.5-9b @32,768 ×1 — 95 input tokens, 417,840 ms)
//
// BOTH NAMED CANDIDATES WERE TESTED AGAINST THAT CORPUS AND BOTH ARE REFUSED, with numbers:
//
//   • DURATION — refused, because the corpus ORDERS THE TWO POPULATIONS WRONG. Legitimate
//     calls run 216.3 s / 212.6 s / 176.9 s / 168.1 s / 166.7 s (output 1.6k–2.9k tokens,
//     no truncation), while recorded runaways go as low as 129.95 s. A duration bound low
//     enough to catch all 17 catches ~26 legitimate calls. There is no ordering here to
//     put a threshold in.
//   • OUTPUT-TOKENS-WITHOUT-A-TOOL-CALL, below the cap — refused on margin. The nearest
//     legitimate call is 16,251 output tokens — 133 tokens, 0.8%, under the 16,384 cap —
//     and it ENDED IN A TOOL CALL after 60,598 reasoning characters, against the runaway's
//     61,633 (1.7% apart). Any sub-cap threshold is a coin flip between the two.
//
// WHAT SEPARATES THEM CATEGORICALLY, at 17/17 caught and 0 of 19,107 false: the call
// exhausted the model's OWN configured output budget and made no tool call. The bound is
// therefore the cap the product already configures per model, not a number chosen here —
// and it is the provider that reports the crossing, so the engine cannot be wrong about it.
//
// ── STEP 2: WHY THE ENGINE NEVER SAW IT — THE CAUSE ─────────────────────────────────────
// `agent/model.ts` reported `stopReason: toolCalls.length > 0 ? 'tool_use' : 'end_turn'` and
// threw the provider's `finish_reason` away. Every OpenAI-compatible call — the entire
// floor-model path — told the engine "the model finished normally" after the provider had
// truncated it. So `outputTruncationClassifier`, whose `TRUNCATION_STOP_REASONS` has held
// `'length'` since it was written, and the empty-response ladder that reads it, have been
// structurally unreachable on that path for their whole lives. The system had the move
// available and could not see the board.
//
// The restart is that ladder, with no new mechanism and no new voice: a steer naming what
// happened (model-visible, OR2), bounded at one by the steer queue's own latch, then the
// EXISTING failure surface — the toast and `reArmIfStrandedNoAnswer()`.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ToolCall } from '@dojo/shared';

const broadcastSpy = vi.fn();
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: (...a: unknown[]) => broadcastSpy(...(a as [])) }));

import { advance, initState, type AgentTurnState } from '../../../state.js';
import { runEmptyResponse } from '../empty-response.js';
import { steerFired, nextSteer, STEER_PRECEDENCE } from '../../../steer-queue.js';
import { outputTruncationClassifier } from '../../../classifiers/output.js';
import { resolveOpenAIStopReason } from '../../../../model.js';
import type { PostCallClassifyContext } from '../index.js';

const reArmSpy = vi.fn();

const modelResult = (
  over: Partial<{ content: string; toolCalls: ToolCall[]; stopReason: string }> = {},
): PostCallClassifyContext['result'] => ({
  content: '', toolCalls: [] as ToolCall[],
  inputTokens: 10, outputTokens: 16_384, stopReason: 'end_turn', ...over,
} as unknown as PostCallClassifyContext['result']);

const ctxFor = (over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext => ({
  agentId: 'kevin',
  result: modelResult(),
  reArmIfStrandedNoAnswer: reArmSpy,
  ...over,
} as unknown as PostCallClassifyContext);

function freshState(over: Partial<AgentTurnState> = {}): AgentTurnState {
  const base = initState({
    agentId: 'kevin', contextWindow: 128_000, isAutoRouted: false,
    configuredModelId: 'test-model', turnNumber: 7, triggeredByIMessage: false,
    triggeredByA2AReplyIntent: null, lastUserMessageContent: 'do the thing',
    lastUserMessageId: 'msg-user-1',
  } as Parameters<typeof initState>[0]);
  return advance(base, { phase: 'postCallClassify', loopCount: 2, modelId: 'test-model', ...over });
}

beforeEach(() => { vi.clearAllMocks(); });

// ────────────────────────────────────────────────────────────────────────────────────────
describe('TB8 JOB 1 — the provider’s own terminal reason reaches the engine', () => {
  it('a truncation is reported, and it is the ONLY thing the synthesis could not say', () => {
    // The bound, arriving as a fact from the provider rather than a threshold we picked.
    expect(resolveOpenAIStopReason('length', 0)).toBe('length');
    // …and a truncation that still managed a tool call is not hidden behind 'tool_use'.
    expect(resolveOpenAIStopReason('length', 3)).toBe('length');
  });

  it('the ordinary reasons keep EXACTLY the shape every reader has seen', () => {
    // 'stop' and 'tool_calls' say only what the synthesis already said, so they are left
    // to it — this change adds a signal, it does not re-spell the existing ones.
    expect(resolveOpenAIStopReason('stop', 0)).toBe('end_turn');
    expect(resolveOpenAIStopReason('tool_calls', 2)).toBe('tool_use');
    expect(resolveOpenAIStopReason(null, 0)).toBe('end_turn');
    expect(resolveOpenAIStopReason(undefined, 1)).toBe('tool_use');
    expect(resolveOpenAIStopReason('', 0)).toBe('end_turn');
  });

  it('the classifier that was waiting for it accepts it unchanged', () => {
    expect(outputTruncationClassifier({ stopReason: 'length', contentLength: 0, currentBudget: 0 }).truncated).toBe(true);
    expect(outputTruncationClassifier({ stopReason: 'end_turn', contentLength: 0, currentBudget: 0 }).truncated).toBe(false);
  });

  it('THE CAUSE IS GONE: model.ts no longer fabricates the stop reason on the stream path', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../../model.ts'), 'utf8');
    // The exact discarding line, which every DeepSeek/OpenAI/OpenRouter call went through.
    expect(src).not.toMatch(/stopReason:\s*toolCalls\.length > 0 \? 'tool_use' : 'end_turn',/);
    // The provider's field is now READ off the stream.
    expect(src).toMatch(/finish_reason/);
    expect(src).toMatch(/resolveOpenAIStopReason\(/);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('TB8 JOB 1 — the grind rung: detect, steer once, then the existing surface', () => {
  it('RUNG 1 — a truncated call with no tool call is steered, not silently re-run', () => {
    const out = runEmptyResponse(freshState(), ctxFor({
      result: modelResult({ stopReason: 'length', content: '', toolCalls: [] }),
    }));
    expect(out.directive).toBe('continue');
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(steerFired(out.state.steerQueue, 'output-grind')).toBe(true);
    const next = nextSteer(out.state.steerQueue);
    expect(next?.floor).toBe('output-grind');
    // The steer NAMES what happened — the model is told it burned its budget thinking.
    expect(next!.content).toMatch(/output budget/i);
    expect(next!.content).toMatch(/tool/i);
    // OR2: it is a model-visible [System: ...] steer, never a line for the person.
    expect(next!.content.startsWith('[System:')).toBe(true);
    // Nothing was surfaced to the person on rung 1 — the retry is the agent's chance.
    expect(broadcastSpy).not.toHaveBeenCalled();
    expect(reArmSpy).not.toHaveBeenCalled();
  });

  it('THE HALF THAT USED TO ESCAPE ENTIRELY — a truncated FRAGMENT takes the same rung', () => {
    // A grind that managed a few words before the budget ran out never reached the empty
    // ladder at all (its guard required empty content), so the engine persisted a
    // mid-sentence fragment as the agent's answer and ended the turn.
    const out = runEmptyResponse(freshState(), ctxFor({
      result: modelResult({ stopReason: 'length', content: 'Okay, so first I should check whether the', toolCalls: [] }),
    }));
    expect(out.directive).toBe('continue');
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(steerFired(out.state.steerQueue, 'output-grind')).toBe(true);
  });

  it('RUNG 2 — it happens again in the same turn: the EXISTING failure surface, bounded', () => {
    const first = runEmptyResponse(freshState(), ctxFor({
      result: modelResult({ stopReason: 'length', content: '', toolCalls: [] }),
    }));
    if (first.directive !== 'continue') throw new Error('unreachable');
    const second = runEmptyResponse(first.state, ctxFor({
      result: modelResult({ stopReason: 'length', content: '', toolCalls: [] }),
    }));
    expect(second.directive).toBe('exit');
    if (second.directive !== 'exit') throw new Error('unreachable');
    expect(second.reason).toMatch(/grind/i);
    // The turn record says what happened, and the ask is re-armed rather than stranded.
    expect(reArmSpy).toHaveBeenCalledTimes(1);
    expect(broadcastSpy).toHaveBeenCalledTimes(1);
    const toast = broadcastSpy.mock.calls[0][0] as { type: string; code: string; error: string; retryable: boolean };
    expect(toast.type).toBe('chat:error');
    expect(toast.code).toBe('MODEL_FAILED');
    expect(toast.retryable).toBe(true);
    // BOUNDED: exactly two model calls were spent on the grind, never three.
    expect(second.state.steerQueue.pending).toHaveLength(0);
  });

  it('NEGATIVE CONTROL — a truncation that DID call a tool is not the measured class', () => {
    // 0 of the 17 recorded instances made a tool call. A truncated tail after real work is
    // a different question and this rung does not claim it.
    const out = runEmptyResponse(freshState(), ctxFor({
      result: modelResult({
        stopReason: 'length', content: 'checking',
        toolCalls: [{ id: 'tc-1', name: 'file_read', arguments: {} } as ToolCall],
      }),
    }));
    expect(out.directive).toBe('proceed');
    if (out.directive !== 'proceed') throw new Error('unreachable');
    expect(steerFired(out.state.steerQueue, 'output-grind')).toBe(false);
  });

  it('NEGATIVE CONTROL — the plain empty response still takes its OWN ladder, unchanged', () => {
    const out = runEmptyResponse(freshState(), ctxFor({
      result: modelResult({ stopReason: 'end_turn', content: '', toolCalls: [] }),
    }));
    expect(out.directive).toBe('continue');
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(out.state.retriedEmptyResponse).toBe(true);            // the silent retry, rung 1
    expect(steerFired(out.state.steerQueue, 'output-grind')).toBe(false);
    expect(steerFired(out.state.steerQueue, 'empty-response')).toBe(false);
  });

  it('NEGATIVE CONTROL — a normal answer is untouched', () => {
    const out = runEmptyResponse(freshState(), ctxFor({
      result: modelResult({ stopReason: 'end_turn', content: 'Here is the answer.', toolCalls: [] }),
    }));
    expect(out.directive).toBe('proceed');
  });

  it('the floor is DECLARED in the precedence table, at the head of the loop-health band', () => {
    const spec = STEER_PRECEDENCE.find((f) => f.id === 'output-grind');
    expect(spec).toBeDefined();
    const p = (id: string) => STEER_PRECEDENCE.find((f) => f.id === id)!.priority;
    // LOOP HEALTH — "the turn is going wrong; the user is not owed anything yet" — so it
    // yields to every silence floor…
    expect(p('going-idle-in-progress')).toBeLessThan(spec!.priority);
    // …and outranks the ladder it precedes, which is the whole point: a grind IS a
    // truncation, and diagnosing it as a plain empty response is what cost three full
    // output budgets and a nudge naming the wrong thing.
    expect(spec!.priority).toBeLessThan(p('empty-response'));
    expect(spec!.priority).toBeLessThan(p('thrash-gate'));
  });

  it('THE CACHE TENET — the steer rides the tail, nothing enters the prompt prefix', () => {
    const src = readFileSync(path.resolve(__dirname, '../empty-response.ts'), 'utf8');
    // Steers are delivered as synthetic tail messages by the steer queue's own drain. This
    // rung uses `enqueueSteer` and composes no system-prompt text of its own.
    expect(src).toMatch(/enqueueSteer\(/);
    expect(src).not.toMatch(/systemPrompt|systemVolatile/);
  });
});

// ────────────────────────────────────────────────────────────────────────────────────────
// SWEEP CORE-2 item 1 — THE PM IS AN AGENT, AND THIS RUNG IS AGENT-AGNOSTIC.
//
// The owner's binding constraint (2026-08-06): *"This needs to be more of a 'get the agent
// back on track when spinning out' thing like we do with the other agents. Then otherwise,
// let the PM do their work."* The recovery the PM is wired into is THIS ONE — no second
// mechanism was built for her — and the retired per-hour LLM cap that used to stand in for
// it is gone. These clauses pin that she is not excluded, here, beside the rung itself,
// rather than in a second copy of this harness under `tracker/`.
// ────────────────────────────────────────────────────────────────────────────────────────

describe('SWEEP CORE-2 item 1 — the PM inherits the grind rung, driven', () => {
  const pmCtx = (over: Partial<PostCallClassifyContext> = {}): PostCallClassifyContext =>
    ctxFor({ agentId: 'kelly', ...over });

  it("a PM validation turn that burns its whole output budget with no tool call is STEERED", () => {
    const out = runEmptyResponse(freshState(), pmCtx({
      result: modelResult({ stopReason: resolveOpenAIStopReason('length', 0), content: '', toolCalls: [] }),
    }));
    expect(out.directive).toBe('continue');
    if (out.directive !== 'continue') throw new Error('unreachable');
    expect(steerFired(out.state.steerQueue, 'output-grind')).toBe(true);
    const next = nextSteer(out.state.steerQueue);
    expect(next?.floor).toBe('output-grind');
    // OR2 by shape: model-visible, never a line composed for the person.
    expect(next!.content.startsWith('[System:')).toBe(true);
  });

  it('NEGATIVE CONTROL — a PM turn that actually called a validation verb is untouched', () => {
    const out = runEmptyResponse(freshState(), pmCtx({
      result: modelResult({
        stopReason: resolveOpenAIStopReason('length', 1),
        toolCalls: [{ id: 'c1', name: 'work_validate', arguments: {} }] as unknown as ToolCall[],
      }),
    }));
    expect(out.directive).toBe('proceed');
  });

  it('the rung is keyed on the CALL, never on who made it — no agent is named anywhere in it', () => {
    const src = readFileSync(path.resolve(__dirname, '../empty-response.ts'), 'utf8');
    expect(src).not.toMatch(/isPMAgent|getPMAgentId|pm_agent_id|'kelly'/);
  });
});
