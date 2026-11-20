// The `execute` step: run each batch of the model's tool calls through `run-one.ts` (gates, once-guard,
// repeat rule, executor, recording), then the tracker floors and the turn-ending checks.
// The driver advances into this phase itself, so `validate()` runs on the transition.

import type { ToolCall } from '@dojo/shared';
import type { ModelCallResult } from '../../../model.js';
import type { Database } from 'better-sqlite3';
import { clearErrors } from '../../../errors.js';
import { partitionTools } from '../../classifiers/concurrency.js';
import { advance, type AgentTurnState } from '../../state.js';
import { isStopFenced } from '../../../shared-state.js';
import type { TurnContext } from '../../../turn-context.js';
import type { TurnCounterparty } from '../../counterparty.js';
import { anyRepeatRefused } from '../../repeat-rule.js';
import { latchEngineCut } from '../../engine-exit.js';
import { createLogger } from '../../../../logger.js';
import { runOneToolCall } from './run-one.js';
import { effectsFor } from '../../../tools/index.js';   // already loaded by run-one above: no new edge
import { CANCELLED_BY_STOP } from './stop-race.js';
import { persistXmlFallbackCollapse } from './xml-fallback.js';
import { admitBatchToRoom } from './batch-admission.js';
import { countTrackerWorkThisIteration } from './tracker-counting.js';
import { runTrackerFloors } from './tracker-floors.js';
import { endAfterGenerator } from './media-words-step.js';
import { runDelegationTurnEnd } from './delegation-exit.js';
import { proceed, requestExit } from '../step-outcome.js';

const logger = createLogger('v2-loop');

/** The phase the driver advances INTO before calling this step. It never writes it. */
export const EXECUTE_PHASE = 'execute' as const;

/** The shape every tool result takes on its way back to the model. */
export interface PendingToolResult {
  toolCallId: string;
  name: string;
  content: string;
  isError: boolean;
  contentBlocks?: Array<{ type: string; [key: string]: unknown }>;
  keptWhole?: string;   // the whole result when `content` is its pointer; the recorder keeps it
}
export type TurnToolResult = PendingToolResult;

/** The provider's result shape, imported from the module that owns it so two shapes cannot drift. */
export type ExecuteModelResult = ModelCallResult;

/** Everything the step reads from the driver. */
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
  /** Both pass by value: their one write is in `postCallClassify`, before this step runs.
   *  `anyToolStartedThisTurn` lives on the turn bag instead because a timer callback reads it. */
  readonly engineStartAckDeliveredThisTurn: boolean;
  readonly deferredDeliveredByAck: boolean;
  readonly refusedOnceSigs: Set<string>;
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
  /** Passed in, not copied: declared at `loop.ts` module level and read outside this step too. */
  readonly staleTaskWindowMinutes: number;
  readonly engineStartAckAfterMs: number;
}

/** What the whole response shares across its calls: this step's own scratch, made and used in one run. */
export interface ExecuteScratch {
  state: AgentTurnState;
  readonly onceGuardExecuted: Map<string, string>;
  calledCompleteTask: boolean;
  calledFireAndForgetGen: boolean;
  /** send_to_agent / broadcast_to_group calls that reached the executor this response (refusals never count).
   *  A counter, not a `state` flag: the parallel `runOne` callbacks clobber each other's `state` writes. */
  a2aSendsExecuted: number;
}

/** The step's outcome; the proceed arm carries the tool results the driver hands to `postExecution`. */
export type ExecuteOutcome =
  | { readonly directive: 'proceed'; readonly state: AgentTurnState; readonly turnToolResults: TurnToolResult[] }
  | { readonly directive: 'continue'; readonly state: AgentTurnState }
  | { readonly directive: 'exit'; readonly state: AgentTurnState; readonly reason: string };

