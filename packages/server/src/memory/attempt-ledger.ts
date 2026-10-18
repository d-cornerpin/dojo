// ════════════════════════════════════════════════════════════════════════════════════════
// THE ATTEMPT LEDGER — the engine's record of work on the agent's in-progress tasks, laid out in the room
// the array leaves (t207, D6). It was a fixed shape (800 tokens, 2 tasks, 4 notes + 4 transitions, 6 entries
// each); it is now every in-progress task and as many entries of each as fit, newest first, with a counted
// line where entries are left off. A post-budget TAIL lane: no cached prefix byte moves with it.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { revertCountExpr } from '../work/tracker-view.js';
import { estimateTokens, CHARS_PER_TOKEN } from './budget.js';
import { laneLimit, truncateWrappedText } from './lanes.js';
import type { BoardTask } from './work-board-lane.js';

export const ATTEMPT_LEDGER_LANE_ID = 'lane.attempt-ledger';

const ATTEMPT_LEDGER_HEAD =
  '═══ ATTEMPT LEDGER (engine record of work on your active tasks, do not repeat attempts '
  + 'already logged here) ═══';
const ATTEMPT_LEDGER_TAIL = '═══ END ATTEMPT LEDGER ═══';

/** The ledger block, from sections already built. Pure, for the same reason. */
export function renderAttemptLedgerBlock(sections: string[]): string | null {
  if (sections.length === 0) return null;
  return `${ATTEMPT_LEDGER_HEAD}\n${sections.join('\n\n')}\n${ATTEMPT_LEDGER_TAIL}`;
}

let attemptLedgerWorstCase: number | null = null;

/** What one task contributes to the ledger. Entries ascend (oldest first), as they are printed. */
interface LedgerTask {
  task: BoardTask;
  title: string;
  revertNote: string;
  entries: Array<{ at: string; line: string; isObservation: boolean }>;
  /** The longest the pointer line to the task's notes can be (computed as if none were shown). */
  notesPointerChars: number;
}

/** The task title as the ledger prints it: one identifier, cut at the list's own title width. */
function ledgerTitle(title: string): string {
  const cap = laneLimit(ATTEMPT_LEDGER_LANE_ID, 'chars', 'title');
  return title.length > cap ? `${title.slice(0, cap)}...` : title;
}

/** One entry line, whole, or cut to `width` characters with the cut said out loud. */
function entryLine(line: string, width: number): string {
  const text = `  ${line}`;
  if (text.length <= width) return text;
  const keep = Math.max(0, width - 80);
  return `${text.slice(0, keep)} … [cut: ${keep} of ${text.length} chars shown]`;
}

/** The "earlier entries" pointer a task carries when some of its entries are left off. */
const earlierLine = (n: number): string => `  (${n} earlier entr${n === 1 ? 'y' : 'ies'} not shown)\n`;

/**
 * The ledger in `roomTokens`: every in-progress task that has entries, and as many entries of each as fit,
 * newest first, with a counted line where entries are left off (t207: no fixed rows, no token cap).
 *   1. each task gets its newest entry (cut to its share of the room if one entry alone is longer);
 *   2. further entries, newest first across all tasks, are added whole while they fit — the first one that
 *      does not fit ends it, so every task's list is a contiguous newest run;
 *   3. a task is left off only when even its newest entry does not fit; those are counted, never silent.
 */
