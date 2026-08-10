// ════════════════════════════════════════
// PHASE-6 T7 (CUT 7) — the three notes a tool RESULT can pick up on its way back
// to the model, moved out of `loop.ts` module level with the code that appends
// them. Every use of all three was inside the `execute` span.
//
// One file because they are one shape: each takes the result, decides on the
// result's own content, and returns it unchanged or with one note appended. None
// of them blocks anything.
// ════════════════════════════════════════

import { getDb } from '../../../../db/connection.js';
import { CLOSE_OPS_WITH_TASK_ID, toolOpKey } from '../../../../tools/work-verbs.js';
import { engineScaffoldScope, taskScope } from '../../../../work/tracker-view.js';
import { answerReceiptForAsk, substantiveReplySince } from '../../answered-edge.js';

// v2.5.9, Just-in-time visibility hint helper.
//
// When a tool result contains content the user will not see (URLs the
// agent might want to share, file paths from the shared uploads dir),
// append a small informational note so the agent knows the user can't
// read its tool results directly. The note is intentionally NEUTRAL, 
// it doesn't tell the agent it MUST surface anything, just clarifies the
// visibility model. The agent retains full discretion about what to
// share, what to summarize, and what to keep internal.
//
// Trade-off: ~50 tokens per triggering tool result, vs. spending the
// same tokens in the system prompt every turn whether or not relevant.
const VISIBILITY_HINT = `\n\n[VISIBILITY: tool results are shown only to you, not to the user. The user sees only your reply text and any files you attach via show_to_user. If you want them to have a URL or detail from this result, include it inline in your reply, they cannot "see above". If there's nothing here worth surfacing, no action needed.]`;

// Match http(s) URLs OR file paths under the shared uploads dir.
// Conservative: only triggers on patterns that are typically things the
// agent might want to surface, not generic mentions of paths/URLs.
const VISIBILITY_TRIGGER_RE = /https?:\/\/\S+|[~/]\.dojo\/uploads\//;
// v2.7.22, Soft nudge after internal-bookkeeping tools. These tools
// (vault_remember, work_update(action="status"), complete_task, credential_*,
// etc.) reliably trigger the model's "wrap up with a closeout line"
// reflex even though the prompt teaches [no-reply] as the escape
// hatch. The prompt sits at the top of the context; the tool result
// sits at the bottom right next to the model's next decision. This
// nudge appends a one-line reminder INSIDE the tool result so the
// escape hatch is in the model's face at the exact moment it would
// otherwise default to "All set." or "Done."
//
// Soft, not destructive: we don't strip anything; we only inform.
// The model still chooses. If a substantive reply is warranted (user
// asked a real question, work isn't done, etc.), it can ignore the
// nudge and write whatever it wants. Same machinery as the visibility
// hint above, append-on-condition, no behavior change to the tool.
//
// HAND-PICKED, NOT DERIVABLE: this is a curated subset of bookkeeping tools
// that specifically trigger the model's "wrap up with a closeout line" reflex
// when they are the LAST thing the user asked for ("save my key", "remember
// that"). It is intentionally narrower than classifyTool === 'bookkeeping' (we
// do not nudge after a scratchpad_set or a tracker read); drift here only mutes
// a soft nudge on a new tool, never a correctness issue.
const BOOKKEEPING_NUDGE_TOOLS = new Set([
  'work_update:status',
  'work_update:complete_step',
  'complete_task',
  'vault_remember',
  'vault_update',
  'vault_forget',
  'credential_add',
  'credential_update',
  'credential_delete',
]);

const BOOKKEEPING_NUDGE = `\n\n[Engine note: this was internal bookkeeping. If the user just asked you to do exactly this (e.g. "save my key", "remember that", "delete X"), reply with ONE short line confirming it is done (e.g. "Saved.", "Got it, stored your OpenWeather key.") so they get acknowledgment. If instead this was incidental to other work, something you did on your own initiative, or the user already has what they needed, end the turn with literal \`[no-reply]\` rather than a generic "Done." / "All set." / "Got it." closeout.]`;

// Marker-aware variant. When the task being closed is an ENGINE-OPENED row
// (`root_kind='engine_scaffold'` — T8c item 3's rekey of the old prose marker), the
// [no-reply] branch is WRONG: a live failure had the floor model close a
// user-requested itinerary task and then go silent because the generic note
// offered exactly that escape. So for user-requested closes the note drops the
// [no-reply] option entirely and asks plainly for the outcome + any link. The
// generic note above stays for genuinely incidental / self-initiated
// bookkeeping, where silence is still the right call.
const BOOKKEEPING_NUDGE_USER_REQUESTED = `\n\n[Engine note: the user asked you to do this, so it is not incidental bookkeeping. Reply to them now with the outcome in one short line, and if your tool results above produced a link or file for them (a "Link:", "Open:", or "Share link:" line), include that link in your reply so they can open it. Do NOT end this turn with [no-reply].]`;
export function appendVisibilityHintIfRelevant<T extends { content?: string; isError?: boolean }>(toolResult: T): T {
  // Skip on errors, error messages aren't artifacts to share.
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
/**
 * True when this close targets a USER-REQUESTED task (project description
 * is an engine scaffold — `root_kind='engine_scaffold'`) that the user has NOT yet been answered for,
 * i.e. the case where the "reply now with the outcome" note belongs instead of
 * the [no-reply] one. Reads the task by its task_id argument (full UUID or
 * 8-char prefix). Returns false, so the generic note (which keeps the [no-reply]
 * escape) is used, when: not a marker task, OR the user already received a
 * substantive reply for this work since the task was created (a silent
 * cross-turn close where silence IS correct, the same case the completion-ack
 * dedup handles). Synchronous DB reads, best-effort: any miss returns false.
 */
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
    // Already answered, P4 rekey: the ask row that BIRTHED this task records
    // the reply that answered it (answer_message_id, migration 113). A keyed
    // read replaces the length>40 adjacency probe; the probe survives only as
    // the pre-spine fallback for rootless tasks.
    if (task.source_message_id) {
      // PHASE-2 T6 (C5): ONE reader. `answerReceiptForAsk` is the ticket's
      // `result_delivery_id` and the mig-113 stamp read in a single statement, so this site
      // and the four others that asked the same question can no longer answer it
      // differently. `legacyRow` distinguishes "this ask has no ticket AND no stamp" (fall
      // through to the pre-spine probe) from "asked and not yet answered" (return true).
      const receipt = answerReceiptForAsk(task.source_message_id);
      if (!(receipt.legacyRow && !receipt.answered)) return !receipt.answered;
    }
    // UX-REPAIR T15: the pre-spine probe is one function now (`answered-edge.ts`), shared with
    // the completion detection in `finalize/completion-ack.ts` that used to carry its own copy
    // of these six clauses. The boundary is ms on both sides — `opened_at` is epoch ms and the
    // ms→text→seconds→ms round-trip that used to sit here is gone entirely.
    return !substantiveReplySince(agentId, task.opened_at_ms);
  } catch {
    return false;
  }
}
