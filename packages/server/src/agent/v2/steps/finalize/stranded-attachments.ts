// End-of-turn safety net for files queued by `show_to_user` with no terminal text after them.
// It runs before the channel router: the files join the turn's reply, and only a turn with no reply takes their caption.

import { v4 as uuidv4 } from 'uuid';
import type { Message } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { advance, type AgentTurnState } from '../../state.js';
import { turnParkedTheJob } from '../../engine-exit.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/** Returns the state it advanced (the caption joins the reply text, or is the reply when there is none). */
export async function surfaceStrandedAttachments(
  state: AgentTurnState,
  ctx: FinalizeContext,
): Promise<AgentTurnState> {
  const { agentId, turnNumber, turnCtx, counterparty, broadcast, noteTerminalAnswer } = ctx;
  if (turnParkedTheJob(agentId)) return state;   // a park is not the job's end; files ride the final reply

  // Surface still-queued attachments as a final assistant message so they reach the user.
  try {
    const { drainPendingAttachmentsWithCaptions } = await import('../../../pending-attachments.js');
    const stranded = drainPendingAttachmentsWithCaptions(agentId);
    // delivered_at on the artifact row is the once-only guarantee; a regenerated file is a new artifact.
    if (stranded.attachments.length > 0 && counterparty.kind !== 'agent') {
      // Caption: only the model's own words; with none the file goes out bare and the agent is told.
      const captionText = stranded.captions.length > 0
        ? stranded.captions.join('\n\n')
        : '';
      const synthId = uuidv4();
      insertMessageIfAbsent({
        id: synthId, agentId, role: 'assistant', content: captionText,
        attachments: JSON.stringify(stranded.attachments), turnNumber,
      });
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: synthId,
          agentId,
          role: 'assistant' as Message['role'],
          content: captionText,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
          attachments: stranded.attachments,
        },
      });
      if (stranded.captions.length === 0) {
        try {
          const { postAgentNotice } = await import('../../../agent-notice.js');
          postAgentNotice({
            toAgentId: agentId, fromName: 'File delivery', intent: 'file_delivery_outcome', selfIntro: false,
            brief: `your file(s) ${stranded.attachments.map((a: { filename?: string }) => a.filename ?? 'file').join(', ')} were delivered to the person with no caption: the Dojo wrote no words around them. If you want to say something about them, say it in your own words.`,
          });
        } catch { /* awareness note is best-effort */ }
      }
      logger.warn('show_to_user safety net fired - surfaced stranded attachments', {
        agentId,
        fileCount: stranded.attachments.length,
        captionCount: stranded.captions.length,
      }, agentId);
      turnCtx.replyFiles.push(...stranded.attachments);
      const reply = state.lastAssistantTextForIM;
      if (!reply) {
        state = advance(state, { lastAssistantTextForIM: captionText });
        noteTerminalAnswer(synthId, 'stranded files surfaced');
      } else if (captionText) {
        state = advance(state, { lastAssistantTextForIM: `${reply.trimEnd()}\n\n${captionText}` });
      }
    }
  } catch (err) {
    logger.warn('show_to_user safety net failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  return state;
}
