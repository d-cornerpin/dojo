// The work-board lanes, below the conversation: `lane.attempt-ledger` and `lane.active-tasks` state the
// work board, so what a tool can mutate must render below the conversation (a mutation above it re-bills
// the whole message array). Post-budget tail lanes, before `msg.turn-context` (the tail's declared order is
// most-stable-first); both render from ONE tracker read and keep distinct lane tags so the receipt and the
// cross-turn gate judge them separately.

import { unscheduled } from './unscheduled-task.js';
import { attemptLedgerFrom, attemptLedgerWorstCaseTokens } from './attempt-ledger.js';
import { getDb } from '../db/connection.js';
import { taskScope, stampColumns } from '../work/tracker-view.js';
import { renderTaskStamps, renderStepFacts, type TaskStampFields } from '../tracker/task-stamps.js';
import { estimateTokens, estimateTokensFromChars, CHARS_PER_TOKEN } from './budget.js';
import { laneLimit, renderTokens, POST_BUDGET_LANES } from './lanes.js';
import { recordedInstant } from './message-stamp.js';
import { readMeasureFacts, formatMeasureLine, type MeasureFacts } from '../work/measure-view.js';
import { MEASURE_TOOLS } from '../work/measure.js';
import { planStepLineOf } from '../work/plan-store.js';
import { conversationLabel } from './party-label.js';
import {
  capLabel, originLabel, spend, laterSection, readLaterMessages,
  type WordsPool, type TermCaps, type ListedMessage,
} from './task-list-words.js';

export const ACTIVE_TASKS_LANE_ID = 'lane.active-tasks';

export interface BoardTask {
  id: string;
  title: string;
  priority: string;
  description: string | null;
  notes: string | null;
  status?: string;
  hold?: 'paused' | 'blocked' | null;
  createdAt?: string;
}

/** Which tasks the list carries: every unfinished task assigned to the agent, in-progress first. A waiting
 *  task is still current (its words are owed), so it is shown and labelled. `buildWorkBoardLane` adds the
 *  unscheduled `on_deck` tasks; scheduled ones are the scheduler's to bring back. */
export const BOARD_STATUSES = ['in_progress', 'blocked', 'paused'] as const;

/** What was asked, read through the task's link to the row that carried it (`work.source_message_id`).
 *  `messageId` null = no link; `words` null with a `messageId` = the row is no longer stored. */
export interface TaskOrigin {
  messageId: string | null;
  words: string | null;
  createdAt: number | string | null;
  label: string | null;
  party?: string | null;
}

interface TaskView {
  t: BoardTask;
  stamp: string | null;
  steps: string | null;
  origin: TaskOrigin;
  /** A paused/blocked task: since when, and who put it there (the words are chosen at render). */
  waiting: { since: number | string | null; by: WaitingBy } | null;
  edited: boolean;
  newer: { count: number; newestAt: number | string | null };
  /** Later owner messages linked to this task (recorded links, oldest first); empty for a waiting task. */
  laters: ListedMessage[];
  /** The request message is in the live conversation this assembly emitted, so the line points to it. */
  inView?: boolean;
  measure?: MeasureFacts | null;
  planLine?: string | null;
}

type WaitingBy = 'blocked' | 'engine' | 'owner' | 'other' | 'later';

/** `WHOLE` when the view holds everything; the declared `LANE_LIMITS` widths when it cannot. */
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
const ACTIVE_TASKS_HEAD_COMPACT = '═══ YOUR ACTIVE TASKS (from tracker, ground truth) ═══';

/**
 * The task lines, in block order, from views already read, spending `poolChars` of words and printing the
 * short terms at `caps`. A current task prints the requester's words verbatim; a waiting task prints a
 * status line and a pointer and spends nothing. The pool is spent in passes (later messages newest first,
 * then the original requests, then edited descriptions), so the owner's newest words are paid first; they
 * still print after the original, in the order sent.
 */
