// ════════════════════════════════════════
// PHASE-6 T5 (CUT 5) — THE `callLLM` STEP. RULING P6-R1: a step is a DIRECTORY
// with one entry point; this is it. CUT 5 in the ordinal order (P6-R3(3)).
//
// WHAT MOVED: `loop.ts`'s `callLLM` span — mint the turn's message id, choose the
// model, put the volatile injections on the tail, call the provider with the
// retry-and-fallback ladder and the streaming sinks, then the post-call
// bookkeeping (the shadow probe, the model lock, the no-reply sentinel and the
// tool-alias resolution).
//
// WHAT THIS STEP IS ALONE IN OWING, and both are in its contract test:
//   • TWO OUTPUTS. It is the first tranche whose span DECLARES anything the rest
//     of the turn reads — the message id and the model result, read at 75 hit
//     lines in `postCallClassify` and `execute`. A module cannot leave a
//     declaration behind for its caller, so they come back on the proceed arm,
//     where the type puts them out of reach of every other arm.
//   • THE TURN'S ONLY ABANDON EXITS. See `model-call.ts`'s header.
//
// WHAT STAYED IN THE DRIVER, DELIBERATELY: the spin-brake grace's countdown, the
// last seven lines of the old span. It WRITES `state.phase`, and rule 2 of the
// shared contract is that the phase belongs to the driver — a step that writes it
// is writing a field the next step overwrites. Leaving it at the call site keeps
// the statement order and the bytes identical and keeps the rule intact. ⚠ AND IT
// IS DEAD WHERE IT STANDS, which this cut MEASURED and did not fix: the driver
// advances `phase` into `postCallClassify` four statements later, and the only
// reader of `state.phase` is the `while` head, so "concluding the turn" concludes
// nothing. A relocation does not get to change behaviour; the finding is handed up.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type { ModelCallParams } from '../../../model.js';

/** The array the assembler hands over and the injections append to. */
type ModelMessage = ModelCallParams['messages'][number];
import type { callModel } from '../../../model.js';
import type { SteerEntry } from '../../steer-queue.js';
import { advance, type AgentTurnState } from '../../state.js';
import { proceed, type StepOutcome } from '../step-outcome.js';
import { resolveToolAlias } from '../../../../tools/aliases.js';
import { isBareNoReplySentinel } from '@dojo/shared';
import { queueEmbedding } from '../../../../memory/embeddings.js';
import { redactHandedCredentials } from '../../../../credentials/secret-fields.js';
import type { AssembledContext } from '../../../../memory/assembler.js';
import type { AssemblyContext } from '../../../../prompt/registry/types.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { selectModel } from './model-selection.js';
import { injectAndRecord } from './pre-call-injections.js';
import { callWithRetryAndFallback } from './model-call.js';
import type { AgentStatus } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances INTO before calling this step. It never writes it. */
export const CALL_LLM_PHASE = 'callLLM' as const;

/** Everything the span read from the driver, measured rather than guessed. */
export interface CallLLMContext {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly db: import('better-sqlite3').Database;
  readonly counterparty: TurnCounterparty;
  readonly isA2ATurn: boolean;
  readonly isAutoRouted: boolean;
  readonly configuredModelId: string;
  readonly lastUserMessageContent: string | null;
  /** The assembled call, as `assemble` left it. The injections append to this array. */
  readonly messages: ModelMessage[];
  readonly systemPrompt: string;
  readonly assembled: AssembledContext;
  readonly modelContext: AssemblyContext;
  readonly volatileFrom: number | undefined;
  readonly steerAwaitingConfirm: SteerEntry | null;
  /** Driver CLOSURES, passed as values so their bindings stay live across the
   *  boundary (CUT 2's precedent) and so a step never points back at the driver. */
  readonly revertTriggerStampOnAbort: () => void;
  readonly setAgentStatus: (agentId: string, status: AgentStatus) => void;
}

/** The shared outcome, plus this step's two outputs on the proceed arm ONLY. */
export type CallLLMOutcome =
  | { readonly directive: 'proceed'; readonly state: AgentTurnState; readonly messageId: string; readonly result: Awaited<ReturnType<typeof callModel>> }
  | Exclude<StepOutcome, { directive: 'proceed' }>;

