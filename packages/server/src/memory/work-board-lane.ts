// ════════════════════════════════════════════════════════════════════════════════════════
// THE WORK-BOARD LANES, BELOW THE CONVERSATION. W81 (owner's DS4 FINDING 2, 2026-09-12).
//
// ── THE INCIDENT ────────────────────────────────────────────────────────────────────────
// Six occurrences on the owner's production box, each a state-mutating tool call followed
// within seconds by a DEEP invalidation landing BETWEEN the stable prefix and the
// conversation history — 15-50K tokens rebuilt, byte offsets drifting between 30,137 and
// 47,782. Two of the six were `work_update`. His rule, which is also this tree's own
// (roadmap non-negotiable #10, T67b, T69b):
//
//     WHATEVER A TOOL CAN MUTATE MUST RENDER BELOW THE CONVERSATION.
//
// ── WHY THESE TWO LANES ─────────────────────────────────────────────────────────────────
// `lane.attempt-ledger` (was MessageSlot.AttemptLedger = 500) and `lane.active-tasks` (was
// MessageSlot.ActiveTasks = 600) are the two blocks that STATE THE WORK BOARD, and the work
// board is the single most-written surface an agent has. Measured at `0cc9a3ba` on a driven
// pair with nothing else changed, one `work_update` moved the merged prefix block by 52
// chars at index 0 — and index 0 is where the entire message array sits behind.
//
// The census that produced this move found the writers, and there is no small set of them:
//   * `lane.active-tasks` — `work_open:task|project`, `work_update:edit|status|reassign|
//     complete_step|close_project`, `work_validate:*`, `work_schedule:*`, and the ENGINE's
//     own >=6-non-trivial-tool-calls floor (`agent/v2/steps/execute/tracker-floors.ts`),
//     which mints an in_progress row after six `plaud_*` / `file_read` / `onedrive_read`
//     calls. That last one is why PURE READS appeared in the owner's list of six.
//   * `lane.attempt-ledger` — every one of the above again, through the spine's
//     `work_events` transition branch (`work/audit-trail.ts`), plus `work_note`.
//
// A lane written by that many doors cannot be "change-keyed" into stability; the only
// disposition left is the one the rule names. They are post-budget TAIL lanes now, at
// MessageSlot.AttemptLedgerTail = 1810 and MessageSlot.ActiveTasksTail = 1820 — after the
// whole live conversation, before `msg.turn-context` (1850), because they are the more
// stable of the two and the tail's declared order is most-stable-first (T69b §2).
//
// ── WHAT THE MOVE COSTS, STATED RATHER THAN ASSUMED ─────────────────────────────────────
// The tail is 100% uncached — the provider's cached prefix ends at the newest exchange
// (T69b §5, measured). So these blocks are recomputed every turn now, where before they
// were a cache HIT on every turn that changed no work row. What they were ALSO doing was
// re-billing the entire message array behind them on every turn that DID change one, and on
// a working agent that is most turns. The declared reserves below are the honest price:
// ~1,300 tokens per turn against 15-50K per tool call.
//
// ── ONE READ, TWO BLOCKS ────────────────────────────────────────────────────────────────
// Both blocks start from the same `listTasks({ status: 'in_progress', assignedTo })`. They
// are rendered from ONE read here, the way T69b made `renderRecallLane` return two messages
// from one retrieval, and they keep DISTINCT lane tags at the injection site so the receipt
// and the cross-turn gate can still judge them separately.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { taskScope, revertCountExpr, stampColumns } from '../work/tracker-view.js';
import { renderTaskStamps, renderStepFacts, type TaskStampFields } from '../tracker/task-stamps.js';
import { estimateTokens } from './budget.js';
import { laneLimit, truncateWrappedText } from './lanes.js';
import { recordedInstant } from './message-stamp.js';
import { conversationLabel } from './party-label.js';

/** The two ids keep their names: the move is a POSITION change, not a new section. */
export const ATTEMPT_LEDGER_LANE_ID = 'lane.attempt-ledger';
export const ACTIVE_TASKS_LANE_ID = 'lane.active-tasks';
/** The registry entry ids the loop injects under. */
export const ATTEMPT_LEDGER_ENTRY_ID = 'msg.attempt-ledger';
export const ACTIVE_TASKS_ENTRY_ID = 'msg.active-tasks';

