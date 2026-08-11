// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — THE `execute` STEP. RULING P6-R1: a step is a DIRECTORY
// with one entry point; this is it. CUT 7 in the ordinal order (P6-R3(3)).
//
// WHAT MOVED: `loop.ts`'s `execute` span — partition the model's tool calls into
// batches, run each call through the executor choke point (the gates, the once-
// guard, the brake, the executor, the recording), persist what a fallback provider
// could not, then run the tracker floors and the turn-ending checks the span owns.
//
// WHAT THIS STEP IS ALONE IN OWING, and each is in the contract test:
//   • THE EXECUTOR CHOKE POINT. Every tool this engine runs runs behind the P3
//     once-per-response guard and the identical-call brake, and the plan's own
//     tranche note says both "stay at the executor choke point". They do:
//     `run-one.ts`, on either side of the single `executeTool` call.
//   • THE A2A SEND CAP IS CARRIED — same note, third duty. `refusal-gates.ts`,
//     at its verbatim value of 5 per recipient per turn.
//   • THE MOST WAYS OUT OF ANY TRANCHE: six, against `assemble`'s one and
//     `callLLM`'s two. Five exits and one continue, every one of them a `break`
//     or a `continue` of the driver's loop before this cut, and the contract test
//     pins the count so a seventh cannot appear silently.
//
// WHAT STAYED IN THE DRIVER, DELIBERATELY: the `advance` into this phase, so
// `validate()` runs on the transition and rule 2 of the shared contract (the phase
// belongs to the driver) holds.
// ════════════════════════════════════════

import type { ToolCall } from '@dojo/shared';
import type { ModelCallResult } from '../../../model.js';
import type { Database } from 'better-sqlite3';
import { clearErrors } from '../../../errors.js';
import { partitionTools } from '../../classifiers/concurrency.js';
import { advance, type AgentTurnState } from '../../state.js';
import { stoppedAgents } from '../../../shared-state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import type { RepeatCallState } from '../../identical-call-brake.js';
import type { AgentStatus } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { runOneToolCall } from './run-one.js';
import { persistXmlFallbackCollapse } from './xml-fallback.js';
import { countTrackerWorkThisIteration } from './tracker-counting.js';
import { runTrackerFloors } from './tracker-floors.js';
import { runDelegationTurnEnd } from './delegation-exit.js';
import { proceed, requestExit, type StepOutcome } from '../step-outcome.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances INTO before calling this step. It never writes it. */
export const EXECUTE_PHASE = 'execute' as const;

/** The shape every tool result takes on its way back to the model. Named here
 *  because five files in this package pass it around; the type is the one the span
 *  already built inline. */
export interface PendingToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
}
export type TurnToolResult = PendingToolResult;

/** What the model call handed this step: the provider's own result shape, imported
 *  from the module that OWNS it rather than re-declared here — a second structural
 *  copy is how two shapes drift apart. */
export type ExecuteModelResult = ModelCallResult;

/** Everything the span read from the driver, measured rather than guessed: the
 *  binder census after this tranche's carrier commit found 22 crossing declarations
 *  at the driver's own top level (of which `state` rides the step contract), plus
 *  the four values `postCallClassify` produces in this same iteration and five
 *  driver module-level items that are PASSED rather than moved because they have
 *  readers outside this span. */