export async function attemptLedgerFrom(tasks: BoardTask[], roomTokens: number): Promise<string | null> {
  try {
    const { getRecentObservations, getRecentTransitions, formatEntryLine } = await import('../tracker/task-log.js');
    const { moreNotesLine } = await import('../tracker/task-notes-view.js');
    const all = Number.MAX_SAFE_INTEGER;
    const ledgerTasks: LedgerTask[] = [];
    for (const task of tasks) {
      const entries = [
        ...getRecentObservations(task.id, all).map((e) => ({ e, isObservation: true })),
        ...getRecentTransitions(task.id, all).map((e) => ({ e, isObservation: false })),
      ].sort((a, b) => a.e.createdAt.localeCompare(b.e.createdAt) || Number(a.e.id) - Number(b.e.id))
        .map(({ e, isObservation }) => ({ at: e.createdAt, line: formatEntryLine(e), isObservation: e.entryKind === 'observation' && isObservation }));
      if (entries.length === 0) continue;
      let revertNote = '';
      try {
        const row = getDb().prepare(`SELECT ${revertCountExpr('w')} AS revert_count FROM work w WHERE w.id = ?`)
          .get(task.id) as { revert_count: number | null } | undefined;
        if (row?.revert_count) revertNote = `, reverted ${row.revert_count}x already`;
      } catch { /* column may not exist on old DBs */ }
      let notesPointerChars = 0;
      try { notesPointerChars = moreNotesLine(task.id, 0).length; } catch { /* a convenience */ }
      ledgerTasks.push({ task, title: ledgerTitle(task.title), revertNote, entries, notesPointerChars });
    }
    if (ledgerTasks.length === 0) return null;

    const roomChars = Math.max(0, Math.floor(roomTokens * CHARS_PER_TOKEN));
    const frame = (renderAttemptLedgerBlock(['']) ?? '').length - 1;
    const header = (lt: LedgerTask): number => `Task "${lt.title}"${lt.revertNote}:\n`.length;

    // The state: how many of the newest entries each listed task shows, and how many tasks are listed.
    const take = ledgerTasks.map(() => 1);
    let listed = ledgerTasks.length;
    const lineLen = (i: number, k: number, width: number): number => {   // the k-th newest entry of task i
      const lt = ledgerTasks[i];
      return entryLine(lt.entries[lt.entries.length - 1 - k].line, k === 0 ? width : Infinity).length + 1;
    };
    // The width a task's guaranteed newest entry may take: its share of what the frame and headers leave.
    const shareWidth = (n: number): number => {
      const fixed = frame + ledgerTasks.slice(0, n).reduce((a, lt) => a + header(lt) + lt.notesPointerChars + 60, 0) + 2 * n + 80;
      return Math.max(laneLimit(ATTEMPT_LEDGER_LANE_ID, 'chars', 'entryFloor'), Math.floor((roomChars - fixed) / Math.max(1, n)));
    };
    const sectionChars = (i: number, width: number): number => {
      const lt = ledgerTasks[i];
      const hidden = lt.entries.length - take[i];
      let n = header(lt) + (hidden > 0 ? lt.notesPointerChars + earlierLine(hidden).length : 0);
      for (let k = 0; k < take[i]; k++) n += lineLen(i, k, width);
      return n;
    };
    const leftOffLine = (n: number): number => (n > 0 ? `\n… ${n} more in-progress task${n === 1 ? '' : 's'} with entries not shown`.length : 0);
    const total = (width: number): number => {
      let n = frame + leftOffLine(ledgerTasks.length - listed);
      for (let i = 0; i < listed; i++) n += sectionChars(i, width) + (i > 0 ? 2 : 0);
      return n;
    };

    // 1+3. every task gets its newest entry; when even that does not fit, the oldest tasks are left off.
    let width = shareWidth(listed);
    while (listed > 1 && total(width) > roomChars) { listed--; width = shareWidth(listed); }
    // 2. more entries, newest first across the listed tasks, while they fit whole.
    for (;;) {
      let pick = -1;
      let pickAt = '';
      for (let i = 0; i < listed; i++) {
        const next = ledgerTasks[i].entries.length - 1 - take[i];
        if (next < 0) continue;
        const at = ledgerTasks[i].entries[next].at;
        if (pick === -1 || at > pickAt) { pick = i; pickAt = at; }
      }
      if (pick === -1) break;
      take[pick]++;
      if (total(width) > roomChars) { take[pick]--; break; }
    }

    const sections: string[] = [];
    for (let i = 0; i < listed; i++) {
      const lt = ledgerTasks[i];
      const hidden = lt.entries.length - take[i];
      const shown = lt.entries.slice(lt.entries.length - take[i]);
      let moreNotes = '';
      try { moreNotes = moreNotesLine(lt.task.id, shown.filter((e) => e.isObservation).length); } catch { /* a convenience */ }
      const lines = shown.map((e, k) => entryLine(e.line, k === shown.length - 1 ? width : Infinity));
      sections.push(`Task "${lt.title}"${lt.revertNote}:\n${hidden > 0 ? earlierLine(hidden) : ''}${moreNotes}${lines.join('\n')}`);
    }
    if (listed < ledgerTasks.length) {
      const n = ledgerTasks.length - listed;
      sections.push(`… ${n} more in-progress task${n === 1 ? '' : 's'} with entries not shown`);
    }
    const block = renderAttemptLedgerBlock(sections);
    // A last guard, for the estimate the pointer lines were sized with: never past the room.
    return block && estimateTokens(block) > roomTokens ? truncateWrappedText(block, roomTokens) : block;
  } catch { return null; /* tracker may be empty or absent */ }
}

/**
 * The ledger's GUARANTEE, derived by calling its renderer on the smallest block it promises: the frame, one
 * task whose title is at the title width and which carries a revert note, a pointer to its notes, the
 * "earlier entries" line, and its newest entry at the entry floor. It is what the budget sets aside for the
 * ledger on every assembly (`POST_BUDGET_LANES`) and the least it is ever laid out in; on a roomy window the
 * ledger is far larger, in the room the list leaves. t207: it replaces the 800-token ceiling it was before.
 */
export function attemptLedgerWorstCaseTokens(): number {
  if (attemptLedgerWorstCase !== null) return attemptLedgerWorstCase;
  const title = 't'.repeat(laneLimit(ATTEMPT_LEDGER_LANE_ID, 'chars', 'title')) + '...';
  const entry = entryLine('e'.repeat(laneLimit(ATTEMPT_LEDGER_LANE_ID, 'chars', 'entryFloor')), Infinity);
  const pointer = `  (${'9'.repeat(10)} more notes on this task are not shown here: work_update(action="get", id="${'i'.repeat(36)}") reads every note, oldest first.)\n`;
  const section = `Task "${title}", reverted ${'9'.repeat(2)}x already:\n${earlierLine(9_999_999_999)}${pointer}${entry}`;
  const left = `… ${'9'.repeat(10)} more in-progress tasks with entries not shown`;
  attemptLedgerWorstCase = estimateTokens(renderAttemptLedgerBlock([section, left]) ?? '');
  return attemptLedgerWorstCase;
}
