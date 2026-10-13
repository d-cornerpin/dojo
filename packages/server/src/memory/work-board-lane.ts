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
import { estimateTokens, CHARS_PER_TOKEN } from './budget.js';
import {
  laneLimit, truncateWrappedText, POST_BUDGET_LANES, type AllocationReport, type ReserveLadder,
} from './lanes.js';
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
  /** t139: the tracker status. The block carries every UNFINISHED task, not only in-progress
   *  ones, so a line that is waiting says so (`BOARD_STATUSES`). */
  status?: string;
  /** The engine's own record that IT paused the row (waiting on the person who asked). */
  statusBeforePause?: string | null;
  /** When the task was opened — round 2 lists the NEWEST request first. */
  createdAt?: string;
}

/**
 * t139 (#7, OR-TRACKER-1, OR-LABEL-NOT-HIDE) — WHICH TASKS THE LIST CARRIES: every task assigned
 * to the agent that is not finished, in-progress first.
 *
 * It read `in_progress` alone. Driven through the real dashboard delivery door
 * (`work/__tests__/t139-every-request-lands-on-the-task-list.test.ts`), an owner's long ask whose
 * turn answered "on it" and made no effectful call had its task moved to `paused` by the engine
 * (`agent/v2/answered-edge.ts`), and the task — with the owner's words — vanished from the list
 * while the work was still owed. The list is the ONE record of what is current; a waiting task
 * is still current, so it is SHOWN and LABELLED, never hidden.
 *
 * Not here, deliberately: `on_deck` (scheduled for later — the scheduler moves it to in_progress
 * when it is due, and a queued job is not current work) and the terminal states.
 */
export const BOARD_STATUSES = ['in_progress', 'blocked', 'paused'] as const;

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
  /** Just the party (`conversationLabel`), for "waiting on <party>". */
  party?: string | null;
}

/**
 * ROUND 2 — everything one task line renders from, read before any words are spent, because the
 * pool is spent in PASSES (every current request first, then edited descriptions) while the lines
 * are printed in block order.
 */
interface TaskView {
  t: BoardTask;
  stamp: string | null;
  steps: string | null;
  origin: TaskOrigin;
  /** Set for a paused/blocked task: when it entered that state, and who put it there (the
   *  transition's own `by`; `blocked` for a blocked task). The words are chosen at render. */
  waiting: { since: number | string | null; by: WaitingBy } | null;
  /** The task's record holds a `description_edited` entry (review M3: a fact, not a byte test). */
  edited: boolean;
  /** Newer messages in the request's conversation (item 6's factual line). */
  newer: { count: number; newestAt: number | string | null };
}

type WaitingBy = 'blocked' | 'engine' | 'owner' | 'other';

/** The characters of original words this rendering may spend, shared across its tasks in pass
 *  order. Round 5: no longer a fixed number — `fitTaskList` sets it from the room the assembly
 *  left the list. Mutable: each line spends it. */
interface WordsPool { remaining: number }

/** The widths of the three short terms the block does not author. `WHOLE` when the view holds
 *  everything; the declared `LANE_LIMITS` widths (what the reserve was derived at) when it
 *  cannot. */
interface TermCaps { title: number; label: number; note: number }
const WHOLE: TermCaps = { title: Infinity, label: Infinity, note: Infinity };
function declaredCaps(): TermCaps {
  return {
    title: laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'title'),
    label: laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'originLabel'),
    note: laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'lastNote'),
  };
}

export interface WorkBoardBlocks {
  attemptLedger: string | null;
  activeTasks: string | null;
}

const ACTIVE_TASKS_HEAD =
  '═══ YOUR ACTIVE TASKS (from tracker, ground truth) ═══\n'
  + 'These are the unfinished tasks assigned to you, newest first. The in_progress ones are what you '
  + 'should be working on, each with the request that started it; a paused or blocked one is NOT '
  + 'current and says what it is waiting on:\n';