function renderTaskLines(views: TaskView[], poolChars: number, caps: TermCaps): string[] {
  const pool: WordsPool = { remaining: poolChars };
  const requestOf = new Map<number, string>();
  const editedOf = new Map<number, string>();
  const laterOf = new Map<number, string>();
  views.forEach((v, i) => { if (!v.waiting && v.laters.length > 0) laterOf.set(i, laterSection(v.laters, pool, caps)); });
  views.forEach((v, i) => { if (!v.waiting) requestOf.set(i, requestSection(v, pool, caps)); });
  views.forEach((v, i) => {
    if (!v.waiting && v.edited && v.t.description && v.origin.messageId && v.origin.words !== null) {
      editedOf.set(i, '\n  The task\'s own description (as last edited):\n' + spend(v.t.description, pool,
        '  [end of description]',
        (more) => `  [description continues: ${more} more characters, not shown]`));
    }
  });
  return views.map((v, i) => taskLine(v, (requestOf.get(i) ?? '') + (laterOf.get(i) ?? ''), editedOf.get(i) ?? '', caps));
}

function taskLine(v: TaskView, req: string, edited: string, caps: TermCaps): string {
  const { t } = v;
  const title = t.title.length > caps.title ? `${t.title.slice(0, caps.title)}...` : t.title;
  let line = `• ${title} (ID: ${t.id.slice(0, 8)}, priority: ${t.priority})`;
  if (v.waiting) {
    line += `\n  Status: ${t.hold ?? t.status} since ${recordedInstant(v.waiting.since)}: ${waitingOn(v, caps)}. `
      + 'Not current work: do not resume it unless asked.';
  }
  if (v.stamp) line += `\n  State: ${v.stamp}${v.steps ? ` | ${v.steps}` : ''}`;
  if (v.measure && !v.waiting) line += `\n  ${formatMeasureLine(v.measure, caps.title)}`;
  if (v.planLine && !v.waiting) line += `\n  ${v.planLine.length > caps.note ? `${v.planLine.slice(0, caps.note)}...` : v.planLine}`;   // the plan's words, cut at the note width only when the room is short
  line += v.waiting ? pointerLine(v.origin, caps) : req + newerLine(v) + edited;
  if (t.notes) {
    const lastNote = t.notes.split('\n').filter(Boolean).pop();
    if (lastNote) line += `\n  Last note: ${lastNote.slice(0, caps.note)}`;
  }
  return line;
}

/** The hold's own actor tells the engine's "waiting on the person" from the owner pausing the job. */
function waitingOn(v: TaskView, caps: TermCaps): string {
  switch (v.waiting?.by) {
    case 'blocked': return 'waiting on what blocked it (its last note says what)';
    case 'engine': return `waiting on ${capLabel(v.origin.party, 'the person who asked', caps)} to answer`;
    case 'owner': return 'paused by the owner';
    case 'later': return 'set aside for later with no time set — resume it when asked';
    default: return 'paused by whoever paused it';
  }
}

