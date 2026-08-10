// ════════════════════════════════════════
// PHASE-6 T9 (CUT 4) — THE COMPLETION-ACK DETECTION
//
// Relocated verbatim from `agent/v2/loop.ts` (`:7914`–`:8024` at `0942fd9`). Bounds,
// wording, SQL and log lines unchanged.
//
// ⚠ A MEASURED FACT, RECORDED RATHER THAN FIXED (CUT 1's precedent for the two
// hardcoded classifier zeros). `engineCompletionAckThisTurn` is declared `false` and
// NOTHING ASSIGNS IT. Command: `git grep -nw engineCompletionAckThisTurn` over
// `packages/server/src` at `0942fd9` → 2 non-test hit lines, this declaration and the
// single READ in the settled-context root computation. Its writer was the
// engine-composed ack that owner ruling 2026-07-22 demoted to detection, and the
// demotion left the flag standing as a permanent `false` — so the "a real completion
// push is never held" carve-out it feeds cannot currently fire through THIS input.
// A relocation does not get to change behaviour, so it moves exactly as it is and the
// reader still receives it; the disposition (retire the input, or give a genuine
// completion its affirmative root some other way) belongs to whoever owns the
// outbound-root vocabulary. Handed up in this cut's report rather than decided here.
// ════════════════════════════════════════

