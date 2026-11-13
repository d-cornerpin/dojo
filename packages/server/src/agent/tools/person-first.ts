// "YOUR MESSAGES COME FIRST." A message ARRIVING while a command runs is answered first; an ask
// already open when the command began never interrupts it; after a hand-back the agent owns the job.
import { getDb } from '../../db/connection.js';
import { onArrivalWhileBusy } from '../shared-state.js';
import { personArrivedSince } from '../v2/counterparty.js';
import { handToBackground } from '../effects/proc-tree.js';
import { recordHandOff, settleHandOff, endHandOff } from '../background-commands.js';
import { getTurnScopedImRecipient } from '../../services/imessage-bridge.js';
import { tellAgentAndWake, requesterReachSentence } from '../wake-with-notice.js';
import type { PersonFirst } from './process-run.js';
import { getCurrentToolCallId } from '../turn-state.js';
import { exitStatusOf, NO_RESULT_FAILURE } from '../../work/command-status.js';
import { redactHandedCredentials } from '../../credentials/secret-values.js';

export function newestMessageSeq(): number {
  return (getDb().prepare('SELECT MAX(seq) AS s FROM messages').get() as { s: number | null } | undefined)?.s ?? 0;
}

/** The exec door's person-first wiring for one call by `agentId`, which runs `what`. */
export function personFirstFor(agentId: string, what: string): PersonFirst {
  return {
    watchFrom() {
      const sinceSeq = newestMessageSeq();
      let resolve: () => void = () => {};
      const arrived = new Promise<void>((r) => { resolve = r; });
      const off = onArrivalWhileBusy(agentId, () => {
        try { if (personArrivedSince(agentId, sinceSeq)) resolve(); } catch { /* keep waiting on the command */ }
      });
      return { arrived, cancel: off };
    },
    handedBack(pid, outcome) {
      // All of this happens before any await: nothing can reach the child before it is backgrounded.
      const askedOnIMessage = getTurnScopedImRecipient(agentId);
      // The row carries the call id, so the ledger writes "still running" and settles it by that id.
      const callId = getCurrentToolCallId(agentId);
      const backgrounded = pid !== undefined && handToBackground(agentId, pid, what);
      const recordId = backgrounded || callId
        ? recordHandOff({ agentId, pid: pid ?? 0, what, startedAt: Date.now(), callId })
        : null;
      void (async () => {
        const text = await outcome.catch(() => NO_RESULT_FAILURE);
        if (recordId) settleHandOff(recordId, redactHandedCredentials(agentId, exitStatusOf(text)));
        const reach = askedOnIMessage ? await requesterReachSentence(askedOnIMessage) : 'If the person who asked is on the dashboard, your written reply reaches them.';
        await tellAgentAndWake({
          agentId, from: 'Dojo: background command', intent: 'background_command_done', inFailureTurn: false,
          brief: `The command you moved to the background${pid !== undefined ? ` (pid ${pid})` : ''}, ${what}, has ended. ${reach} Its result:\n${text}`,
        });
        // Off the record only once the result is saved for the agent.
        if (recordId) endHandOff(recordId);
      })().catch(() => { /* the record stays, so a restart still tells the agent */ });
    },
  };
}