export async function runExecute(state: AgentTurnState, ctx: ExecuteContext): Promise<ExecuteOutcome> {
  const { agentId, result, counterparty } = ctx;

  const batches = partitionTools(result.toolCalls);
  const turnToolResults: PendingToolResult[] = [];

  let stoppedMidBatch = false;
  let calledCompleteTask = false;
  let calledFireAndForgetGen = false;
  // Once-per-response guard: a non-idempotent signature (generation, people send) runs at most once per
  // response; a repeat gets a note naming the first run. Repeats across responses belong to the repeat rule.
  const onceGuardExecuted = new Map<string, string>();

  const sc: ExecuteScratch = {
    state, onceGuardExecuted, calledCompleteTask, calledFireAndForgetGen,
    a2aSendsExecuted: 0,
  };
  const runOne = (tc: ToolCall): Promise<PendingToolResult> => runOneToolCall(tc, ctx, sc);

  outer: for (const batch of batches) {
    if (stoppedMidBatch) break;

    // Honour a stop between batches too: the batch in flight cannot be unsent, but the next comes back
    // Cancelled. Read the run's stop fence, not the raw flag, which reset-session can lift mid-run.
    if (isStopFenced(agentId)) {
      for (const rem of batch.calls) {
        turnToolResults.push({
          toolCallId: rem.id,
          name: rem.name,
          content: CANCELLED_BY_STOP,
          isError: true,
        });
      }
      stoppedMidBatch = true;
      break outer;
    }

    if (batch.category === 'safe') {
      const results = await Promise.all(batch.calls.map(runOne));
      turnToolResults.push(...results);
    } else {
      for (const tc of batch.calls) {
        // Read the fence, never clear it: the run's own exit path owns the clear (`shared-state.ts`).
        if (isStopFenced(agentId)) {
          // Cancel the remaining calls so every call the model made has a result.
          const remaining = batch.calls.slice(batch.calls.indexOf(tc));
          for (const rem of remaining) {
            turnToolResults.push({
              toolCallId: rem.id,
              name: rem.name,
              content: CANCELLED_BY_STOP,
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
  if (isStopFenced(agentId)) stoppedMidBatch = true; // a stop during the last batch, too
  // The response's results are admitted together against the turn's room before anything reads them.
  await admitBatchToRoom(ctx, turnToolResults);
  state = sc.state;
  calledCompleteTask = sc.calledCompleteTask;
  calledFireAndForgetGen = sc.calledFireAndForgetGen;

  // The repeat rule's refusals are read off its own ledger (parallel `runOne` callbacks clobber `state` writes).
  // A mid-batch stop latches engineCut 'stop' (first writer wins): the turn records the owner's stop.
  state = advance(state, {
    toolResults: state.toolResults.concat(turnToolResults.map((r) => ({
      ...r, arguments: result.toolCalls.find((tc) => tc.id === r.toolCallId)?.arguments,
    }))),
    repeatRefusedThisTurn:
      state.repeatRefusedThisTurn || anyRepeatRefused(agentId, ctx.turnCtx),
  });
  if (stoppedMidBatch) state = latchEngineCut(state, 'stop');

  persistXmlFallbackCollapse(ctx, turnToolResults);

  clearErrors(agentId);

  if (stoppedMidBatch) {
    // No idle write here: `settleStatus` in `teardown/index.ts` is the one owner of the status.
    return requestExit(state, 'stopped-mid-batch') as ExecuteOutcome;
  }

  state = countTrackerWorkThisIteration(state, ctx, turnToolResults, effectsFor);
  state = await runTrackerFloors(state, ctx);

  // complete_task and fire-and-forget generator exits.
  if (calledCompleteTask) {
    logger.info('v2: complete_task called, exiting loop', { agentId }, agentId);
    return requestExit(state, 'complete-task-called') as ExecuteOutcome;
  }
  const generatorExit = endAfterGenerator(state, ctx, calledFireAndForgetGen);
  if (generatorExit) return generatorExit as ExecuteOutcome;
  // On an A2A turn an executed send is the response, so the turn ends (its text is suppressed, so nothing
  // else would end it). Count executed sends from the scratch: a refused send must not end the turn, and
  // `state.sentToAgentThisTurn` can be clobbered by the parallel callbacks.
  if (counterparty.kind === 'agent' && sc.a2aSendsExecuted > 0) {
    logger.info('v2: A2A reply sent, exiting loop (send_to_agent is the response)', { agentId }, agentId);
    return requestExit(state, 'a2a-reply-sent') as ExecuteOutcome;
  }

  const delegation = runDelegationTurnEnd(state, ctx);
  state = delegation.state;
  if (delegation.directive !== 'proceed') return delegation as ExecuteOutcome;

  return { ...proceed(state), turnToolResults } as ExecuteOutcome;
}
