// ════════════════════════════════════════
// PHASE-6 T9b — teardown, part 1 of 3: THE CONVERSATION TAGGING.
//
// C15 + F9, relocated verbatim from `agent/v2/loop.ts` (`:9392`–`:9436` at
// `1cbe8bb`). Its own comments carry the two incidents it exists for; nothing
// in them was rewritten.
//
// It is a separate file from the entry point for one reason and it is the
// build's: the span is 348 lines and `maxNewFileLines` is 400, so a single
// file would have had to argue for an exception. RULING P6-R1 answers that in
// advance — a step is a DIRECTORY, entry ≤400, every file ≤400 — and the seams
// used here are the ones the block already had, not new ones.
// ════════════════════════════════════════

import { tagTurnOutputConversationId } from '../../../../memory/message-store.js';
import type { TeardownContext } from './index.js';

export function tagTurnOutputs(ctx: TeardownContext): void {
  const { agentId, turnNumber, chosenConvKey, chosenConversationId } = ctx;

  // C15: on EVERY exit path (clean reply, decline, MAX_TOOL_LOOPS, spinning/thrash
  // break, exception) tag THIS turn's own assistant/tool rows with the conversation's
  // conv_key. The clean reply/decline exits (~:2851/:5199) already stamp, but the
  // abort/break paths did not, leaving tool_use/tool_result rows conv_key NULL forever;
  // scopeToHumanConversation keeps untagged self rows as "in-progress work", so an
  // aborted turn's scratch (e.g. a contact's deep-research tool output) bled into the NEXT
  // person's live tail + conversation-scoped recall (inv 4). turn_number scopes it to
  // this turn's own rows only. Independent of C2/C4's TRIGGER revert (which nulls the
  // role='user' trigger row to re-serve the ask; this tags the role in ('assistant',
  // 'tool') rows so they don't leak), different roles, no conflict. On the clean path
  // the rows are already tagged, so `conv_key IS NULL` makes this a no-op. Best-effort.
  if (chosenConvKey) {
    try {
      if (chosenConversationId) tagTurnOutputConversationId({ agentId, turnNumber, conversationId: chosenConversationId });
    } catch { /* best effort, turn teardown must not throw */ }
  }
  // ── SWEEP-A TB1: THE F9 BATCH-CLAIM IS GONE FROM HERE, AND IT IS NOT A LOSS ──
  // This block used to move the same-conversation sibling asks `open -> claimed` (reason
  // "answered as a sibling inside this turn's assembled context") so the drain would not
  // re-serve a question the reply had already answered. It ran at teardown, which is AFTER
  // the send-time closer had already swept for this turn — so every row it claimed was left
  // `claimed` for ever, and the dedup patch became the fossil bug (36 stuck rows measured on
  // this box; reproduced 4/4 by the kit scenario `ask-burst-always-settles`).
  // requirement preserved: no ask is answered twice — now as a PROPERTY rather than a marker.
  // The set is read (`counterparty.ts:assembledContextAsks`), and `finalize-record.ts` hands
  // it to the settlement authority, which CLOSES each row against the delivery that answered
  // it and stamps `served_by_turn` in the same settlement. A closed ask is not in the waiting
  // set, so there is nothing to re-serve; and an ask with no delivery behind it goes back to
  // `open`, visible, instead of being marked served on a promise.
  // The abort-safety gate this block carried ("only claim when the turn persisted an ANSWER")
  // is preserved and strengthened: the authority's gate is the DELIVERY RECEIPT itself, so a
  // no-answer abort leaves every sibling servable.
}
