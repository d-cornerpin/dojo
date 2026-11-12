// The executor stops waiting when the owner presses Stop: each call in `run-one.ts` races the stop
// (`stop-waiters.ts`), and a cut call's slot reads CANCELLED_BY_STOP. Not a timeout: no tool run is bounded.
// The tool's own cancel handles the action. This file never applies an abandoned call's late result;
// its slot says an action may already have happened, and the owner is told the real outcome when it settles.

import { classifyTool, type ToolCall } from '@dojo/shared';
import { untilUserStop } from '../../../stop-waiters.js';
import { broadcast } from '../../../../gateway/ws.js';
import { createLogger } from '../../../../logger.js';
import { toolResultOf, type ToolOutcome } from '../../../tool-outcome.js';
import { outboundChannelForTool } from '../../outbound.js';
import type { PendingToolResult } from './index.js';

const logger = createLogger('v2-loop');

/** The slot text for a call the owner's stop cut. Shared with the executor's not-started arm. */
export const CANCELLED_BY_STOP = 'Cancelled by user (agent stopped).';

const MAY_HAVE_ACTED =
  ' It was already running when the stop came, so what it does may already have happened.' +
  ' Check before doing it again.';

export type StopRace =
  | { readonly stopped: false; readonly outcome: ToolOutcome }
  | { readonly stopped: true; readonly result: PendingToolResult };

/** Run one tool call unless the owner stops it: a standing stop never starts it; a stop that lands
 *  while it runs ends the wait now and abandons the call. */
export async function runUnlessStopped(
  agentId: string, tc: ToolCall, start: () => Promise<ToolOutcome>,
): Promise<StopRace> {
  const wait = untilUserStop(agentId);
  if (wait.already) return { stopped: true, result: cancelled(agentId, tc, CANCELLED_BY_STOP) };
  const work = start();
  let winner: { outcome: ToolOutcome } | 'stop';
  try {
    winner = await Promise.race([work.then((outcome) => ({ outcome })), wait.stopped.then(() => 'stop' as const)]);
  } finally {
    wait.dispose();
  }
  if (winner !== 'stop') return { stopped: false, outcome: winner.outcome };

  const acted = classifyTool(tc.name, tc.arguments as Record<string, unknown> | undefined) !== 'retrieval';
  logger.info('v2: owner stop ended the wait on a running tool call', { tool: tc.name }, agentId);
  followAbandoned(agentId, tc, work);
  return { stopped: true, result: cancelled(agentId, tc, CANCELLED_BY_STOP + (acted ? MAY_HAVE_ACTED : '')) };
}

function cancelled(agentId: string, tc: ToolCall, content: string): PendingToolResult {
  // The dashboard's card for this call is closed now, not left spinning on a call nobody awaits.
  try { broadcast({ type: 'chat:tool_result', agentId, tool: tc.name, result: content }); } catch { /* best effort */ }
  return { toolCallId: tc.id, name: tc.name, content, isError: true };
}

/** What the owner calls each send channel, and what a finished one has been. */
const CHANNEL_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  email: ['email', 'sent'], teams: ['Teams message', 'sent'], sms: ['text message', 'sent'],
  imessage: ['iMessage', 'sent'], phone: ['call', 'placed'],
};

/** The abandoned call keeps its own life; its result is read here only. An action (send, write,
 *  command) is reported to the owner when it lands; a read is only logged. */
function followAbandoned(agentId: string, tc: ToolCall, work: Promise<ToolOutcome>): void {
  const isAction = classifyTool(tc.name, tc.arguments as Record<string, unknown> | undefined) === 'effectful-action';
  work.then(
    (outcome) => {
      const r = toolResultOf(outcome);
      logger.info('v2: a call abandoned by the owner\'s stop settled', { tool: tc.name, isError: r.isError === true }, agentId);
      if (isAction) tellOwner(agentId, ownerWords(tc.name, r.isError !== true));
    },
    (err: unknown) => {
      logger.info('v2: a call abandoned by the owner\'s stop threw', {
        tool: tc.name, error: err instanceof Error ? err.message : String(err),
      }, agentId);
      if (isAction) tellOwner(agentId, ownerWords(tc.name, false));
    },
  );
}

/** The plain sentence. A send names what it was; any other action names the tool. */
function ownerWords(tool: string, completed: boolean): string {
  const channel = outboundChannelForTool(tool);
  const words = channel === null ? null : CHANNEL_WORDS[channel] ?? ['message', 'sent'];
  if (words !== null) {
    const [noun, done] = words;
    return completed
      ? `After you pressed Stop: the ${noun} had already been ${done}, and it cannot be called back.`
      : `After you pressed Stop: the ${noun} was cut off while it was being ${done}. Dojo could not confirm it went out, so check before trying again.`;
  }
  return completed
    ? `After you pressed Stop: ${tool} had already finished, so what it did stands.`
    : `After you pressed Stop: ${tool} was cut off and did not finish.`;
}

function tellOwner(agentId: string, words: string): void {
  try { broadcast({ type: 'chat:error', cardClass: 'informational', agentId, error: words, severity: 'warning', retryable: false }); } catch { /* best effort */ }
}