export interface ExecuteContext {
  readonly agentId: string;
  readonly turnCtx: TurnContext;
  readonly turnNumber: number;
  readonly db: Database;
  readonly agent: { name?: string | null; [key: string]: unknown };
  readonly counterparty: TurnCounterparty;
  readonly counterpartyIsAgentSender: boolean;
  readonly chosenConvKey: string | null;
  readonly hasUnansweredUser: boolean;
  readonly triggerRow: { rowid: number } | null;
  readonly triggerWorkId: string | null;
  readonly triggerConversationId: string | null;
  readonly turnStartedAt: string;
  readonly persistRoutingMarker: (label: string) => void;
  /** Both ride BY VALUE on positive evidence (#15), not on an absence: each has ONE
   *  write site, in `postCallClassify`, in straight-line code — nothing can write
   *  them while the driver is suspended awaiting this step. The one crossing this
   *  span WRITES is on the turn's bag instead (`anyToolStartedThisTurn`), because
   *  it is read from a wall-clock timer callback. */
  readonly engineStartAckDeliveredThisTurn: boolean;
  readonly deferredDeliveredByAck: boolean;
  readonly identicalCallState: RepeatCallState;
  readonly reminderLaneRefusedSigs: Set<string>;
  readonly startAckArmed: boolean;
  readonly startAckArmedAtMs: number;
  readonly fireStartAckIfOwed: (via: 'timer' | 'first-tool') => Promise<void>;
  /** Produced by `postCallClassify`, in this same iteration. */
  readonly result: ExecuteModelResult;
  readonly messageId: string;
  readonly persistedContent: string | null;
  readonly interAgentTurn: boolean;
  readonly hasXmlFallbackTools: boolean;
  readonly effectiveModelIdForPersist: string;
  /** PASSED, not moved and not copied: each is declared at `loop.ts` module level
   *  and read outside this span too, so one declaration handed across is the only
   *  shape that keeps every reader true. `STALE_TASK_WINDOW_MINUTES` additionally
   *  has a guard pinning it at `loop.ts` BY PATH on purpose (CUT 6's finding). */
  readonly staleTaskWindowMinutes: number;
  readonly maxToolLoops: number;
  readonly engineBlockEscapeHatch: string;
  readonly engineStartAckAfterMs: number;
  readonly setAgentStatus: (agentId: string, status: AgentStatus) => void;
}

/** What the whole RESPONSE shares across its calls. Inside the loop these were the
 *  batch loop's own locals, captured by the per-call closure; a module hands them
 *  over explicitly. This is NOT a second carrier mechanism under RULING P6-R3(1) —
 *  nothing here crosses a STEP boundary; it is one step package's own scratch,
 *  created and consumed inside a single call to `runExecute`. */
export interface ExecuteScratch {
  state: AgentTurnState;
  recentSigs: string[];
  readonly onceGuardExecuted: Map<string, string>;
  calledCompleteTask: boolean;
  calledFireAndForgetGen: boolean;
}

/** The step's outcome. On the proceed arm it carries the ONE declaration of this
 *  span that the rest of the turn reads: the tool results, which the driver hands
 *  straight to `postExecution`. */
export type ExecuteOutcome =
  | { readonly directive: 'proceed'; readonly state: AgentTurnState; readonly turnToolResults: TurnToolResult[] }
  | { readonly directive: 'continue'; readonly state: AgentTurnState }
  | { readonly directive: 'exit'; readonly state: AgentTurnState; readonly reason: string };

