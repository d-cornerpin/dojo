// End-of-turn safety net for files queued by `show_to_user` with no terminal text after them.
// It runs after the channel router, so it sends files to an iMessage requester itself.

import { v4 as uuidv4 } from 'uuid';
import type { Message } from '@dojo/shared';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { advance, type AgentTurnState } from '../../state.js';
import { turnParkedTheJob } from '../../engine-exit.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/** Returns the state it advanced (surfaced files become the turn's reply text). */
export async function surfaceStrandedAttachments(
  state: AgentTurnState,
  ctx: FinalizeContext,
): Promise<AgentTurnState> {
  const { agentId, turnNumber, counterparty, broadcast, noteTerminalAnswer } = ctx;
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
      // Setting the reply text here would never route (the router already ran), so send the files
      // directly to an iMessage requester, caption on the first.
      if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
        try {
          // This outbound arm bypasses `channel-push.ts`, but it leaves the box, so it takes the same scrub.
          const { redactHandedCredentials } = await import('../../../../credentials/secret-fields.js');
          const captionOut = redactHandedCredentials(agentId, captionText);
          // The helper also tells the agent (so its reply does not claim the file arrived).
          const { textFilesToRequester } = await import('../text-files-to-requester.js');
          await textFilesToRequester(agentId, counterparty.senderId, stranded.attachments as Array<{ path?: string; filename?: string }>, captionOut);
        } catch (err) {
          logger.warn('A-1/A-2: stranded-file iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
        }
        // On failure textFilesToRequester tells the agent, which tells the person; the platform does not.
      }
      state = advance(state, { lastAssistantTextForIM: captionText });
      noteTerminalAnswer(synthId, 'stranded files surfaced');
    }
  } catch (err) {
    logger.warn('show_to_user safety net failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  return state;
}
