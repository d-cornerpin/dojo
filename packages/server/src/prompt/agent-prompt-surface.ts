// THE AGENT'S STORED IDENTITY, AS ONE SURFACE — UX-REPAIR post-.27 report 2 (T40).
//
// ── WHAT THE OWNER SAW ──
// His project manager's Settings card showed exactly one line where the system prompt goes:
// `[Agent ended turn without replying — conversation closed]`.
//
// ── WHY ──
// `GET /agents/:id/system-prompt`, `PUT /agents/:id`, `update_agent` and the agent-profile
// tool each ran their own copy of
//   `SELECT content FROM messages WHERE agent_id=? AND role='system' ORDER BY rowid ASC LIMIT 1`
// — the OLDEST system row. The PM's history is bounded to 30 rows by `prunePMMessages`, and
// `deleteForAgentBefore` deletes everything older INCLUDING system rows, while the engine
// writes `NO_REPLY_CLOSED_MARKER` as a `role='system'` row. So the oldest survivor on a
// worn-in box is an engine marker, and the card rendered it as the agent's soul.
//
// The runtime never read those rows: `sys.identity` renders `getSoulContent()`, and the
// message assembler's `tailRender` emits only user/assistant/tool rows, so a `role='system'`
// row cannot reach a model at all. Two stores, one of them invisible to the model, and the
// EDIT box wrote to the invisible one — typing a new prompt into the card changed nothing.
//
// ── THE RULE THIS MODULE IS ──
// The card reads and writes the SAME store the runtime reads. `prompt/assembler.ts` owns the
// resolution (`soulFileForAgent` / `readStoredCharter`); this module is the read/write door
// every surface goes through, so a fifth copy of that SELECT cannot appear.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { soulFileForAgent, readSoulFile, writeSoulFile, readStoredCharter } from './assembler.js';

const logger = createLogger('agent-prompt-surface');

/**
 * The agent's stored identity, as an editor should see it: the STORED bytes, before any
 * runtime truth pass. Never an engine marker — `readStoredCharter` refuses those.
 */
export function readAgentPromptSurface(agentId: string): string {
  const soul = soulFileForAgent(agentId);
  if (soul) {
    try {
      return readSoulFile(soul);
    } catch (err) {
      logger.warn('soul file unreadable; serving empty', {
        agentId, file: soul.file, error: err instanceof Error ? err.message : String(err),
      });
      return '';
    }
  }
  return readStoredCharter(agentId);
}

/**
 * Write the agent's stored identity to the store the RUNTIME reads.
 *
 * For a file-backed identity (primary / PM / trainer / a per-agent `<ID>-SOUL.md`) that is
 * the prompt file. For everyone else it is `agents.charter`, the durable column migration
 * 096 added for exactly this and the one `getSoulContent` reads.
 *
 * The legacy first-system-row rewrite is DELETED, not kept beside it. That statement wrote
 * whatever row happened to be oldest — and on a worn body that row is an ENGINE MARKER, so
 * "save your prompt" silently overwrote a `[Agent ended turn without replying…]` row with an
 * identity. A store the runtime does not read is not worth corrupting history to maintain,
 * and `readStoredCharter` prefers the column over the row on every read anyway.
 */
export function writeAgentPromptSurface(agentId: string, content: string): void {
  const soul = soulFileForAgent(agentId);
  if (soul) {
    writeSoulFile(soul, content);
    logger.info('agent identity updated in its prompt file', { agentId, file: soul.file, chars: content.length });
    return;
  }
  const db = getDb();
  db.prepare('UPDATE agents SET charter = ? WHERE id = ?').run(content, agentId);
  logger.info('agent identity updated in agents.charter', { agentId, chars: content.length });
}
