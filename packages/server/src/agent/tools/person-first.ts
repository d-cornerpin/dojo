// ════════════════════════════════════════════════════════════════════════════
// "YOUR MESSAGES COME FIRST" (owner ruling, field fix 3 re-review 2; reworked in re-review 3).
//
// While a long command runs, a person's message that ARRIVES must still get answered. The exec door
// (`process-run.ts` runProcess) races the command against such an arrival; this module is what the
// race listens to and what owns the command once the call is handed back.
//
// - WHICH MESSAGE (re-review 3, T1): only one that arrives AFTER the command started. A turn claims one
//   ask at pickup, so the owner's second bubble, a follow-up, or any ask waiting while a PM or A2A turn
//   runs is already open when the turn chooses to run a command; those never hand it back. Without this,
//   every command (an `echo` included) went to the background and dependent steps ran out of order.
// - HOW IT IS HEARD (L2): the runtime's busy path, where every arrival during a run is parked, tells
//   its listeners (`shared-state.ts` onArrivalWhileBusy); the record is read once per arrival. No poll.
// - WHO OWNS IT AFTER (M2): the agent, as a background job (`effects/proc-tree.ts` handToBackground):
//   a later turn's failure does not end it, the owner's Stop does, and the agent has its pid. A
//   restart ends it, so it is written down until its result is handed over (`background-commands.ts`)
//   and the agent is told on its next turn when a restart cut it.
// - THE RESULT (L1): handed to the agent and waking it with an intent that names it
//   (`background_command_done`), with how to reach the person who asked when that was an iMessage.
// - RE-REVIEW 4: an arrival is a message row after the newest row at the start (N1, `seq`, not the
//   whole-second `created_at`); the record is a database row (migration 213), cleared after the
//   result is saved; the hand-off is done before anything is awaited.
// ════════════════════════════════════════════════════════════════════════════
import { getDb } from '../../db/connection.js';
import { onArrivalWhileBusy } from '../shared-state.js';
import { getWaitingHumanConversations } from '../v2/counterparty.js';
import { handToBackground } from '../effects/proc-tree.js';
import { recordHandOff, settleHandOff, endHandOff } from '../background-commands.js';
import { getTurnScopedImRecipient } from '../../services/imessage-bridge.js';
import { tellAgentAndWake, requesterReachSentence } from '../wake-with-notice.js';
import type { PersonFirst } from './process-run.js';
import { getCurrentToolCallId } from '../turn-state.js';
import { exitStatusOf, NO_RESULT_FAILURE } from '../../work/command-status.js';
import { redactHandedCredentials } from '../../credentials/secret-values.js';

/** The newest message row of the whole store: what "after the command started" is measured against. */
export function newestMessageSeq(): number {
  return (getDb().prepare('SELECT MAX(seq) AS s FROM messages').get() as { s: number | null } | undefined)?.s ?? 0;
}

/** Has a person's message for `agentId` arrived after the row `sinceSeq`? The one waiting-set definition.
 *  RE-REVIEW 4 (N1): this compared `messages.created_at` with the command's start in ms, but
 *  `created_at` is stored in whole seconds (`NOW_MS`), so a message in the same second as the start
 *  read as older and the command held the turn to its end. The row order (`seq`) has no such gap. */
export function personArrivedSince(agentId: string, sinceSeq: number): boolean {
  return getWaitingHumanConversations(agentId).some((c) => c.latest.rowid > sinceSeq);
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
      // Re-review 4 (LOW): all of this happens BEFORE anything is awaited, so no teardown can reach the
      // child between the hand-back and its move to the background, and the asker is the live turn's.
      const askedOnIMessage = getTurnScopedImRecipient(agentId);
      // Re-review 4 (N4) / 5 (P1): the hand-off's row carries the CALL that was handed back, so the task
      // ledger writes it "still running" and the row's own completion below settles it by call id.
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
        // Re-review 4 (LOW): off the record only once its result is saved for the agent.
        if (recordId) endHandOff(recordId);
      })().catch(() => { /* the record stays, so a restart still tells the agent */ });
    },
  };
}
