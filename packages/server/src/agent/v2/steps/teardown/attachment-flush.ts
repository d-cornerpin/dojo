// ════════════════════════════════════════
// PHASE-6 T9b — teardown, part 3 of 3: THE STRANDED-ATTACHMENT NET.
//
// FA-TS4, relocated verbatim from `agent/v2/loop.ts` (`:9620`–`:9676` at
// `1cbe8bb`). The v2.9.20 requirement it holds — queued `show_to_user` files
// are never silently lost — and the deliberate refusal to re-push to
// iMessage/voice from a thrown turn are stated in the block's own comments and
// were not rewritten.
// ════════════════════════════════════════

import type { Message } from '@dojo/shared';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { broadcast } from '../../../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import type { TeardownContext } from './index.js';

const logger = createLogger('v2-loop');

export async function flushStrandedAttachments(ctx: TeardownContext): Promise<void> {
  const { agentId, turnNumber, chosenConversationId, counterparty } = ctx;

  // FA-TS4: pending-attachments teardown net. The three normal drain sites
  // (:~3187 no-reply, :~3365 text-bearing persist) and the end-of-turn safety
  // net (:~6064) all live INSIDE the main turn try, so a throw before terminal
  // routing (e.g. a model 429 mid-loop) skips every one of them and strands the
  // queued show_to_user files in the module-level per-agent buffer. Nothing
  // clears it, so on the NEXT turn (possibly a different conversation) those
  // files would drain onto an unrelated reply. Drain-and-flush here, on EVERY
  // exit path, scoped to THIS turn: surface the files to their own conversation
  // now, then clear so they can never carry forward.
  //
  // Idempotence vs the normal drains: every drain is a destructive read
  // (buffers.delete in pending-attachments.ts). On a clean turn the safety net
  // above already emptied the buffer, so this reads nothing and is a no-op.
  // Only an error/abort path (where that net was skipped) still has content
  // here, and this is then the SOLE drainer, so no double-surface is possible.
  //
  // Degraded delivery: a thrown turn has no clean reply row to ride on and the
  // channel router never ran, so we attach the files to a minimal assistant
  // message in this turn's OWN conversation (conv_key = chosenConvKey) on the
  // dashboard, using the model's show_to_user caption if it left one. We
  // deliberately do NOT re-push to iMessage/voice from teardown: on a thrown
  // turn the channel context may be half-resolved and a channel send is a
  // non-idempotent side effect we won't risk here. The v2.9.20 requirement
  // (queued files are never silently lost) is met via the dashboard surface
  // plus a loud warning.
  try {
    const { drainPendingAttachmentsWithCaptions } = await import('../../../pending-attachments.js');
    const leftover = drainPendingAttachmentsWithCaptions(agentId);
    if (leftover.attachments.length > 0 && counterparty.kind !== 'agent') {
      const caption = leftover.captions.length > 0
        ? leftover.captions.join('\n\n')
        : 'Here are the files I prepared (the turn ended early).';
      const leftoverId = uuidv4();
      insertMessageIfAbsent({
        id: leftoverId, agentId, role: 'assistant', content: caption,
        attachments: JSON.stringify(leftover.attachments), conversationId: chosenConversationId, turnNumber,
      });
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: leftoverId, agentId, role: 'assistant' as Message['role'],
          content: caption,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
          attachments: leftover.attachments,
        },
      });
      logger.warn('FA-TS4: flushed stranded show_to_user attachments in turn teardown', {
        agentId, fileCount: leftover.attachments.length, turnNumber,
      }, agentId);
    }
  } catch (err) {
    logger.warn('FA-TS4: teardown attachment flush failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}