import { createLogger } from '../../../../logger.js';
import { tsToMs, engineScaffoldScope } from '../../../../work/tracker-view.js';
import { owesAnswer, substantiveReplySince } from '../../answered-edge.js';
import { steerFired } from '../../steer-queue.js';
import type { AgentTurnState } from '../../state.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/** Returns `engineCompletionAckThisTurn` — see the header's measurement. */
export function runCompletionAck(state: AgentTurnState, ctx: FinalizeContext): boolean {
  const { agentId, turnNumber, db, counterparty, counterpartyIsAgentSender, turnStartedAt } = ctx;

  // ── COMPLETION ACK (NEXT-WAVE item 1, the hard part) ──
  // A turn that served a human request and finished ENGINE-scaffolded work MUST
  // tell the person it is done, before the turn can end on a background / A2A
  // obligation. This runs on EVERY exit path (natural end, [no-reply], the
  // delegation-send break, a gate/limit), so the owed human ack is delivered no
  // matter how the turn ended, the exact production gap (owner heard nothing on
  // a completed backup+reset because the floor model drifted into A2A). It is
  // engine-composed and delivered directly, so it holds on the floor model
  // regardless of what the model chose to emit.
  //
  // Dedup / prefer the model's own words: skip entirely if the model already
  // produced a user-facing reply this turn (lastAssistantTextForIM set, or a
  // reply surfaced). Scope: user counterparty only (A2A-turn completions are
  // owned by the close-the-loop report below), and ONLY engine-scaffolded
  // (root_kind='engine_scaffold') tasks that completed THIS turn, so a plain reply, a
  // trivial task, or a model-authored completion never triggers a canned line.
  // [no-reply] is not a valid resolution here: if the model went silent on a
  // completed user-requested task, the engine speaks for it.
  //
  // Same channel-delivery blindness as the F10 start-ack: a turn that
  // delivered its "done" through a channel send TOOL leaves no assistant text
  // row (lastAssistantTextForIM / surfacedReplyThisTurn both stay unset), so
  // without the explicitSendThisTurn guard the engine would compose a second,
  // duplicate completion line on top of the model's own send. A genuine
  // silent drift-to-A2A sets none of these (send_to_agent is not a channel
  // send), so the engine still speaks there.
  // Set when THIS turn composed an engine "done" ack for just-finished scaffolded
  // work. The settled-context hold at the route site reads it to NEVER withhold a
  // genuine completion push (always-acknowledge-user-work is a hard rule): a real
  // deliverable must still reach an away owner's phone even on a background wake.
  let engineCompletionAckThisTurn = false;
  if (
    counterparty.kind === 'user' &&
    !counterpartyIsAgentSender && // RC-4.2: no engine completion-ack to an agent-flagged sender
    !state.lastAssistantTextForIM &&
    !state.surfacedReplyThisTurn &&
    !Object.values(state.explicitSendThisTurn).some(Boolean)
  ) {
    try {
      // T8c item 3: the marker is the row's own `root_kind`. The old form matched a
      // prose prefix on the task's PARENT PROJECT and therefore needed an inner join —
      // which also meant a scaffold row with no parent could never be found. The floor
      // opens a parentless task now, so the join goes with the prefix.
      // UX-REPAIR T15 — THE BOUND IS ms, BECAUSE THE COLUMN IS. `closed_at` is INTEGER epoch
      // ms and this bound used to be the TEXT `turnStartedAt`; in SQLite every INTEGER sorts
      // below every TEXT, so the comparison was false for every row that has ever existed and
      // this whole detection — all three arms below are gated on `justCompletedScaffold` being
      // non-empty — never ran once. `opened_at` comes back as ms for the same reason: the
      // boundary it feeds is `substantiveReplySince`, which is ms-native, so nothing on this
      // path converts an instant to text and back. The siblings that already did it this way
      // are `close-the-loop.ts` and `silent-closeout.ts`, both `tsToMs(turnStartedAt)`.
      const turnStartedAtMs = tsToMs(turnStartedAt) ?? Date.now();
      const justCompletedScaffold = db.prepare(`
        SELECT t.title AS title, t.result AS result, t.opened_at AS opened_at_ms,
               t.source_message_id AS source_message_id FROM work t
        WHERE ${engineScaffoldScope('t')} AND t.kind = 'task' AND t.agent_id = ?
          AND t.state = 'done'
          AND t.closed_at >= ?
          AND t.repeat_interval IS NULL
        ORDER BY t.closed_at ASC
        LIMIT 3
      `).all(agentId, turnStartedAtMs) as Array<{ title: string; result: string | null; opened_at_ms: number }>;
      // CROSS-TURN DEDUP: the per-turn dedup on the outer gate
      // (lastAssistantTextForIM / surfacedReplyThisTurn) misses the common case
      // where the model DELIVERED the real answer on an earlier turn and the
      // scaffolded task only reached 'complete' on a later, silent continuation
      // turn (e.g. the turn continued past a tracker nudge). That produced a
      // redundant "Done, I finished..." AFTER the user already had the answer.
      // Suppress the ack when the user has ALREADY received a substantive,
      // model-authored reply for this work since the earliest just-completed task
      // was created. Exclude the engine's own start/completion ack lines and the
      // tool_use/tool_result JSON rows so only a genuine model answer counts. The
      // genuine silent case (did the work, never told the user, drifted to A2A)
      // has no such reply, so the ack still fires there.
      // Same selection as before, in ms: the EARLIEST of the just-completed scaffolds' open
      // instants, and `turnStartedAt` only when there are none. (The old form sorted the text
      // form lexicographically, which for `YYYY-MM-DD HH:MM:SS` is the same order.)
      const earliestTaskOpenedAtMs = justCompletedScaffold
        .map((t) => t.opened_at_ms)
        .filter((n): n is number => Number.isFinite(n))
        .sort((a, b) => a - b)[0] ?? turnStartedAtMs;
      // P4b keyed read: if every just-completed scaffold's birthing ask
      // already records an answering reply (answer_message_id, mig 113),
      // the user has the answer and the ack is redundant, by identity.
      const rootIds = justCompletedScaffold
        .map((t) => (t as unknown as { source_message_id?: string | null }).source_message_id)
        .filter((x): x is string => !!x);
      // PHASE-2 T6 (C5): the same ONE reader the owe-filter uses, so "the user already
      // has this" cannot mean two different things in two places in this file.
      const answeredByKey = rootIds.length === justCompletedScaffold.length && rootIds.length > 0
        && rootIds.every((mid) => !owesAnswer(mid));
      // T15: the pre-spine probe is `answered-edge.ts`'s, shared byte for byte with the
      // sibling in `execute/result-notes.ts`. Engine acks are still excluded STRUCTURALLY by
      // their origin_intent tag — that exclusion now lives in the one predicate.
      const userAlreadyAnswered = answeredByKey
        || (justCompletedScaffold.length > 0 && substantiveReplySince(agentId, earliestTaskOpenedAtMs));
      if (justCompletedScaffold.length > 0 && userAlreadyAnswered) {
        logger.info('v2: completion ack skipped, user already received a substantive reply for this work (cross-turn dedup)', {
          agentId, turnNumber,
        }, agentId);
      } else if (justCompletedScaffold.length > 0) {
        // Owner ruling 2026-07-22: the engine never speaks as the agent. The
        // engine-composed ack that lived here (composeCompletionAck + insert +
        // away-channel handoff) is demoted to detection: reaching this arm
        // means the in-loop silent-closeout steer was ghosted or bypassed
        // (error-ended turn). Log loudly; the ticket stamps + the PM ladder
        // drive the agent to say it in its own voice on the next pass.
        logger.warn('v2: scaffolded work completed with NO user-facing reply and the closeout steer did not produce one; engine does not speak for the agent, ladder owns the follow-up', {
          agentId, turnNumber, taskCount: justCompletedScaffold.length,
          steered: steerFired(state.steerQueue, 'silent-closeout'),
        }, agentId);
      }
    } catch (err) {
      logger.warn('v2: completion-ack composition failed (non-fatal)', {
        agentId, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }

  return engineCompletionAckThisTurn;
}
