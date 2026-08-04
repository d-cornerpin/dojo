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

import { createLogger } from '../../../../logger.js';
import { tagTurnOutputConversationId } from '../../../../memory/message-store.js';
import { claimAssembledSiblings } from '../../counterparty.js';
import type { TeardownContext } from './index.js';

const logger = createLogger('v2-loop');

export function tagTurnOutputs(ctx: TeardownContext): void {
  const { agentId, turnNumber, chosenConvKey, chosenConversationId, lastAssembledAtIso, db } = ctx;

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
    // F9: claim same-conversation sibling user rows that were inside this
    // turn's final assembled context (they got answered by this reply); a
    // burst's second message no longer earns a duplicate answer. Human
    // conversations only, never the engine sentinel. (PHASE-2 T4: the park/relayed sentinel
    // tests that stood beside it are gone with the namespace — a chosen conv key could only
    // ever be a real conversation or 'engine', and nothing writes a join into this column.)
    // PHASE-2 T10I: the `chosenConvKey !== 'engine'` guard is GONE and it is not a
    // widening. It excluded the engine SENTINEL — a fake conversation key — from a claim
    // that only ever applies to a human conversation's sibling rows. `chosenConversationId`
    // cannot be a sentinel: an events-lane rider has no conversation, so an engine turn
    // reaches here with null and the condition below excludes it structurally instead of
    // by name. (Asserted: the sentinel value can no longer be produced.)
    if (
      lastAssembledAtIso &&
      chosenConversationId
    ) {
      try {
        // Abort-safety: only claim siblings when this turn actually persisted
        // an ANSWER for this conversation. A no-answer abort must leave them
        // NULL so the drain re-serves them (never silently dropped).
        const answered = db.prepare(
          `SELECT 1 FROM messages WHERE agent_id = ? AND turn_number = ? AND role = 'assistant' AND conversation_id = ? LIMIT 1`,
        ).get(agentId, turnNumber, chosenConversationId);
        const claimed = answered ? claimAssembledSiblings(agentId, chosenConvKey, lastAssembledAtIso, turnNumber) : 0;
        if (claimed > 0) {
          logger.info('F9 batch-claim: claimed sibling rows answered by this turn', { agentId, convKey: chosenConvKey, claimed }, agentId);
        }
      } catch { /* best effort, turn teardown must not throw */ }
    }
  }
}
