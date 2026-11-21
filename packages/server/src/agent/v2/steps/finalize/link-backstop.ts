// Download-link backstop: file tools return the share URL only in the tool result, which the person
// never sees, so the engine adds any link the reply left out, from the turn's `turn_artifacts` rows.

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../../../../logger.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { advance, type AgentTurnState } from '../../state.js';
import type { FinalizeContext } from './index.js';

const logger = createLogger('v2-loop');

/**
 * Returns the advanced state. The caller has proven the reply text non-null; the throw below
 * re-asserts it once because `advance` widens the type back.
 */
export async function appendUndeliveredLinks(
  state: AgentTurnState,
  ctx: FinalizeContext,
): Promise<AgentTurnState> {
  const { agentId, turnNumber, broadcast } = ctx;

  {
    // Every omitted link rides the channel-routed text (a user on a text channel cannot see the canvas); the
    // dashboard bubble skips the file already on the canvas, which has its own download button.
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
    // Channel net: inert when the reply stays on the dashboard.
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
  if (state.lastAssistantTextForIM === null) {
    throw new Error('unreachable: lastAssistantTextForIM null after download-link backstop');
  }

  return state;
}