export async function runExecute(state: AgentTurnState, ctx: ExecuteContext): Promise<ExecuteOutcome> {
  const { agentId, result, counterparty, setAgentStatus } = ctx;

  const batches = partitionTools(result.toolCalls);
  const turnToolResults: Array<{
    toolCallId: string;
    name: string;
    content: string;
    isError: boolean;
    contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
  }> = [];

  let stoppedMidBatch = false;
  let calledCompleteTask = false;
  let calledFireAndForgetGen = false;
  // P3 once-per-response guard (lanes & lineage): a NON-IDEMPOTENT call
  // signature (fire-and-forget generation, people-channel send) executes
  // AT MOST ONCE per model response. Maps signature -> short first-result
  // note; a second identical call in the SAME response returns a
  // structured result naming the first execution instead of re-running
  // the side effect (the four-images / double-send class). Exact
  // signature only; different args execute; repeats across RESPONSES are
  // governed by the loop detector and brake, unchanged.
  const onceGuardExecuted = new Map<string, string>();
  let recentSigs = state.recentToolSignatures;

  const sc: ExecuteScratch = {
    state, recentSigs, onceGuardExecuted, calledCompleteTask, calledFireAndForgetGen,
  };
  const runOne = (tc: ToolCall): Promise<PendingToolResult> => runOneToolCall(tc, ctx, sc);

  // The batch loop. `break outer` became a labelled break of this same loop —
  // the label and the loop are both inside the step now, so the only control flow
  // that had to be converted is the flow that used to leave the DRIVER's loop.
  outer: for (const batch of batches) {
    if (stoppedMidBatch) break;

    // ── UX-REPAIR T37: THE STOP IS HONOURED BETWEEN BATCHES, NOT ONLY BETWEEN
    // SERIAL CALLS ──
    //
    // The per-call check below lives inside the SERIAL arm, so a stop landing
    // during a parallel `safe` batch (three web_searches, twenty seconds) was
    // seen by nothing until the next model call — and by then a whole further
    // round had gone out (dev box control C3, 2026-08-11: stop 07:34:19, the
    // next batch dispatched at 07:34:46). The batch already in flight cannot be
    // unsent; the NEXT one can, and its calls come back as Cancelled exactly
    // like the serial arm's remainder, so the model's context is never missing
    // a result for a call it made.
    if (stoppedAgents.has(agentId)) {
      for (const rem of batch.calls) {
        turnToolResults.push({
          toolCallId: rem.id,
          name: rem.name,
          content: 'Cancelled by user (agent stopped).',
          isError: true,
        });
      }
      stoppedMidBatch = true;
      break outer;
    }

    // Per-call processing (used in both parallel and serial paths).
    if (batch.category === 'safe') {
      // Parallel execution for safe reads
      const results = await Promise.all(batch.calls.map(runOne));
      turnToolResults.push(...results);
    } else {
      // Serial execution for everything else
      for (const tc of batch.calls) {
        // Stop check between each serial call. UX-REPAIR T37: READ, never
        // delete — the run's own exit path owns the clear (`shared-state.ts`).
        if (stoppedAgents.has(agentId)) {
          // Fill synthetic Cancelled for remaining calls (Part XIX preservation)
          const remaining = batch.calls.slice(batch.calls.indexOf(tc));
          for (const rem of remaining) {
            turnToolResults.push({
              toolCallId: rem.id,
              name: rem.name,
              content: 'Cancelled by user (agent stopped).',
              isError: true,
            });
          }
          stoppedMidBatch = true;
          break outer;
        }
        const r = await runOne(tc);
        turnToolResults.push(r);
      }
    }
  }
  state = sc.state;
  recentSigs = sc.recentSigs;
  calledCompleteTask = sc.calledCompleteTask;
  calledFireAndForgetGen = sc.calledFireAndForgetGen;

  // Update state with new signatures + results
  state = advance(state, {
    recentToolSignatures: recentSigs,
    toolResults: state.toolResults.concat(turnToolResults),
  });

  persistXmlFallbackCollapse(ctx, turnToolResults);

  clearErrors(agentId);

  if (stoppedMidBatch) {
    setAgentStatus(agentId, 'idle');
    return requestExit(state, 'stopped-mid-batch') as ExecuteOutcome;
  }

  state = countTrackerWorkThisIteration(state, ctx);
  state = await runTrackerFloors(state, ctx);

  // ── complete_task / fire-and-forget generator exit conditions (Part XIX) ──
  if (calledCompleteTask) {
    logger.info('v2: complete_task called, exiting loop', { agentId }, agentId);
    return requestExit(state, 'complete-task-called') as ExecuteOutcome;
  }
  if (calledFireAndForgetGen) {
    logger.info('v2: fire-and-forget generator called, exiting loop (async delivery)', { agentId }, agentId);
    return requestExit(state, 'fire-and-forget-generator-called') as ExecuteOutcome;
  }
  // ── A2A turn: the send_to_agent IS the response, end the turn once it
  // fires. Without this, a weak model can loop calling send_to_agent on an
  // inter-agent turn; the thrash gate's "respond with TEXT" escape doesn't
  // help because A2A-turn text is suppressed, so the turn would never
  // terminate (observed: 12 send_to_agent calls ignoring 9 STOP messages,
  // and runaway turns that thrash send_to_agent then wander into file work
  // and deliver attachments to the OWNER). The reply is already delivered +
  // recorded; there is nothing else to do.
  //
  // Read THIS iteration's actual tool calls, not state.sentToAgentThisTurn:
  // that flag is set via `state = advance(...)` inside the parallel
  // `runOne` callbacks (Promise.all), where concurrent reassignments clobber
  // each other, so it can silently fail to stick and the turn runs away.
  // result.toolCalls is deterministic.
  const issuedA2AReplyThisIteration = (result.toolCalls ?? []).some(
    (tc) => tc.name === 'send_to_agent' || tc.name === 'broadcast_to_group',
  );
  if (counterparty.kind === 'agent' && (state.sentToAgentThisTurn || issuedA2AReplyThisIteration)) {
    logger.info('v2: A2A reply sent, exiting loop (send_to_agent is the response)', { agentId }, agentId);
    return requestExit(state, 'a2a-reply-sent') as ExecuteOutcome;
  }

  const delegation = runDelegationTurnEnd(state, ctx);
  state = delegation.state;
  if (delegation.directive !== 'proceed') return delegation as ExecuteOutcome;

  return { ...proceed(state), turnToolResults } as ExecuteOutcome;
}