/** What the two renders need from one tracker read. Shaped so the worst-case generator can
 *  fabricate a maximal board without a database — the `recall-lane.ts` discipline. */
export interface BoardTask {
  id: string;
  title: string;
  priority: string;
  description: string | null;
  notes: string | null;
}

/**
 * t139 — WHAT WAS ASKED, read through the task's link to the row that carried the request
 * (`work.source_message_id`, the P1 lineage edge). `messageId` null = the task was opened with
 * no link; `words` null with a `messageId` = the row is no longer stored. Both are rendered as
 * exactly what they are, never with a request made up to fill the gap.
 */
export interface TaskOrigin {
  messageId: string | null;
  words: string | null;
  /** The row's own recorded instant (`messages.created_at`, epoch ms). */
  createdAt: number | string | null;
  /** The conversation the row belongs to, as `conversationLabel` names it, plus its channel. */
  label: string | null;
}

/** The one pool of original words the block may spend, shared across its tasks in block order
 *  (see `LANE_LIMITS['lane.active-tasks'].chars.originalWords`). Mutable: each line spends it. */
interface WordsPool { remaining: number }

export interface WorkBoardBlocks {
  attemptLedger: string | null;
  activeTasks: string | null;
}

const ACTIVE_TASKS_HEAD =
  '═══ YOUR ACTIVE TASKS (from tracker, ground truth) ═══\n'
  + 'You are currently assigned to these in_progress tasks. This is what you should be working on:\n';
const ACTIVE_TASKS_TAIL = '═══ END ACTIVE TASKS ═══';
const ATTEMPT_LEDGER_HEAD =
  '═══ ATTEMPT LEDGER (engine record of work on your active tasks, do not repeat attempts '
  + 'already logged here) ═══';
const ATTEMPT_LEDGER_TAIL = '═══ END ATTEMPT LEDGER ═══';

/**
 * One task's line.
 *
 * W81 capped the TITLE (120 chars, one cap with one justification — `lane.relevant-memory`'s
 * `snapshotTitle`), because an unbounded term is what stops a post-budget lane having a
 * derivable worst case.
 *
 * t139 (#7, OR-TRACKER-1) replaced the `Instructions: <description, 300 chars>` line with the
 * REQUESTER'S ORIGINAL WORDS. The 300-char cut is gone; the words are printed verbatim and
 * contiguous between a labelled head and an end marker, so the list can be asserted
 * byte-for-byte against the row that carried the request. The head says WHEN (the row's
 * recorded instant, never a relative time — T67b §3) and WHERE (its conversation). A task with
 * no link shows its stored description under "(original request not linked)": the gap is
 * labelled, never filled with an invented request. A cut — only when the shared pool is spent —
 * says how much is missing and names the message `history_get` returns it from.
 */
function taskLine(
  t: BoardTask, stamp: string | null, steps: string | null, origin: TaskOrigin, pool: WordsPool,
): string {
  const titleCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'title');
  const noteCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'lastNote');
  const title = t.title.length > titleCap ? `${t.title.slice(0, titleCap)}...` : t.title;
  let line = `• ${title} (ID: ${t.id.slice(0, 8)}, priority: ${t.priority})`;
  if (stamp) line += `\n  State: ${stamp}${steps ? ` | ${steps}` : ''}`;
  line += originSection(t, origin, pool);
  if (t.notes) {
    const lastNote = t.notes.split('\n').filter(Boolean).pop();
    if (lastNote) line += `\n  Last note: ${lastNote.slice(0, noteCap)}`;
  }
  return line;
}

/** The origin part of a task line: the original words when linked, the labelled description
 *  when not. Spends the shared pool; returns '' only for an unlinked task with no description. */