const ACTIVE_TASKS_TAIL = '═══ END ACTIVE TASKS ═══';
const ATTEMPT_LEDGER_HEAD =
  '═══ ATTEMPT LEDGER (engine record of work on your active tasks, do not repeat attempts '
  + 'already logged here) ═══';
const ATTEMPT_LEDGER_TAIL = '═══ END ATTEMPT LEDGER ═══';

/**
 * The task lines, in block order, from views already read, spending `poolChars` characters of
 * words and printing the three short terms at `caps`.
 *
 * W81 capped the TITLE, because an unbounded term is what stops a post-budget lane having a
 * derivable worst case. t139 replaced the 300-char `Instructions:` cut with the REQUESTER'S
 * ORIGINAL WORDS, printed verbatim and contiguous between a labelled head (who, when) and an end
 * marker. ROUND 2:
 *   * a WAITING task (paused/blocked) prints no words: a status line saying since when and on
 *     whom it waits, that it is NOT current and must not be resumed unless asked, and a POINTER
 *     to its request — and it spends nothing from the pool (review C1: a weeks-old paused job
 *     with its full words rode every turn, the #7 shape);
 *   * the pool is spent in PASSES — every current request first, newest task first, then any
 *     description the task's record says was EDITED — so an older brief or an agent's own words
 *     can never starve the newest request (review I1, M3);
 *   * newer messages in the request's conversation are COUNTED under it (item 6, a fact from the
 *     rows that claims no relation to the task).
 * ROUND 5: how much the pool holds is decided by `fitTaskList` from the room this assembly left
 * the list — never a fixed number.
 * A task with no link shows its stored description under "(original request not linked)"; a cut
 * says how much is missing and names the message `history_get` returns it from.
 */
function renderTaskLines(views: TaskView[], poolChars: number, caps: TermCaps): string[] {
  const pool: WordsPool = { remaining: poolChars };
  const requestOf = new Map<number, string>();
  const editedOf = new Map<number, string>();
  views.forEach((v, i) => { if (!v.waiting) requestOf.set(i, requestSection(v, pool, caps)); });
  views.forEach((v, i) => {
    if (!v.waiting && v.edited && v.t.description && v.origin.messageId && v.origin.words !== null) {
      editedOf.set(i, '\n  The task\'s own description (as last edited):\n' + spend(v.t.description, pool,
        '  [end of description]',
        (more) => `  [description continues: ${more} more characters, not shown]`));
    }
  });
  return views.map((v, i) => taskLine(v, requestOf.get(i) ?? '', editedOf.get(i) ?? '', caps));
}

function taskLine(v: TaskView, req: string, edited: string, caps: TermCaps): string {
  const { t } = v;
  const title = t.title.length > caps.title ? `${t.title.slice(0, caps.title)}...` : t.title;
  let line = `• ${title} (ID: ${t.id.slice(0, 8)}, priority: ${t.priority})`;
  if (v.waiting) {
    line += `\n  Status: ${t.status} since ${recordedInstant(v.waiting.since)} — ${waitingOn(v, caps)}. `
      + 'Not current work: do not resume it unless asked.';
  }
  if (v.stamp) line += `\n  State: ${v.stamp}${v.steps ? ` | ${v.steps}` : ''}`;
  line += v.waiting ? pointerLine(v.origin, caps) : req + newerLine(v) + edited;
  if (t.notes) {
    const lastNote = t.notes.split('\n').filter(Boolean).pop();
    if (lastNote) line += `\n  Last note: ${lastNote.slice(0, caps.note)}`;
  }
  return line;
}

/** WHO paused it is the transition's own `by` (round 3): `status_before_pause` is written for
 *  every pause, so it cannot tell the engine's "waiting on the person" from an owner pausing the
 *  job himself — which is not a question waiting on his answer. */
function waitingOn(v: TaskView, caps: TermCaps): string {
  switch (v.waiting?.by) {
    case 'blocked': return 'waiting on what blocked it (its last note says what)';
    case 'engine': return `waiting on ${capLabel(v.origin.party, 'the person who asked', caps)} to answer`;
    case 'owner': return 'paused by the owner';
    default: return 'paused by whoever paused it';
  }
}

