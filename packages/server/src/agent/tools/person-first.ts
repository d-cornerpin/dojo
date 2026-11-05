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
// ════════════════════════════════════════════════════════════════════════════
import { getDb } from '../../db/connection.js';
import { onArrivalWhileBusy } from '../shared-state.js';
import type { PersonFirst } from './process-run.js';

/** Has a person's message for `agentId` arrived after `sinceMs`? The one waiting-set definition. */
export async function personArrivedSince(agentId: string, sinceMs: number): Promise<boolean> {
  const { getWaitingHumanConversations } = await import('../v2/counterparty.js');
  const ids = getWaitingHumanConversations(agentId).map((c) => c.latest.id);
  if (ids.length === 0) return false;
  const row = getDb().prepare(`SELECT MAX(created_at) AS at FROM messages WHERE id IN (${ids.map(() => '?').join(', ')})`)
    .get(...ids) as { at: number | null } | undefined;
  return (row?.at ?? 0) > sinceMs;
}

/** The exec door's person-first wiring for one call by `agentId`, which runs `what`. */
export function personFirstFor(agentId: string, what: string): PersonFirst {
  return {
    watchFrom(startedAt) {
      let resolve: () => void = () => {};
      const arrived = new Promise<void>((r) => { resolve = r; });
      const off = onArrivalWhileBusy(agentId, () => {
        void personArrivedSince(agentId, startedAt).then((yes) => { if (yes) resolve(); }).catch(() => { /* keep waiting on the command */ });
      });
      return { arrived, cancel: off };
    },
    handedBack(pid, outcome) {
      void (async () => {
        const { handToBackground } = await import('../effects/proc-tree.js');
        const { recordHandOff, endHandOff } = await import('../background-commands.js');
        const { getTurnScopedImRecipient } = await import('../../services/imessage-bridge.js');
        const askedOnIMessage = getTurnScopedImRecipient(agentId);   // captured now: the turn that ran it is the one that asked
        if (pid !== undefined) {
          handToBackground(agentId, pid, what);
          recordHandOff({ agentId, pid, what, startedAt: Date.now() });
        }
        const text = await outcome;
        if (pid !== undefined) endHandOff(pid);
        const { tellAgentAndWake, requesterReachSentence } = await import('../wake-with-notice.js');
        const reach = askedOnIMessage ? await requesterReachSentence(askedOnIMessage) : 'If the person who asked is on the dashboard, your written reply reaches them.';
        await tellAgentAndWake({
          agentId, from: 'Dojo: background command', intent: 'background_command_done', inFailureTurn: false,
          brief: `The command you moved to the background${pid !== undefined ? ` (pid ${pid})` : ''}, ${what}, has ended. ${reach} Its result:\n${text}`,
        });
      })().catch(() => { /* the hand-over is best effort; the restart record still tells the agent if the Dojo goes down */ });
    },
  };
}