function requestSection(v: TaskView, pool: WordsPool, caps: TermCaps): string {
  const { t, origin } = v;
  if (v.inView && origin.messageId) {
    return `\n  Original request (from ${capLabel(origin.label, 'a conversation with no recorded label', caps)}, `
      + `${recordedInstant(origin.createdAt)}): it is in the conversation above, message ${origin.messageId}; `
      + 'read it there, it is not repeated here.';
  }
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

function hiddenLine(hidden: number): string {
  return `…and ${hidden} more unfinished task${hidden === 1 ? '' : 's'} not shown here: this view has `
    + 'no room left for them. work_update(action="list") lists every task.';
}

export function renderActiveTasksBlock(lines: string[], hidden = 0): string | null {
  if (lines.length === 0) return null;
  const more = hidden > 0 ? `\n\n${hiddenLine(hidden)}` : '';
  return `${ACTIVE_TASKS_HEAD}\n${lines.join('\n\n')}${more}\n\n${ACTIVE_TASKS_TAIL}`;
}

// The room the whole array leaves: the list is laid out in what the provider boundary's budget (the
// assembly budget minus the system prompt, `assembly-validation.ts`) has left after everything already on
// the array (the messages and every post-budget block, the ledger included) and the loop's own appends at
// their declared bounds. The board is read last of the assembler's post-budget blocks, because other late
// blocks can exceed their reserves. `compactBlock` is emitted even into a room smaller than itself: hiding
// every task is not an option. Nothing new is reserved and the content budget never moves, so the cached
// region's bytes are unchanged; only this uncached block flexes.

export interface TaskListView {
  availableTokens: number;
  emitted: ReadonlyArray<{ role: string; content: unknown }>;
  blocks: ReadonlyArray<string | null | undefined>;
  liveRows: ReadonlyArray<{ id: string }>;
  loopTailExtraTokens?: number;
}

function declaredReserveTokens(): number {
  const lane = POST_BUDGET_LANES.find((l) => l.id === ACTIVE_TASKS_LANE_ID);
  return lane ? lane.reserveTokens : activeTasksWorstCaseTokens();
}
const reserveOf = (id: string): number => POST_BUDGET_LANES.find((l) => l.id === id)?.reserveTokens ?? 0;

/** Accounting bounds on the technique injector's `MAX_INLINE_CHARS` and framing (`technique-hints.ts`),
 *  pinned by `the-whole-array-holds-with-a-technique.test.ts`. */
export const TECHNIQUE_INLINE_CHARS = 25_000;
export const TECHNIQUE_FRAME_CHARS = 512;

/** The most a strong technique match can add after this assembly: the largest injection any published
 *  technique this agent may use would produce. Counted on every call (an upper bound). */
async function techniqueAllowanceTokens(agentId: string): Promise<number> {
  try {
    const { listTechniques, getTechniqueDetail } = await import('../techniques/store.js');
    const { mayUseTechnique } = await import('../agent/access/read.js');
    let worst = 0;
    for (const t of listTechniques({ state: 'published' })) {
      if (!mayUseTechnique(agentId, t.id)) continue;
      const md = getTechniqueDetail(t.id)?.instructions ?? '';
      if (md.length === 0) continue;
      worst = Math.max(worst, TECHNIQUE_FRAME_CHARS + 2 * t.name.length + t.id.length
        + (md.length > TECHNIQUE_INLINE_CHARS ? 0 : md.length));
    }
    return estimateTokensFromChars(worst);
  } catch {
    return estimateTokensFromChars(TECHNIQUE_FRAME_CHARS + TECHNIQUE_INLINE_CHARS);   // unreadable: the bound
  }
}

async function activeTasksRoomTokens(agentId: string, view: TaskListView | undefined, ledger: string | null): Promise<number> {
  if (!view) return declaredReserveTokens();
  const onTheArray = renderTokens(view.emitted as never)
    + view.blocks.reduce((t, b) => t + (b ? estimateTokens(b) : 0), 0)
    + (ledger ? estimateTokens(ledger) : 0);
  const loopAppends = reserveOf('lane.loop-tail') + (view.loopTailExtraTokens ?? 0) + reserveOf('lane.deliveries') + await techniqueAllowanceTokens(agentId);
  return Math.max(0, view.availableTokens - onTheArray - loopAppends);
}

/** Is the task's request already in view? True when its message is a live row this assembly kept and its
 *  words are on the emitted array verbatim (a later pass can remove a kept row; the id alone is no proof);
 *  its line then points to it, so the agent reads the words exactly once. */
function inViewCheck(view: TaskListView | undefined): (origin: TaskOrigin) => boolean {
  if (!view) return () => false;
  const live = new Set(view.liveRows.map((r) => r.id));
  let texts: string[] | null = null;
  const emittedTexts = (): string[] => texts ??= view.emitted.filter((m) => m.role === 'user').map((m) =>
    typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((b) => (b as { text?: unknown }).text).filter((x) => typeof x === 'string').join('\n')
        : '');
  return (origin) => !!origin.messageId && origin.words !== null && live.has(origin.messageId)
    && emittedTexts().some((t) => t.includes(origin.words as string));
}

/**
 * Lay the list out in `roomTokens`, in order of value: (1) everything whole when it fits; (2) otherwise the
 * short terms take their declared widths, the declared floor of rows is listed, more rows only while every
 * request still fits whole, the rest counted in a closing line; (3) the words get every character left, the
 * pool stepping down by exactly the overshoot (a pool character moves the block by at most one character).
 */
function fitTaskList(count: number, viewAt: (i: number) => TaskView, roomTokens: number): string | null {
  if (count === 0) return null;
  const roomChars = roomTokens * CHARS_PER_TOKEN;
  const views = (n: number) => Array.from({ length: n }, (_, i) => viewAt(i));
  const blockChars = (lineChars: number[], hidden: number) =>
    (renderActiveTasksBlock(['x'], hidden) ?? '').length - 1
    + lineChars.reduce((a, b) => a + b, 0) + 2 * (lineChars.length - 1);
  // A line at an unlimited or an empty pool does not depend on its neighbours, so rows grow one at a time.
  const lineChars = (i: number, pool: number, caps: TermCaps) =>
    renderTaskLines([viewAt(i)], pool, caps)[0].length;

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

  const shown = views(n);
  let pool = roomChars;
  let block = renderActiveTasksBlock(renderTaskLines(shown, pool, caps), count - n) ?? '';
  for (let step = 0; block.length > roomChars && pool > 0 && step < FIT_STEP_BACKSTOP; step++) {
    pool = Math.max(0, pool - (block.length - roomChars));
    block = renderActiveTasksBlock(renderTaskLines(shown, pool, caps), count - n) ?? '';
  }
  return block.length > roomChars ? compactBlock(count) : block;
}

function compactBlock(count: number): string {
  return `${ACTIVE_TASKS_HEAD_COMPACT}\nYou have ${count} unfinished task${count === 1 ? '' : 's'}; this view has no room `
    + 'left to list them. work_update(action="list") lists every task.\n' + ACTIVE_TASKS_TAIL;
}

/** A backstop on the step-down above, not what decides the words: a real list settles in a few steps. */
const FIT_STEP_BACKSTOP = 64;

/** Both blocks, from ONE tracker read. `view` is the array so far, so the list is laid out in the room the
 *  whole array leaves and points to requests already in view; absent, it gets its declared reserve. */
export async function buildWorkBoardLane(agentId: string, view?: TaskListView): Promise<WorkBoardBlocks> {
  let tasks: BoardTask[] = [];
  try {
    const { listTasks } = await import('../tracker/schema.js');
    const newestFirst = (a: BoardTask, b: BoardTask): number =>
      (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    tasks = BOARD_STATUSES.flatMap((status) =>
      (listTasks({ status, assignedTo: agentId }) as unknown as BoardTask[]).filter((t) => status !== 'in_progress' || !t.hold).sort(newestFirst));
    // An on_deck task with NO schedule is waiting, not queued (nothing will bring it back), so it is
    // listed.
    tasks.push(...(listTasks({ status: 'on_deck', assignedTo: agentId }) as unknown as BoardTask[]).filter((t) => !t.hold && unscheduled(t.id)).sort(newestFirst));
  } catch {
    return { attemptLedger: null, activeTasks: null };   // tracker may not be available
  }
  if (tasks.length === 0) return { attemptLedger: null, activeTasks: null };

  const inProgress = tasks.filter((t) => t.status !== 'on_deck' && !t.hold);
  // The list is laid out in the whole room first; the ledger gets what it leaves unspent, never less than
  // its own guarantee (`attemptLedgerWorstCaseTokens`), and the list is laid out again in the rest when it
  // took it all.
  const room = await activeTasksRoomTokens(agentId, view, null);
  const inView = inViewCheck(view);
  const wholeList = activeTasksFrom(tasks, room, inView);
  const listTokens = wholeList ? estimateTokens(wholeList) : 0;
  const ledgerRoom = Math.max(0, Math.min(room, Math.max(attemptLedgerWorstCaseTokens(), room - listTokens)));
  const attemptLedger = await attemptLedgerFrom(inProgress, ledgerRoom);
  const ledgerTokens = attemptLedger ? estimateTokens(attemptLedger) : 0;
  const activeTasks = listTokens + ledgerTokens <= room ? wholeList : activeTasksFrom(tasks, Math.max(0, room - ledgerTokens), inView);
  return { attemptLedger, activeTasks };
}

function activeTasksFrom(tasks: BoardTask[], roomTokens: number, inView: (o: TaskOrigin) => boolean): string | null {
  try {
    const db = getDb();
    const stampStmt = db.prepare(
      `SELECT w.id AS id, ${stampColumns('w')},
              w.step_number AS step_number, w.total_steps AS total_steps,
              w.parent_id AS project_id
         FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
    );
    // The request the task exists for, through the task->row edge: one PK read per task.
    const originStmt = db.prepare(
      `SELECT w.source_message_id AS message_id, m.id AS found_id, m.content AS content,
              m.created_at AS created_at, m.conversation_id AS conversation_id, m.seq AS seq,
              COALESCE(c.channel, m.channel) AS channel
         FROM work w
         LEFT JOIN messages m ON m.id = w.source_message_id
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE w.id = ?`,
    );
    // Per task, all point/range reads on indexes: hold or Open entry time, an edited description, newer
    // messages.
    const sinceStmt = db.prepare(
      `SELECT created_at, CASE WHEN kind = 'audit' THEN actor ELSE json_extract(payload, '$.by') END AS by FROM work_events
        WHERE work_id = ? AND ((kind = 'audit' AND json_extract(payload, '$.entry_kind') = 'hold_set' AND ? = 1)
          OR (kind = 'transition' AND json_extract(payload, '$.to') = 'open' AND ? = 0))
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
    const read = (t: BoardTask): TaskView => {
      let stamp: string | null = null;
      let steps: string | null = null;
      try {
        const st = stampStmt.get(t.id) as TaskStampFields | undefined;
        if (st) {
          // The recorded instant, never `relAgo(...)`: a block that depends on the wall clock has no stable
          // bytes to assert, and `msg.current-time` already gives the agent the time to subtract from.
          stamp = renderTaskStamps(st, { relative: false });
          steps = renderStepFacts(st);
        }
      } catch { /* stamps are best-effort */ }
      const { origin, conversationId, seq } = readOrigin(originStmt, t.id);
      const isWaiting = !!t.hold || t.status === 'on_deck';
      let waiting: TaskView['waiting'] = null;
      if (isWaiting) {
        const held = t.hold ? 1 : 0;
        const into = sinceStmt.get(t.id, held, held) as { created_at: number | string; by: string | null } | undefined;
        const since = into?.created_at ?? null;
        const by: WaitingBy = t.hold === 'blocked' ? 'blocked' : !t.hold ? 'later'
          : into?.by === 'engine' ? 'engine' : into?.by === 'owner' ? 'owner' : 'other';
        waiting = { since, by };
      }
      const edited = !isWaiting && !!editedStmt.get(t.id);
      let newer: TaskView['newer'] = { count: 0, newestAt: null };
      if (!isWaiting && conversationId && seq !== null) {
        const r = newerStmt.get(conversationId, seq) as { n: number; newest: number | null } | undefined;
        if (r) newer = { count: r.n, newestAt: r.newest };
      }
      const laters = isWaiting ? [] : readLaterMessages(t.id).map((m) => ({ ...m, inView: inView(m) }));
      let measure: MeasureFacts | null = null;
      try { measure = isWaiting ? null : readMeasureFacts(t.id); } catch { /* progress is best-effort, like the stamps */ }
      let planLine: string | null = null;
      try { planLine = isWaiting ? null : planStepLineOf(t.id); } catch { /* the plan line is best-effort, like the stamps */ }
      return { t, stamp, steps, origin, waiting, edited, newer, laters, inView: !isWaiting && inView(origin), measure, planLine };
    };
    const seen: TaskView[] = [];
    const viewAt = (i: number): TaskView => (seen[i] ??= read(tasks[i]));
    return fitTaskList(tasks.length, viewAt, roomTokens);
  } catch { return null; }
}

/** The task's origin row, labelled; a link whose row cannot be read still reports the link. */
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

// Each reserve is derived by feeding the REAL block renderers a board with every declared cap flooded at
// once (the `recallLaneWorstCaseTokens` discipline); tests pin each literal in `POST_BUDGET_LANES` to it.

let activeTasksWorstCase: number | null = null;

/**
 * Every cap of `lane.active-tasks` flooded at once, through the REAL `renderTaskLines` and block renderer.
 * It is the list's guarantee, not its ceiling. The words are ONE pool: the worst case spends it in full
 * plus the most framing, over every split of rows between the three line shapes, each term at its widest.
 * The waiting line takes the wider text and status word together: a sound upper bound.
 */
export function activeTasksWorstCaseTokens(): number {
  if (activeTasksWorstCase !== null) return activeTasksWorstCase;
  const rows = laneLimit(ACTIVE_TASKS_LANE_ID, 'rows', 'tasksFloor');
  const titleCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'title');
  const wordsCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'originalWordsFloor');
  const labelCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'originLabel');
  const noteCap = laneLimit(ACTIVE_TASKS_LANE_ID, 'chars', 'lastNote');
  const widestStamp = renderTaskStamps({
    last_answered_turn: 999_999, last_answered_at: '2026-09-30T23:41:59.999Z',
    last_delivery_summary: 'x'.repeat(200), revert_count: 99,
    step_number: 99, total_steps: 99, project_id: 'p'.repeat(36),
  } as unknown as TaskStampFields, { relative: false }) ?? '';
  const widestSteps = renderStepFacts({
    step_number: 99, total_steps: 99, project_id: 'p'.repeat(36),
  } as unknown as TaskStampFields) ?? '';
  // Mid-month at mid-day, so every box timezone renders a two-digit day and a two-digit hour (the widest
  // instant).
  const widestInstant = Date.parse('2026-09-15T12:41:00Z');
  const longest = 9_999_999_999;
  const party = 'l'.repeat(labelCap + 10);
  // The widest Progress line, by CALLING its formatter on each shape with every term and count at its
  // widest.
  const longestTool = [...MEASURE_TOOLS].sort((a, b) => b.length - a.length)[0];
  const flooded = { tool: longestTool, args: { query: 'q'.repeat(titleCap + 10) }, unit: 'u'.repeat(titleCap + 10) };
  const widestMeasure = ([
    { measure: flooded, initial: longest, remaining: longest, at: widestInstant, touched: longest },
    { measure: flooded, initial: longest, remaining: null, at: widestInstant, touched: longest },
    { measure: null, initial: null, remaining: null, at: null, touched: longest },
  ] as MeasureFacts[]).sort((a, b) => formatMeasureLine(b, titleCap).length - formatMeasureLine(a, titleCap).length)[0];
  const caps = declaredCaps();
  const widestWaitingBy = (['blocked', 'engine', 'owner', 'other', 'later'] as const)
    .map((by) => ({ by, len: waitingOn({ origin: { party }, waiting: { since: null, by } } as TaskView, caps).length }))
    .sort((a, b) => b.len - a.len)[0].by;
  const widestWaitingStatus = [...BOARD_STATUSES.filter((st) => st !== 'in_progress'), 'on_deck'].sort((a, b) => b.length - a.length)[0];
  const view = (shape: 'current' | 'waiting' | 'inView', newestLen = wordsCap + 1): TaskView => ({
    t: {
      id: 'w'.repeat(36),
      title: 't'.repeat(titleCap + 10),        // over the cap, so the `...` suffix is counted
      priority: 'critical',
      status: shape === 'waiting' ? widestWaitingStatus : 'in_progress',
      description: 'd'.repeat(wordsCap + 1),
      notes: 'n'.repeat(noteCap + 10),
    },
    stamp: widestStamp, steps: widestSteps,
    origin: {
      messageId: 'm'.repeat(36), words: 'w'.repeat(wordsCap + 1),
      createdAt: widestInstant, label: party, party,
    },
    waiting: shape === 'waiting' ? { since: widestInstant, by: widestWaitingBy } : null,
    edited: true,
    newer: { count: longest, newestAt: widestInstant },
    // Two later messages, the newest paid first: a long one drains the pool and the older collapses to one
    // line; a shorter newest leaves a remainder that the older spends as a head, a few characters and a cut
    // line.
    laters: shape === 'waiting' ? [] : [wordsCap + 1, newestLen].map((len) => ({
      messageId: 'l'.repeat(36), words: 'w'.repeat(len), createdAt: widestInstant, label: party,
      inView: shape === 'inView',
    })),
    inView: shape === 'inView',
    measure: widestMeasure,
    planLine: 'p'.repeat(noteCap + 10),   // a plan line over the note width, so the cut and its `...` are counted
  });
  let worst = 0;
  for (let waitingRows = 0; waitingRows <= rows; waitingRows++) for (let inViewRows = 0; inViewRows <= rows - waitingRows; inViewRows++) {
    // The first row's newest later message is swept across every length that leaves a remainder in the
    // pool.
    const lengths = [wordsCap + 1];
    for (let len = wordsCap - 800; len <= wordsCap; len += 25) lengths.push(len);
    for (const newestLen of lengths) {
      let firstCurrent = true;
      const views = Array.from({ length: rows }, (_, i) => {
        const shape = i >= rows - waitingRows ? 'waiting' : i >= rows - waitingRows - inViewRows ? 'inView' : 'current';
        const v = view(shape, firstCurrent ? newestLen : wordsCap + 1);
        if (shape !== 'waiting') firstCurrent = false;
        return v;
      });
      const lines = renderTaskLines(views, wordsCap, caps)
        .map((l) => l.replace(/continues: \d+ more/g, `continues: ${longest} more`)
          .replace(/\[\d+ older later message/g, `[${longest} older later message`));
      worst = Math.max(worst, estimateTokens(renderActiveTasksBlock(lines, longest) ?? ''));
    }
  }
  activeTasksWorstCase = worst;
  return activeTasksWorstCase;
}
