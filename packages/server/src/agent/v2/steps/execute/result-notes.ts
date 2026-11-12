// The notes a tool result can pick up on its way back to the model; each appends at most one, none blocks.

import { getDb } from '../../../../db/connection.js';
import { CLOSE_OPS_WITH_TASK_ID, toolOpKey } from '../../../../tools/work-verbs.js';
import { engineScaffoldScope, taskScope } from '../../../../work/tracker-view.js';
import { answerReceiptForAsk, substantiveReplySince } from '../../answered-edge.js';

// Tool results are shown only to the agent, so one carrying a URL or an uploads path gets a neutral note
// that the person cannot see it (cheaper here than in every system prompt).
const VISIBILITY_HINT = `\n\n[VISIBILITY: tool results are shown only to you, not to the person you are talking to. The person you are talking to sees only your reply text and any files you attach via show_to_user. If you want them to have a URL or detail from this result, include it inline in your reply, they cannot "see above". If there's nothing here worth surfacing, no action needed.]`;

const VISIBILITY_TRIGGER_RE = /https?:\/\/\S+|[~/]\.dojo\/uploads\//;
// After these hand-picked bookkeeping tools, a note puts the [no-reply] escape next to the model's next
// decision. Narrower than classifyTool 'bookkeeping' on purpose; drift only mutes a soft nudge.
const BOOKKEEPING_NUDGE_TOOLS = new Set([
  'work_update:status',
  'work_update:hand_in',
  'complete_task',
  'vault_remember',
  'vault_update',
  'vault_forget',
  'credential_add',
  'credential_update',
  'credential_delete',
]);

const BOOKKEEPING_NUDGE = `\n\n[Engine note: this was internal bookkeeping. If the person you are talking to just asked you to do exactly this (e.g. "save my key", "remember that", "delete X"), reply with ONE short line confirming it is done (e.g. "Saved.", "Got it, stored your OpenWeather key.") so they get acknowledgment. If instead this was incidental to other work, something you did on your own initiative, or the person you are talking to already has what they needed, end the turn with literal \`[no-reply]\` rather than a generic "Done." / "All set." / "Got it." closeout.]`;

// A close of a user-requested (engine-scaffold) task drops [no-reply] and asks for the outcome and link.
const BOOKKEEPING_NUDGE_USER_REQUESTED = `\n\n[Engine note: the person you are talking to asked you to do this, so it is not incidental bookkeeping. Reply to them now with the outcome in one short line, and if your tool results above produced a link or file for them (a "Link:", "Open:", or "Share link:" line), include that link in your reply so they can open it. Do NOT end this turn with [no-reply].]`;
export function appendVisibilityHintIfRelevant<T extends { content?: string; isError?: boolean }>(toolResult: T): T {
  if (toolResult.isError) return toolResult;
  const content = toolResult.content;
  if (typeof content !== 'string' || !content) return toolResult;
  if (!VISIBILITY_TRIGGER_RE.test(content)) return toolResult;
  return { ...toolResult, content: content + VISIBILITY_HINT };
}
export function appendBookkeepingNudgeIfRelevant<T extends { name?: string; content?: string; isError?: boolean }>(toolResult: T, userRequestedClose = false): T {
  if (toolResult.isError) return toolResult;
  if (!toolResult.name || !BOOKKEEPING_NUDGE_TOOLS.has(toolResult.name)) return toolResult;
  const content = toolResult.content;
  if (typeof content !== 'string') return toolResult;
  const note = userRequestedClose ? BOOKKEEPING_NUDGE_USER_REQUESTED : BOOKKEEPING_NUDGE;
  return { ...toolResult, content: content + note };
}
/** True when a close (by task_id or its prefix) targets an engine-scaffold task whose ask is unanswered.
 *  Any miss returns false, which keeps the generic [no-reply] note. */
export function userRequestedCloseWantsReply(
  toolName: string | undefined,
  args: Record<string, unknown>,
  agentId: string,
): boolean {
  if (!toolName || !CLOSE_OPS_WITH_TASK_ID.has(toolOpKey(toolName, args))) return false;
  const rawId = args?.task_id;
  if (typeof rawId !== 'string' || !rawId.trim()) return false;
  const id = rawId.trim();
  try {
    const db = getDb();
    const task = db.prepare(`
      SELECT t.opened_at AS opened_at_ms, t.source_message_id AS source_message_id FROM work t
      LEFT JOIN work p ON p.id = t.parent_id
      WHERE ${taskScope('t')} AND t.agent_id = ?
        AND (t.id = ? OR t.id LIKE ?)
        AND (${engineScaffoldScope('t')} OR t.origin_kind = 'engine_scaffold' OR p.origin_kind = 'engine_scaffold')
      LIMIT 1
    `).get(agentId, id, `${id}%`) as { opened_at_ms: number; source_message_id: string | null } | undefined;
    if (!task) return false;
    if (task.source_message_id) {
      // Answered is read by the one reader, `answerReceiptForAsk`; an ask with neither receipt nor stamp
      // falls through to the substantive-reply probe.
      const receipt = answerReceiptForAsk(task.source_message_id);
      if (!(receipt.legacyRow && !receipt.answered)) return !receipt.answered;
    }
    // The pre-spine probe is one function (`answered-edge.ts`); `opened_at` is epoch ms.
    return !substantiveReplySince(agentId, task.opened_at_ms);
  } catch {
    return false;
  }
}