function originSection(t: BoardTask, origin: TaskOrigin, pool: WordsPool): string {
  if (origin.messageId && origin.words !== null) {
    const labelCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'originLabel');
    const rawLabel = origin.label ?? 'a conversation with no recorded label';
    const label = rawLabel.length > labelCap ? `${rawLabel.slice(0, labelCap)}...` : rawLabel;
    const head = `\n  Original request (from ${label}, ${recordedInstant(origin.createdAt)}), word for word:\n`;
    return head + spend(origin.words, pool,
      '  [end of original request]',
      (more) => `  [original request continues: ${more} more characters; history_get(id="${origin.messageId}") returns it in full]`);
  }
  const why = origin.messageId
    ? `(original request no longer stored: message ${origin.messageId})`
    : '(original request not linked)';
  if (!t.description) return `\n  Description ${why}: none recorded`;
  return `\n  Description ${why}:\n` + spend(t.description, pool,
    '  [end of description]',
    (more) => `  [description continues: ${more} more characters, not shown]`);
}

/** Print `text` verbatim up to what the pool has left, then the end marker or the cut line. */
function spend(text: string, pool: WordsPool, endMarker: string, cutLine: (more: number) => string): string {
  const shown = text.slice(0, Math.max(0, pool.remaining));
  pool.remaining -= shown.length;
  return shown.length === text.length
    ? `${shown}\n${endMarker}`
    : `${shown}${shown.length > 0 ? '\n' : ''}${cutLine(text.length - shown.length)}`;
}

/** The block, from lines already built. Pure — the worst-case generator calls this one. */
export function renderActiveTasksBlock(lines: string[]): string | null {
  if (lines.length === 0) return null;
  return `${ACTIVE_TASKS_HEAD}\n${lines.join('\n\n')}\n\n${ACTIVE_TASKS_TAIL}`;
}

/** The ledger block, from sections already built. Pure, for the same reason. */
export function renderAttemptLedgerBlock(sections: string[]): string | null {
  if (sections.length === 0) return null;
  return `${ATTEMPT_LEDGER_HEAD}\n${sections.join('\n\n')}\n${ATTEMPT_LEDGER_TAIL}`;
}

/**
 * Both blocks, from ONE tracker read.
 *
 * Every SQL statement, cap and string below is the one the two lanes used at slot 500/600 —
 * this is a position change, and a diff that also changed what the model reads would make
 * the before/after measurement meaningless. The two exceptions are declared and are both
 * bounding, never content: the title cap in `taskLine`, and the ceiling enforcement at the
 * end (a post-budget lane must fit its own declared reserve, `lanes.ts`'s truncate contract).
 */
export async function buildWorkBoardLane(agentId: string): Promise<WorkBoardBlocks> {
  let tasks: BoardTask[] = [];
  try {
    const { listTasks } = await import('../tracker/schema.js');
    tasks = listTasks({ status: 'in_progress', assignedTo: agentId }) as unknown as BoardTask[];
  } catch {
    return { attemptLedger: null, activeTasks: null };   // tracker may not be available
  }
  if (tasks.length === 0) return { attemptLedger: null, activeTasks: null };

  return {
    attemptLedger: enforce(await attemptLedgerFrom(tasks), attemptLedgerWorstCaseTokens()),
    activeTasks: enforce(activeTasksFrom(tasks), activeTasksWorstCaseTokens()),
  };
}

/** A post-budget lane may not exceed the reserve it declared. `lanes.ts`'s truncate contract
 *  applied at the render, because there is no allocator downstream of a post-budget lane. */
function enforce(block: string | null, maxTokens: number): string | null {
  if (!block) return null;
  return estimateTokens(block) > maxTokens ? truncateWrappedText(block, maxTokens) : block;
}

