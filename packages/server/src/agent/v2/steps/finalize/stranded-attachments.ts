// ════════════════════════════════════════
// PHASE-6 T9 (CUT 4) — THE show_to_user END-OF-TURN SAFETY NET
//
// Relocated verbatim from `agent/v2/loop.ts` (`:8574`–`:8662` at `0942fd9`). Bounds,
// wording and log lines unchanged.
//
// The incident it exists for is named in its own comment (2026-06-06, JJ's report):
// the model queued attachments through `show_to_user` and then wrote no terminal text,
// so the files vanished. And the A-1/A-2 half is the one that is easy to lose in a
// move: this net runs AFTER the channel router above, so setting the reply text here
// would never route — the files are sent to an iMessage requester DIRECTLY, right
// here, or they reach the dashboard only.
// ════════════════════════════════════════

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
  if (turnParkedTheJob(agentId)) return state;   // t159 G: a park is not the job's end; its queued files ride the reply that is

  // v2.9.20, show_to_user end-of-turn safety net.
  //
  // If the turn ended with attachments still queued from
  // show_to_user calls (the model didn't write terminal text
  // after queuing - common failure mode that lost JJ's report on
  // 2026-06-06), surface them now as a final assistant message
  // so they reach the user instead of vanishing. Uses any caption
  // strings the model passed to show_to_user as the bubble text;
  // falls back to a generic "Here are the files for you." when
  // no caption was provided.
  try {
    const { drainPendingAttachmentsWithCaptions } = await import('../../../pending-attachments.js');
    const stranded = drainPendingAttachmentsWithCaptions(agentId);
    // P6b-2c: the per-session filename dedup died with the durable-rows
    // rekey. delivered_at on the artifact row IS the once-only guarantee; a
    // re-generated file in a later turn is a NEW artifact and legitimately
    // surfaces again (the old filename-history scan suppressed genuine
    // updated versions along with the spam it targeted).
    if (stranded.attachments.length > 0 && counterparty.kind !== 'agent') {
      // Caption: only the model's own words. The engine writes none (P12/R1): a surfaced file with no
      // caption goes out bare and the agent is told below so it can add its own words.
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
      // A-1/A-2 (comms-audit): this safety net runs AFTER the channel router above,
      // so setting lastAssistantTextForIM here would NEVER route, the stranded
      // deliverable files reached only the dashboard. If the requester is on
      // iMessage, send the FILES (with the caption on the first) to them directly so
      // a file they asked for actually reaches their channel, not just the dashboard.
      if (counterparty.kind === 'user' && counterparty.channel === 'imessage' && counterparty.senderId) {
        try {
          // Design ruling 13: this is the SIXTH outbound arm — the one that does not go
          // through `channel-push.ts`'s single derivation, because it runs after the
          // router and carries a caption rather than the reply. It leaves the box all the
          // same, so it takes the same scrub; leaving it out would make the guard's own
          // "one derivation for every arm" claim wider than the code.
          const { redactHandedCredentials } = await import('../../../../credentials/secret-fields.js');
          const captionOut = redactHandedCredentials(agentId, captionText);
          // The helper also tells the agent (so its reply does not claim the file arrived).
          const { textFilesToRequester } = await import('../text-files-to-requester.js');
          await textFilesToRequester(agentId, counterparty.senderId, stranded.attachments as Array<{ path?: string; filename?: string }>, captionOut);
        } catch (err) {
          logger.warn('A-1/A-2: stranded-file iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
        }
        // A file that did not reach the requester: the AGENT is told by textFilesToRequester and
        // tells the person itself. The platform does not message the owner (C2, R1/R2).
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
