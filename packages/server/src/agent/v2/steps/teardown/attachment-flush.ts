
import type { Message } from '@dojo/shared';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { broadcast } from '../../../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { dojoVoice, tellAgentFilesPostedByDojo } from '../../../dojo-voice.js';
import { turnParkedTheJob } from '../../engine-exit.js';
import type { TeardownContext } from './index.js';

const logger = createLogger('v2-loop');

export async function flushStrandedAttachments(ctx: TeardownContext): Promise<void> {
  const { agentId, turnNumber, chosenConversationId, counterparty } = ctx;

  // Runs on every exit path: a throw skips the in-turn drains, and queued show_to_user files must not
  // ride a later, unrelated reply. A park is not the job's end: files wait for the turn that ends it.
  // Leftovers post as a dashboard-only message in this turn's conversation; no iMessage/voice re-push,
  // since the channel context may be half-resolved and a send is not idempotent.
  if (turnParkedTheJob(agentId)) return;
  try {
    const { drainPendingAttachmentsWithCaptions } = await import('../../../pending-attachments.js');
    const leftover = drainPendingAttachmentsWithCaptions(agentId);
    if (leftover.attachments.length > 0 && counterparty.kind !== 'agent') {
      const engineCaption = leftover.captions.length === 0;   // no caption from the agent: the Dojo speaks, labelled
      const caption = engineCaption
        ? dojoVoice('the agent prepared these files, but its turn ended early.')
        : leftover.captions.join('\n\n');
      const leftoverId = uuidv4();
      const posted = insertMessageIfAbsent({
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
      if (posted && engineCaption) tellAgentFilesPostedByDojo(agentId, leftover.attachments, caption);   // told only once the row exists
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
