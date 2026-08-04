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
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/** Returns the state it advanced (surfaced files become the turn's reply text). */
export async function surfaceStrandedAttachments(
  state: AgentTurnState,
  ctx: FinalizeContext,
): Promise<AgentTurnState> {
  const { agentId, turnNumber, counterparty, broadcast, noteTerminalAnswer } = ctx;

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
      // Caption: prefer the model's own caption. Otherwise derive an INFORMATIVE
      // line from the deliverables themselves, never a content-free generic
      // "Here are the files for you.". Root reason: that generic line is identical
      // for every uncaptioned deliverable, so two distinct files (blog_migration_plan,
      // team_offsite_july_2026) surfaced on different turns read as duplicate spam in
      // the owner's chat (the owner's run-#9 report). Naming the file makes each surface
      // distinct and tells the owner WHAT it is. We are not hiding a duplicate; we are
      // making the message say what it always should have.
      const describeDeliverables = (atts: Array<{ filename?: string }>): string => {
        const names = atts
          .map(a => (a.filename ?? '').trim())
          .filter(Boolean)
          .map(fn => fn.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').trim())
          .filter(Boolean);
        if (names.length === 0) return 'Here you go.';
        if (names.length === 1) return `Here's the ${names[0]}.`;
        return `Here are the files:\n${names.map(n => `• ${n}`).join('\n')}`;
      };
      const captionText = stranded.captions.length > 0
        ? stranded.captions.join('\n\n')
        : describeDeliverables(stranded.attachments);
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
          const { sendIMessageWithAttachment } = await import('../../../../services/imessage-bridge.js');
          let first = true;
          for (const att of stranded.attachments as Array<{ path?: string }>) {
            if (att.path) { sendIMessageWithAttachment(counterparty.senderId, att.path, first ? captionText : ''); first = false; }
          }
        } catch (err) {
          logger.warn('A-1/A-2: stranded-file iMessage delivery failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
        }
      }
      if (stranded.attachments.length > 0) {
        state = advance(state, { lastAssistantTextForIM: captionText });
        noteTerminalAnswer(synthId, 'stranded files surfaced');
      }
    }
  } catch (err) {
    logger.warn('show_to_user safety net failed (non-fatal)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }

  return state;
}