function activeTasksFrom(tasks: BoardTask[]): string | null {
  try {
    const db = getDb();
    const stampStmt = db.prepare(
      `SELECT w.id AS id, ${stampColumns('w')},
              w.step_number AS step_number, w.total_steps AS total_steps,
              w.parent_id AS project_id
         FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
    );
    // t139: the request the task exists for, through the task->row edge. One PK read per task
    // (<= rows.tasks of them), joined to the row that carried it.
    const originStmt = db.prepare(
      `SELECT w.source_message_id AS message_id, m.id AS found_id, m.content AS content,
              m.created_at AS created_at, m.conversation_id AS conversation_id,
              COALESCE(c.channel, m.channel) AS channel
         FROM work w
         LEFT JOIN messages m ON m.id = w.source_message_id
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE w.id = ?`,
    );
    const pool: WordsPool = { remaining: laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'originalWords') };
    const lines = tasks.slice(0, laneLimit(ACTIVE_TASKS_LANE_ID, 'rows', 'tasks')).map((t) => {
      let stamp: string | null = null;
      let steps: string | null = null;
      try {
        const st = stampStmt.get(t.id) as TaskStampFields | undefined;
        if (st) {
          // T67b §3: the RECORDED INSTANT, never `relAgo(...)`. The reason has not changed
          // with the position — a block that is a function of the wall clock cannot be
          // asserted about, and `msg.current-time` at 1900 already teaches the subtraction.
          stamp = renderTaskStamps(st, { relative: false });
          steps = renderStepFacts(st);
        }
      } catch { /* stamps are best-effort */ }
      return taskLine(t, stamp, steps, readOrigin(originStmt, t.id), pool);
    });
    return renderActiveTasksBlock(lines);
  } catch { return null; }
}

/** The task's origin row, labelled. A failed read is "not linked" only when there is no link;
 *  a link whose row cannot be read reports the link, so the gap is never misnamed. */
function readOrigin(stmt: { get: (id: string) => unknown }, taskId: string): TaskOrigin {
  try {
    const r = stmt.get(taskId) as {
      message_id: string | null; found_id: string | null; content: string | null;
      created_at: number | string | null; conversation_id: string | null; channel: string | null;
    } | undefined;
    if (!r?.message_id) return { messageId: null, words: null, createdAt: null, label: null };
    if (!r.found_id) return { messageId: r.message_id, words: null, createdAt: null, label: null };
    return {
      messageId: r.message_id, words: r.content ?? '', createdAt: r.created_at,
      label: originLabel(conversationLabel(r.conversation_id), r.channel),
    };
  } catch {
    return { messageId: null, words: null, createdAt: null, label: null };
  }
}

/** "<party> on <channel>", without saying the channel twice when the party label already
 *  carries it (`conversationLabel` renders a contact as "Name (channel)"). */
function originLabel(party: string | null, channel: string | null): string | null {
  if (party && channel && !party.includes(`(${channel})`)) return `${party} on ${channel}`;
  return party ?? (channel ? `the ${channel} channel` : null);
}

async function attemptLedgerFrom(tasks: BoardTask[]): Promise<string | null> {
  try {
    const { getRecentObservations, getRecentTransitions, formatEntryLine } =
      await import('../tracker/task-log.js');
    const forLedger = tasks.slice(0, laneLimit(ATTEMPT_LEDGER_LANE_ID, 'rows', 'tasks'));
    const sections: string[] = [];
    for (const task of forLedger) {
      const entries = [
        ...getRecentObservations(task.id, laneLimit(ATTEMPT_LEDGER_LANE_ID, 'rows', 'observations')),
        ...getRecentTransitions(task.id, laneLimit(ATTEMPT_LEDGER_LANE_ID, 'rows', 'transitions')),
      ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-laneLimit(ATTEMPT_LEDGER_LANE_ID, 'rows', 'entries'));
      if (entries.length === 0) continue;
      let revertNote = '';
      try {
        const row = getDb().prepare(`SELECT ${revertCountExpr('w')} AS revert_count FROM work w WHERE w.id = ?`)
          .get(task.id) as { revert_count: number | null } | undefined;
        if (row?.revert_count) revertNote = `, reverted ${row.revert_count}x already`;
      } catch { /* column may not exist on old DBs */ }
      sections.push(`Task "${task.title}"${revertNote}:\n${entries.map((e) => `  ${formatEntryLine(e)}`).join('\n')}`);
    }
    return renderAttemptLedgerBlock(sections);
  } catch { return null; /* tracker may be empty or absent */ }
}

// ── THE DECLARED RESERVES, DERIVED BY CALLING THE RENDERER ──────────────────────────────
//
// `lanes.ts`'s `PostBudgetLane.measured` says a reserve with no derivation is a rumour. Both
// numbers below are produced by feeding the REAL block renderers a board in which every
// declared cap is flooded at once — the `recallLaneWorstCaseTokens` discipline — so a cap
// that changes moves the reserve with it and `work-board-lane.test.ts` pins each literal in
// `POST_BUDGET_LANES` to the function that produced it.

let activeTasksWorstCase: number | null = null;
let attemptLedgerWorstCase: number | null = null;

/**
 * Every cap of `lane.active-tasks` flooded at once, through `renderActiveTasksBlock`.
 *
 * t139: the words term is ONE POOL, so its worst case is the pool spent in full plus the most
 * framing five lines can carry around it: every task is linked, every request is over the cap
 * (so each line carries the longer "continues" line, not the end marker — the first spends the
 * whole pool, the rest are pointer-only), every label is at its cap, and the message ids and
 * the "more characters" counts are at their widest.
 */
export function activeTasksWorstCaseTokens(): number {
  if (activeTasksWorstCase !== null) return activeTasksWorstCase;
  const rows = laneLimit(ACTIVE_TASKS_LANE_ID, 'rows', 'tasks');
  const titleCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'title');
  const wordsCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'originalWords');
  const labelCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'originLabel');
  const noteCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'lastNote');
  // The widest stamp/steps terms the two tracker renderers can produce, measured by CALLING
  // them with every field present rather than by counting characters beside them.
  const widestStamp = renderTaskStamps({
    last_answered_turn: 999_999, last_answered_at: '2026-09-30T23:41:59.999Z',
    last_delivery_summary: 'x'.repeat(200), revert_count: 99,
    step_number: 99, total_steps: 99, project_id: 'p'.repeat(36),
  } as unknown as TaskStampFields, { relative: false }) ?? '';
  const widestSteps = renderStepFacts({
    step_number: 99, total_steps: 99, project_id: 'p'.repeat(36),
  } as unknown as TaskStampFields) ?? '';
  // A request longer than any message the lane could be asked to cut, so the "continues" count
  // is as wide as it can get on a real row (10 digits — a message would have to be over 10 GB).
  const longest = 9_999_999_999;
  const pool: WordsPool = { remaining: wordsCap };
  const lines: string[] = [];
  for (let i = 0; i < rows; i++) {
    lines.push(taskLine({
      id: 'w'.repeat(36),
      title: 't'.repeat(titleCap + 10),        // over the cap, so the `...` suffix is counted
      priority: 'critical',
      description: null,
      notes: 'n'.repeat(noteCap + 10),
    }, widestStamp, widestSteps, {
      messageId: 'm'.repeat(36),
      // Only the pool's worth is ever printed, so the string need only be that long plus one;
      // the "continues" count is computed from its length, which is substituted below.
      words: 'w'.repeat(wordsCap + 1),
      // Mid-month at mid-day, so every box timezone renders a two-digit day and a two-digit
      // hour — the widest `[Sep 15, 2026, 12:41 PM]` shape, with no timezone able to move it.
      createdAt: Date.parse('2026-09-15T12:41:00Z'),
      label: 'l'.repeat(labelCap + 10),
    }, pool).replace(/continues: \d+ more/, `continues: ${longest} more`));
  }
  activeTasksWorstCase = estimateTokens(renderActiveTasksBlock(lines) ?? '');
  return activeTasksWorstCase;
}

/**
 * The ledger's worst case is its OWN DECLARED CEILING, and that is the derivation rather
 * than a shortcut around one: `LANE_LIMITS['lane.attempt-ledger'].tokens.cap = 800` was the
 * lane's `maxTokens` at slot 500 and `truncateTextLane` enforced it on every assembly, so
 * 800 is the largest this block has ever been allowed to be. `enforce` above applies the
 * same ceiling at the render, which is where it has to live now that no allocator runs
 * downstream of it. The entry-width caps (2 tasks x 6 entries) sit INSIDE that ceiling and
 * are what usually binds; the ceiling is what makes the number derivable at all.
 */
export function attemptLedgerWorstCaseTokens(): number {
  if (attemptLedgerWorstCase !== null) return attemptLedgerWorstCase;
  attemptLedgerWorstCase = laneLimit(ATTEMPT_LEDGER_LANE_ID, 'tokens', 'cap');
  return attemptLedgerWorstCase;
}
