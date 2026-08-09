// ════════════════════════════════════════
// SWEEP CORE-2 item 7 — DRAFTS ARE NOT ANSWERS: the turn boundary's last honest statement
// about what the person was just shown.
//
// ── THE IRRITATION, AND WHY IT IS A DIAGNOSIS PROBLEM AND NOT A TASTE ONE ──
// Every time the agent thinks out loud, its drafting arrives on the owner's screen as
// repeated ANSWER-SHAPED boxes, which the dashboard then collapses — and on screen that is
// indistinguishable from the re-serve defect (the platform answering the same ask twice).
// One is normal; the other is a bug the owner has to chase. Made to look the same, both are
// unreadable.
//
// The ruling used to be live-with-it. It is superseded BY CAPABILITY, not by preference:
// CORE-1 CT0 landed `turns.answer_message_id` — a truthful record, written by ONE setter
// (`noteTerminalAnswer`), of WHICH message answered. With that column in existence the
// platform can say which box was the answer without reading a single word of any box.
//
// ── THE ONE FACT THE DESIGN IS SHAPED BY ──
// **THE ANSWER'S IDENTITY IS ONLY KNOWN AT TURN END.** Mid-turn nobody can know whether a
// tool-less line is the reply or a draft, because the floors in `post-call-classify/
// no-tool-calls.ts` that grant another round have not run yet. So:
//   · the bubbles STREAM exactly as they always did — nothing is withheld pending a verdict,
//     nothing is delayed, nothing is suppressed, and the model's phrasing is never touched
//     (the Phase-0 ruling: the engine does not enforce wording);
//   · at the boundary, the ones the LEDGER does not name are RE-CLASSIFIED into the
//     working-note lane, row and broadcast TOGETHER.
// A re-classification is an announced event, never a silent row edit: the wire and the table
// change in the same breath, which is what keeps the live view and a reload agreeing.
//
// ── WHAT THIS IS NOT ──
// It is not a second demotion mechanism. `post-call-classify/terminal-text.ts` demotes
// narration that rides in the SAME model response as a tool call and has since 2026-07-10;
// this is the same rule reaching the same text when it happens to arrive in its own tool-less
// iteration. It is not a grind detector either — a draft SPIRAL that never terminates is
// TB8's class and is already caught; this is about honest presentation of the ones that do
// terminate.
//
// ── MEASURED BEFORE ANY OF IT WAS WRITTEN (Step 0, read-only over a `VACUUM INTO` copy of
// the live body at `92447af`) ──
//   3,543 turns produced an answer-shaped bubble; 535 (15.1%) produced two or three.
//   531 of those 535 carry the key, and in 674 of 675 stamped multi-bubble turns the key
//   names the LAST text row. 502 of the 546 extra bubbles are followed by more tool work in
//   the same turn and average 38 characters.
// ⚠ THE BOUNDARY, RECORDED RATHER THAN ARGUED AWAY: 3 turns of 535 (0.56%) have a stamped
// answer SHORTER than an earlier bubble — all three harness fixtures, none an owner-facing
// multi-part answer. In those the earlier bubble becomes a note. Nothing is lost (the note
// keeps every byte and is on screen, one click from open), but the shape is named in the
// task report so the owner can rule on multi-part semantics if he ever wants to.
// ════════════════════════════════════════

import { broadcast } from '../../../../gateway/ws.js';
import { getDb } from '../../../../db/connection.js';
import { createLogger } from '../../../../logger.js';
import { reclassifyDraftsAsWorkingNotes } from '../../../../memory/message-store.js';

const logger = createLogger('v2-loop');

export interface DraftReclassification {
  /** The ledger's verdict for this turn. `null` means the turn recorded no answer. */
  answerMessageId: string | null;
  /** The rows moved into the working-note lane, in the order they were said. */
  reclassified: Array<{ id: string; content: string }>;
}

/**
 * Re-classify this turn's non-answer bubbles as working notes, and announce each one.
 *
 * FAILS CLOSED. The discriminator is `turns.answer_message_id`; a turn that recorded no
 * answer has nothing to compare against, so it re-classifies nothing and says nothing. That
 * is deliberate and is driven by its own clause: a turn where the platform never decided
 * which bubble answered is a turn where this module must not decide for it.
 */
export function reclassifyTurnDrafts(
  p: { agentId: string; turnNumber: number },
): DraftReclassification {
  const { agentId, turnNumber } = p;
  const key = getDb().prepare(
    'SELECT answer_message_id FROM turns WHERE agent_id = ? AND turn_number = ?',
  ).get(agentId, turnNumber) as { answer_message_id: string | null } | undefined;
  const answerMessageId = key?.answer_message_id ?? null;
  if (answerMessageId == null) return { answerMessageId: null, reclassified: [] };

  const reclassified = reclassifyDraftsAsWorkingNotes({ agentId, turnNumber, answerMessageId });
  for (const row of reclassified) {
    // ONE row, TWO names on the wire on purpose. The pre-existing demotion path writes a NEW
    // system row and so carries two different ids (`messageId` = the bubble to convert,
    // `noteId` = the row it becomes). A RE-CLASSIFICATION converts the row that is already
    // there, so both ids are that row's id — and `reclassified: true` says which of the two
    // shapes this is, structurally, rather than making the client infer it from an id
    // comparison it would have to keep in step with this file.
    broadcast({
      type: 'chat:workingnote',
      agentId,
      messageId: row.id,
      noteId: row.id,
      content: row.content,
      reclassified: true,
    });
  }
  if (reclassified.length > 0) {
    logger.info('v2: the turn ended and its drafting was re-classified as working notes — the ledger named a different bubble as the answer', {
      agentId, turnNumber, answerMessageId,
      reclassified: reclassified.map((r) => r.id),
    }, agentId);
  }
  return { answerMessageId, reclassified };
}
