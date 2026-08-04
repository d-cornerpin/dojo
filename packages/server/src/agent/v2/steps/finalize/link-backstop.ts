// ════════════════════════════════════════
// PHASE-6 T9 (CUT 4) — THE FILE DOWNLOAD-LINK BACKSTOP (P6b-2)
//
// Relocated verbatim from `agent/v2/loop.ts` (`:8046`–`:8115` at `0942fd9`), the first
// thing the reply-destination resolver does. Bounds, wording and log lines unchanged.
//
// The requirement, in the block's own terms: `file_write` / `file_append` return the
// share URL only in the TOOL RESULT, which the person never sees, so an agent under
// load says "saved to your desktop" and the deliverable is never delivered. The engine
// guarantees the link instead — appended to the channel-routed text AND surfaced as
// its own dashboard bubble — from `turn_artifacts` ROWS the tools recorded at source.
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { advance, type AgentTurnState } from '../../state.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/**
 * Returns the state it advanced (the reply text may gain the links the agent left out).
 * THROWS the block's own `unreachable` assertion exactly where it did: the caller's
 * entry guard proves `lastAssistantTextForIM` non-null and the intervening `advance`
 * widens the type back, so the invariant is re-asserted once, in its original words.
 */
export async function appendUndeliveredLinks(
  state: AgentTurnState,
  ctx: FinalizeContext,
): Promise<AgentTurnState> {
  // ⚠ ONE MOVED LINE DIFFERS, and this is why. The caller's entry guard —
  // `if (isPrimaryAgent(agentId) && state.lastAssistantTextForIM)`, the resolver's own
  // first line — has already proven the reply text non-null. What the module boundary
  // loses is the NARROWING, not the guarantee, so `replyText`'s declaration below
  // carries a type assertion. A second runtime guard would be a second mechanism for
  // one invariant, and the block's own `unreachable` throw (kept verbatim, below) is
  // the one that exists to catch a real violation.
  const { agentId, turnNumber, broadcast } = ctx;

  // ── File download-link backstop (P6b-2: keyed rows) ──
  // file_write / file_append return the share URL ONLY in the tool
  // result, which the user never sees. Agents under load routinely
  // reply "saved to your desktop" and drop the link, so the deliverable
  // is never actually delivered. The engine guarantees it instead: any
  // download URL minted this turn that the agent left out of its
  // user-facing reply is (a) appended to the channel-routed text so it
  // rides along to iMessage/SMS/etc., and (b) surfaced in the dashboard
  // as its own assistant bubble. Model-independent, the link lands
  // whether or not the agent remembered it (correctness-floor rule).
  // The links are turn_artifacts rows recorded by the tools at the
  // source (they hold url + path as variables); the old prose regexes
  // over tool-result text are dead.
  {
    // A file shown in the canvas already has a download button right
    // there, so a user AT the dashboard doesn't need a follow-up link
    // bubble. But an AWAY user (reply routing to iMessage/SMS) can't see
    // the canvas, so the link must still ride along to the channel. Hence
    // the split: channel delivery covers every undelivered URL; the
    // dashboard link bubble is suppressed for the doc currently on canvas.
    const { getCurrentCanvas } = await import('../../../canvas-state.js');
    const { drainTurnLinkArtifacts } = await import('../../../pending-attachments.js');
    const currentCanvasPath = getCurrentCanvas(agentId)?.path ?? null;
    const replyText = state.lastAssistantTextForIM as string;
    const undeliveredForChannel: string[] = [];
    const undeliveredForDashboard: string[] = [];
    const seen = new Set<string>();
    for (const link of drainTurnLinkArtifacts(agentId, turnNumber)) {
      if (!link.url || seen.has(link.url)) continue;
      seen.add(link.url);
      if (replyText.includes(link.url)) continue; // the agent already shared it
      const shownInCanvas = !!link.path && !!currentCanvasPath && link.path === currentCanvasPath;
      undeliveredForChannel.push(link.url);
      if (!shownInCanvas) undeliveredForDashboard.push(link.url);
    }
    // Channel safety net: ensure links reach an away user via the routed
    // text (inert when the reply stays on the dashboard).
    if (undeliveredForChannel.length > 0) {
      const linkBlock = undeliveredForChannel.map(u => `Download: ${u}`).join('\n');
      state = advance(state, {
        lastAssistantTextForIM: `${replyText.trimEnd()}\n\n${linkBlock}`,
      });
    }
    // Dashboard link bubble: only for files NOT already on the canvas.
    if (undeliveredForDashboard.length > 0) {
      const linkBlock = undeliveredForDashboard.map(u => `Download: ${u}`).join('\n');
      const linkMsgId = uuidv4();
      insertMessageIfAbsent({ id: linkMsgId, agentId, role: 'assistant', content: linkBlock, turnNumber });
      broadcast({
        type: 'chat:message',
        agentId,
        message: {
          id: linkMsgId, agentId, role: 'assistant' as const,
          content: linkBlock,
          tokenCount: null, modelId: null, cost: null, latencyMs: null,
          createdAt: new Date().toISOString(),
        },
      });
      logger.info('delivered file download link(s) the reply omitted', {
        agentId, count: undeliveredForDashboard.length, turnNumber,
      }, agentId);
    }
  }
  // The entry guard guarantees lastAssistantTextForIM is non-null and the
  // backstop above only ever replaces it with a longer non-null string;
  // the intervening `state = advance(...)` widens the type back to
  // `string | null` for the compiler, so re-assert the invariant once.
  if (state.lastAssistantTextForIM === null) {
    throw new Error('unreachable: lastAssistantTextForIM null after download-link backstop');
  }

  return state;
}