export async function runCallLLM(stateIn: AgentTurnState, ctxIn: CallLLMContext): Promise<CallLLMOutcome> {
  const {
    agentId, turnCtx, turnNumber, counterparty, isA2ATurn, isAutoRouted, configuredModelId,
    lastUserMessageContent, messages, systemPrompt, assembled: ctx, modelContext: mctx,
    volatileFrom, steerAwaitingConfirm, revertTriggerStampOnAbort, setAgentStatus,
  } = ctxIn;
  let state = stateIn;

  const messageId = uuidv4();
  state = advance(state, { currentMessageId: messageId });

  const selection = await selectModel(state, agentId, isAutoRouted, configuredModelId, lastUserMessageContent, systemPrompt, messages, revertTriggerStampOnAbort);
  state = selection.state;
  const { routerTier, routerConfidence, routerFreshDecision, excludedModels } = selection;

  const injected = await injectAndRecord(state, {
    agentId, turnNumber, modelId: selection.modelId, messages, systemPrompt,
    ctx, mctx, volatileFrom, counterparty, steerAwaitingConfirm, turnCtx, db: ctxIn.db,
  });
  state = injected.state;

  const called = await callWithRetryAndFallback(state, selection.modelId, {
    agentId, turnCtx, turnNumber, messageId, messages, systemPrompt,
    useTools: injected.useTools, isAutoRouted, isA2ATurn, excludedModels,
    revertTriggerStampOnAbort, setAgentStatus, assembled: ctx, routerTier, counterparty,
  });
  if (called.abandoned) return called.abandoned as CallLLMOutcome;
  state = called.state;
  const { result } = called;
  const modelId = called.modelId;

  // ── Low-confidence shadow probe (gated, off by default) ──
  // After the real answer is in hand, optionally re-run this turn at the
  // next-lower tier in the background to learn whether we over-routed. Fully
  // best-effort and budget-capped; never delays or affects this response.
  // Only on the fresh-decision path, and only for text-only turns (skip when
  // the model kicked off tool calls, a no-tools shadow can't be compared).
  if (
    isAutoRouted && routerFreshDecision && routerTier &&
    result.toolCalls.length === 0 && result.content
  ) {
    const probeTier = routerTier;
    const probeConfidence = routerConfidence;
    const probeContent = result.content;
    // The authoritative user query, clean of engine injections.
    const probeMsgs = messages as Array<{ role: string; content: string | object[] }>;
    const probeQuery = lastUserMessageContent ?? '';
    void (async () => {
      try {
        const { maybeProbe } = await import('../../../../router/probe.js');
        maybeProbe({
          agentId,
          systemPrompt,
          messages: probeMsgs as Array<{ role: 'user' | 'assistant'; content: string | object[] }>,
          tier: probeTier as 'light' | 'standard' | 'heavy',
          confidence: probeConfidence,
          query: probeQuery,
          realAnswer: probeContent,
        });
      } catch { /* best effort */ }
    })();
  }

  // ── Lock model for tool loops ──
  // For auto-routed agents that just kicked off tool calls, pin the
  // chosen model for the remainder of this turn so tools+follow-up calls
  // use the same model.
  if (isAutoRouted && !state.lockedModelId && result.toolCalls.length > 0) {
    state = advance(state, { lockedModelId: modelId, lockedTier: routerTier });
    logger.info('v2 auto-router: locking model for tool loop', { modelId, tier: routerTier }, agentId);
  }

  // Cost recording happens inside callModel (model.ts records once per
  // provider path). The v2 loop must NOT call recordCost again, doing so
  // double-bills the cost tracker. Verified against logs 2026-05-04.
  //
  // Embedding queueing: callModel does NOT queue embeddings, that's the
  // runtime's job. v1 calls queueEmbedding for assistant text responses
  // (runtime.ts), so v2 does the same.
  // Skip embedding the no-reply sentinel, it's not real content and the
  // matching assistant message row never gets persisted.
  // PHASE-1 T8: was a fourth, slightly narrower spelling of "the whole message is the
  // sentinel" — it did not tolerate the markdown wrappers the weak model adds about half
  // the time, so a backtick-wrapped sentinel was embedded as if it were real content.
  // Same intent, one owner, and the widening only ever skips embedding a non-message.
  const isNoReplySentinel =
    !!result.content &&
    result.toolCalls.length === 0 &&
    isBareNoReplySentinel(result.content);
  if (result.content && result.content.trim().length > 0 && !isNoReplySentinel) {
    try {
      // T5b: the semantic index is a persist seam too — a secret in the
      // preview is reachable by recall and by summarisation. Embed what the
      // row will hold, not what the model said.
      queueEmbedding('message', messageId, agentId, redactHandedCredentials(agentId, result.content));
    } catch { /* best effort */ }
  }

  // C27 hook 1: canonicalize aliased (renamed) tool-call names + args BEFORE
  // any gate/classifier reads them (they match on canonical names). Tombstoned
  // tools are left as-is; executeTool returns their pointer error at dispatch.
  for (const tc of result.toolCalls) {
    const aliasResolved = resolveToolAlias(tc.name, tc.arguments ?? {});
    if (!aliasResolved.tombstone && aliasResolved.name !== tc.name) {
      tc.name = aliasResolved.name;
      tc.arguments = aliasResolved.args;
    }
  }

  state = advance(state, { lastResponse: result, toolCalls: result.toolCalls });
  return { ...proceed(state), directive: 'proceed', state, messageId, result } as CallLLMOutcome;
}