function capLabel(raw: string | null | undefined, fallback: string, caps: TermCaps): string {
  const label = raw ?? fallback;
  return label.length > caps.label ? `${label.slice(0, caps.label)}...` : label;
}

/** A current task's request: the linked words, or the labelled description when unlinked. */
function requestSection(v: TaskView, pool: WordsPool, caps: TermCaps): string {
  const { t, origin } = v;
  if (origin.messageId && origin.words !== null) {
    const head = `\n  Original request (from ${capLabel(origin.label, 'a conversation with no recorded label', caps)}, `
      + `${recordedInstant(origin.createdAt)}), word for word:\n`;
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

/** A waiting task's request, as a pointer only — the words are one `history_get` away. */
function pointerLine(origin: TaskOrigin, caps: TermCaps): string {
  if (!origin.messageId) return '\n  [original request not linked]';
  if (origin.words === null) return `\n  [original request: message ${origin.messageId}, no longer stored]`;
  return `\n  [original request: message ${origin.messageId}, ${recordedInstant(origin.createdAt)}, `
    + `from ${capLabel(origin.label, 'a conversation with no recorded label', caps)}; `
    + `history_get(id="${origin.messageId}") returns it]`;
}

function newerLine(v: TaskView): string {
  if (v.newer.count <= 0) return '';
  return `\n  Newer messages in this conversation since this request: ${v.newer.count}, `
    + `the newest ${recordedInstant(v.newer.newestAt)}; history_get shows them.`;
}

/** Print `text` verbatim up to what the pool has left, then the end marker or the cut line. */
function spend(text: string, pool: WordsPool, endMarker: string, cutLine: (more: number) => string): string {
  const shown = text.slice(0, Math.max(0, pool.remaining));
  pool.remaining -= shown.length;
  return shown.length === text.length
    ? `${shown}\n${endMarker}`
    : `${shown}${shown.length > 0 ? '\n' : ''}${cutLine(text.length - shown.length)}`;
}

/** The line that says tasks were left off the list, and where they are. Never silent. */
function hiddenLine(hidden: number): string {
  return `…and ${hidden} more unfinished task${hidden === 1 ? '' : 's'} not shown here: this view has `
    + 'no room left for them. work_update(action="list") lists every task.';
}

/** The block, from lines already built. Pure — the worst-case generator calls this one. */
export function renderActiveTasksBlock(lines: string[], hidden = 0): string | null {
  if (lines.length === 0) return null;
  const more = hidden > 0 ? `\n\n${hiddenLine(hidden)}` : '';
  return `${ACTIVE_TASKS_HEAD}\n${lines.join('\n\n')}${more}\n\n${ACTIVE_TASKS_TAIL}`;
}

// ── ROUND 5: THE ROOM THE VIEW ACTUALLY HAS ─────────────────────────────────────────────
//
// Owner ruling, 2026-10-13: "I don't want to put hard limits on the dojo. The dojo should be
// smart enough to know when enough is enough." Rounds 1-4 spent ONE fixed 8,000-character pool
// across every task, so three 4,000-character requests lost the third to a pointer on a 200K
// window with tens of thousands of tokens unused.
//
// THE SIGNAL. The list is a post-budget lane: the assembler took its declared reserve off the
// top BEFORE the content fit (`reserveLadderFor`), then ran the fit (`fitLanes`). So the room
// the list really has on this assembly is two numbers the assembler already holds:
//   * its OWN SHARE of the ladder — the declared reserve, scaled by the same factor as the whole
//     ladder when the window could not hold all of it (`ladder.offTheTop / ladder.declared`), so
//     on a small window the list never spends the share the other appends were promised; and
//   * the content fit's UNSPENT budget (`allocation.budgetTokens - allocation.spentTokens`):
//     room the conversation, summaries and recall were offered and did not need.
// Nothing new is reserved and the content budget does not move, so the cached region's bytes
// are exactly what they were (G2): what changes is only how much of THIS block, which sits
// below the conversation and is uncached by construction, the view can carry.
//
// WHY THE CONVERSATION CANNOT BE STARVED. The fit has already run when this is read; the list
// is offered only what the fit left. A full conversation leaves no slack and the list falls
// back to its own reserve, which is the guarantee the reserve was derived for (below).

/** The fit's two outputs this lane reads; the assembler passes them through unchanged. */
export interface TaskListRoom {
  allocation: Pick<AllocationReport, 'budgetTokens' | 'spentTokens'>;
  ladder: Pick<ReserveLadder, 'offTheTop' | 'declared' | 'scaled'>;
}

/** The lane's declared reserve: what the budget took off the top for it. */
function declaredReserveTokens(): number {
  const lane = POST_BUDGET_LANES.find((l) => l.id === ACTIVE_TASKS_LANE_ID);
  return lane ? lane.reserveTokens : activeTasksWorstCaseTokens();
}

/** Tokens this assembly can give the task list. With no room passed (a caller outside the
 *  assembler), the declared reserve — the guarantee and nothing more. */
export function activeTasksRoomTokens(room?: TaskListRoom): number {
  const reserve = declaredReserveTokens();
  if (!room) return reserve;
  const { allocation, ladder } = room;
  const share = ladder.scaled && ladder.declared > 0
    ? Math.floor((reserve * Math.max(0, ladder.offTheTop)) / ladder.declared)
    : reserve;
  return share + Math.max(0, allocation.budgetTokens - allocation.spentTokens);
}

/**
 * Lay the list out in `roomTokens`. The order of what gives way is the order of value:
 *   1. if every unfinished task fits WHOLE — every request, every title, label and note — the
 *      block is exactly that, with nothing cut;
 *   2. otherwise the three short terms take their declared widths and the declared floor of rows
 *      is listed; a further row is listed only while every listed request still fits whole
 *      (words before rows); under the floor, a row is dropped only when even its framing cannot
 *      fit; every row left off is COUNTED in a closing line, never silently dropped;
 *   3. the words get every character left — the largest pool the room holds, found by stepping
 *      down from the room by exactly the overshoot (one character of pool moves the block by at
 *      most one character, so a step can never skip a pool that fits).
 * `enforce` stays behind it as the backstop for a room smaller than the block's bare framing.
 */
function fitTaskList(count: number, viewAt: (i: number) => TaskView, roomTokens: number): string | null {
  if (count === 0) return null;
  const roomChars = roomTokens * CHARS_PER_TOKEN;
  const views = (n: number) => Array.from({ length: n }, (_, i) => viewAt(i));
  const blockChars = (lineChars: number[], hidden: number) =>
    (renderActiveTasksBlock(['x'], hidden) ?? '').length - 1
    + lineChars.reduce((a, b) => a + b, 0) + 2 * (lineChars.length - 1);
  // A line rendered with an unlimited or an empty pool does not depend on its neighbours, so a
  // row count can be grown one line at a time.
  const lineChars = (i: number, pool: number, caps: TermCaps) =>
    renderTaskLines([viewAt(i)], pool, caps)[0].length;

  // 1. Everything whole.
  const whole: number[] = [];
  for (let i = 0; i < count; i++) {
    whole.push(lineChars(i, Infinity, WHOLE));
    if (blockChars(whole, 0) > roomChars) break;
  }
  if (whole.length === count && blockChars(whole, 0) <= roomChars) {
    return renderActiveTasksBlock(renderTaskLines(views(count), Infinity, WHOLE));
  }

  // 2. Rows: the declared floor, more while the words stay whole, fewer only when framing cannot fit.
  const caps = declaredCaps();
  let n = Math.min(count, laneLimit(ACTIVE_TASKS_LANE_ID, 'rows', 'tasksFloor'));
  const capped = Array.from({ length: n }, (_, i) => lineChars(i, Infinity, caps));
  while (n < count) {
    const next = [...capped, lineChars(n, Infinity, caps)];
    if (blockChars(next, count - next.length) > roomChars) break;
    capped.push(next[next.length - 1]);
    n++;
  }
  const bare = Array.from({ length: n }, (_, i) => lineChars(i, 0, caps));
  while (n > 1 && blockChars(bare.slice(0, n), count - n) > roomChars) n--;

  // 3. Words: the largest pool the room holds.
  const shown = views(n);
  let pool = roomChars;
  let block = renderActiveTasksBlock(renderTaskLines(shown, pool, caps), count - n) ?? '';
  for (let step = 0; block.length > roomChars && pool > 0 && step < FIT_STEP_BACKSTOP; step++) {
    pool = Math.max(0, pool - (block.length - roomChars));
    block = renderActiveTasksBlock(renderTaskLines(shown, pool, caps), count - n) ?? '';
  }
  return block;
}

/** A pure safety backstop on the step-down above, never what decides the words: each step lands
 *  on the largest pool that could fit and only a new cut line or one more digit in a count can
 *  push it over again, so a real list settles in a handful of steps. */
const FIT_STEP_BACKSTOP = 64;

/** The ledger block, from sections already built. Pure, for the same reason. */
export function renderAttemptLedgerBlock(sections: string[]): string | null {
  if (sections.length === 0) return null;
  return `${ATTEMPT_LEDGER_HEAD}\n${sections.join('\n\n')}\n${ATTEMPT_LEDGER_TAIL}`;
}

/**
 * Both blocks, from ONE tracker read.
 *
 * `room` is the assembler's own fit result (round 5): the task list is laid out in the room it
 * leaves (`activeTasksRoomTokens`). Absent, the list gets its declared reserve and no more.
 * The attempt ledger is unchanged: its own declared ceiling, enforced at the render.
 */
export async function buildWorkBoardLane(agentId: string, room?: TaskListRoom): Promise<WorkBoardBlocks> {
  let tasks: BoardTask[] = [];
  try {
    const { listTasks } = await import('../tracker/schema.js');
    // In-progress first, then the waiting ones; inside each status the NEWEST task first
    // (round 2, review I1: the active request is never behind an older one).
    const newestFirst = (a: BoardTask, b: BoardTask): number =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    tasks = BOARD_STATUSES.flatMap((status) =>
      (listTasks({ status, assignedTo: agentId }) as unknown as BoardTask[]).sort(newestFirst));
  } catch {
    return { attemptLedger: null, activeTasks: null };   // tracker may not be available
  }
  if (tasks.length === 0) return { attemptLedger: null, activeTasks: null };

  // The attempt ledger keeps its own subject: the work being DONE, i.e. in-progress tasks.
  const inProgress = tasks.filter((t) => t.status === undefined || t.status === 'in_progress');
  return {
    attemptLedger: enforce(await attemptLedgerFrom(inProgress), attemptLedgerWorstCaseTokens()),
    activeTasks: enforce(activeTasksFrom(tasks, activeTasksRoomTokens(room)), activeTasksRoomTokens(room)),
  };
}

/** A post-budget lane may not exceed the room it was given (the ledger: its declared reserve;
 *  the task list: `activeTasksRoomTokens`). `lanes.ts`'s truncate contract applied at the
 *  render, because there is no allocator downstream of a post-budget lane. For the task list it
 *  is a backstop only: `fitTaskList` already lays the block out inside the room. */
function enforce(block: string | null, maxTokens: number): string | null {
  if (!block) return null;
  return estimateTokens(block) > maxTokens ? truncateWrappedText(block, maxTokens) : block;
}

function activeTasksFrom(tasks: BoardTask[], roomTokens: number): string | null {
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
              m.created_at AS created_at, m.conversation_id AS conversation_id, m.seq AS seq,
              COALESCE(c.channel, m.channel) AS channel
         FROM work w
         LEFT JOIN messages m ON m.id = w.source_message_id
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE w.id = ?`,
    );
    // Round 2: when a waiting task entered its state (its own transition record), whether its
    // description was EDITED (its own audit record), and how many newer messages its request's
    // conversation holds (`ix_msg_conv_seq`). All per task, all point/range reads on indexes.
    const sinceStmt = db.prepare(
      `SELECT created_at, json_extract(payload, '$.by') AS by FROM work_events
        WHERE work_id = ? AND kind = 'transition' AND json_extract(payload, '$.to') = ?
        ORDER BY id DESC LIMIT 1`,
    );
    const editedStmt = db.prepare(
      `SELECT 1 AS hit FROM work_events
        WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.action_taken') LIKE 'description_edited%'
        LIMIT 1`,
    );
    const newerStmt = db.prepare(
      `SELECT COUNT(*) AS n, MAX(created_at) AS newest FROM messages
        WHERE conversation_id = ? AND seq > ? AND role = 'user' AND lane <> 'events'`,
    );
    // Round 5: every unfinished task is a candidate (how many are listed is decided by the room,
    // `fitTaskList`); each view is read only when the layout first asks for it.
    const read = (t: BoardTask): TaskView => {
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
      const { origin, conversationId, seq } = readOrigin(originStmt, t.id);
      const isWaiting = t.status === 'paused' || t.status === 'blocked';
      let waiting: TaskView['waiting'] = null;
      if (isWaiting) {
        const state = t.status === 'paused' ? 'paused' : 'blocked';
        const into = sinceStmt.get(t.id, state) as { created_at: number | string; by: string | null } | undefined;
        const since = into?.created_at ?? null;
        const by: WaitingBy = t.status === 'blocked' ? 'blocked'
          : into?.by === 'engine' ? 'engine' : into?.by === 'owner' ? 'owner' : 'other';
        waiting = { since, by };
      }
      const edited = !isWaiting && !!editedStmt.get(t.id);
      let newer: TaskView['newer'] = { count: 0, newestAt: null };
      if (!isWaiting && conversationId && seq !== null) {
        const r = newerStmt.get(conversationId, seq) as { n: number; newest: number | null } | undefined;
        if (r) newer = { count: r.n, newestAt: r.newest };
      }
      return { t, stamp, steps, origin, waiting, edited, newer };
    };
    const seen: TaskView[] = [];
    const viewAt = (i: number): TaskView => (seen[i] ??= read(tasks[i]));
    return fitTaskList(tasks.length, viewAt, roomTokens);
  } catch { return null; }
}

/** The task's origin row, labelled. A failed read is "not linked" only when there is no link;
 *  a link whose row cannot be read reports the link, so the gap is never misnamed. */
function readOrigin(
  stmt: { get: (id: string) => unknown }, taskId: string,
): { origin: TaskOrigin; conversationId: string | null; seq: number | null } {
  const none = { messageId: null, words: null, createdAt: null, label: null };
  try {
    const r = stmt.get(taskId) as {
      message_id: string | null; found_id: string | null; content: string | null;
      created_at: number | string | null; conversation_id: string | null; seq: number | null; channel: string | null;
    } | undefined;
    if (!r?.message_id) return { origin: none, conversationId: null, seq: null };
    if (!r.found_id) return { origin: { ...none, messageId: r.message_id }, conversationId: null, seq: null };
    const party = conversationLabel(r.conversation_id);
    return {
      origin: {
        messageId: r.message_id, words: r.content ?? '', createdAt: r.created_at,
        label: originLabel(party, r.channel), party,
      },
      conversationId: r.conversation_id, seq: r.seq,
    };
  } catch {
    return { origin: none, conversationId: null, seq: null };
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
 * Every cap of `lane.active-tasks` flooded at once, through the REAL `renderTaskLines` +
 * `renderActiveTasksBlock`.
 *
 * ROUND 5 — WHAT THIS NUMBER NOW MEANS. It is the list's GUARANTEE, not its ceiling: the room it
 * is promised however full the conversation is. At run time the list is laid out in
 * `activeTasksRoomTokens` — this reserve (scaled with the ladder on a small window) PLUS what the
 * content fit left unspent — so on a roomy view every request is whole whatever this says. The
 * guarantee is: the declared floor of rows (`rows.tasksFloor`), the three short terms at their
 * declared widths, the closing "N more not shown" line, and `chars.originalWordsFloor` of words.
 *
 * The words term is ONE POOL, so the worst case is the pool spent in full plus the most framing
 * the five lines can carry around it. Round 2 has two line shapes — a current line (request,
 * newer-messages count, edited description) and a waiting line (status, pointer) — so the
 * generator renders EVERY split of the five rows between them and keeps the largest (review M2:
 * a single assumed shape is not a derivation). Within a shape every term is at its widest: the
 * first request is over the cap and spends the whole pool (`shown` + its newline + the cut line),
 * every later request and every edited description is pointer-only, the labels are at their cap,
 * the message ids are 36 chars and the counts are 10 digits. The waiting line takes the wider of
 * the two "waiting on" texts AND the wider status word together — a combination no single row
 * has, so the number is a sound upper bound rather than an exact one, and says so.
 */
export function activeTasksWorstCaseTokens(): number {
  if (activeTasksWorstCase !== null) return activeTasksWorstCase;
  const rows = laneLimit(ACTIVE_TASKS_LANE_ID, 'rows', 'tasksFloor');
  const titleCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'title');
  const wordsCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'originalWordsFloor');
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
  // Mid-month at mid-day, so every box timezone renders a two-digit day and a two-digit hour —
  // the widest `[Sep 15, 2026, 12:41 PM]` shape, with no timezone able to move it.
  const widestInstant = Date.parse('2026-09-15T12:41:00Z');
  // A count no real row reaches (10 digits), substituted into every "continues"/"Newer" line.
  const longest = 9_999_999_999;
  const party = 'l'.repeat(labelCap + 10);
  const caps = declaredCaps();
  // The widest of the four "waiting on" texts, by rendering each through the real `waitingOn`.
  const widestWaitingBy = (['blocked', 'engine', 'owner', 'other'] as const)
    .map((by) => ({ by, len: waitingOn({ origin: { party }, waiting: { since: null, by } } as TaskView, caps).length }))
    .sort((a, b) => b.len - a.len)[0].by;
  const widestWaitingStatus = BOARD_STATUSES.filter((st) => st !== 'in_progress').sort((a, b) => b.length - a.length)[0];
  const view = (waiting: boolean): TaskView => ({
    t: {
      id: 'w'.repeat(36),
      title: 't'.repeat(titleCap + 10),        // over the cap, so the `...` suffix is counted
      priority: 'critical',
      status: waiting ? widestWaitingStatus : 'in_progress',
      description: 'd'.repeat(wordsCap + 1),
      notes: 'n'.repeat(noteCap + 10),
    },
    stamp: widestStamp, steps: widestSteps,
    origin: {
      messageId: 'm'.repeat(36), words: 'w'.repeat(wordsCap + 1),
      createdAt: widestInstant, label: party, party,
    },
    waiting: waiting ? { since: widestInstant, by: widestWaitingBy } : null,
    edited: true,
    newer: { count: longest, newestAt: widestInstant },
  });
  let worst = 0;
  for (let waitingRows = 0; waitingRows <= rows; waitingRows++) {
    const views = Array.from({ length: rows }, (_, i) => view(i >= rows - waitingRows));
    const lines = renderTaskLines(views, wordsCap, caps)
      .map((l) => l.replace(/continues: \d+ more/g, `continues: ${longest} more`));
    // The closing "N more not shown" line at a count no real board reaches.
    worst = Math.max(worst, estimateTokens(renderActiveTasksBlock(lines, longest) ?? ''));
  }
  activeTasksWorstCase = worst;
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
