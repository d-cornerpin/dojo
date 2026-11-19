// The ROUGH TASKS batch: once per dreaming cycle, after the archives, the engine hands the Dreamer the tasks
// that went badly (vault/friction-census.ts) with their timelines and the CUE / LESSON / EVIDENCE / CONFIDENCE
// form, or NO_ENTRY; lessons are recorded through `lesson_record`. Sent as written (`verbatim`), not wrapped
// in the archive-processing instructions.

import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { createLogger } from '../logger.js';
import { estimateTokens } from '../memory/budget.js';
import { timeline } from '../inspect/timeline.js';
import { markLessonCycleStart } from './lessons-store.js';
import { frictionCensus, type FrictionTask } from './friction-census.js';

export interface RoughTasksBatch { ids: string[]; text: string; verbatim: true }

const logger = createLogger('rough-tasks-batch');

const HEADER = [
  'ROUGH TASKS (engine). These tracker tasks went badly since the last cycle. For each one, read its timeline and answer in this form, or write NO_ENTRY if there is nothing to learn:',
  'CUE: the situation that should bring this lesson to mind, in the task\'s own terms',
  'LESSON: one sentence, what to do differently next time',
  'EVIDENCE: the event ids (the #numbers in the timeline) that show it',
  'CONFIDENCE: a number from 0 to 1',
  'Record each answer with lesson_record(task_id, cue, lesson, evidence_event_ids, confidence). A lesson is what a saved technique should have covered; anything else is NO_ENTRY. Lessons are not vault entries: do not save them with vault_remember. Then call complete_task.',
].join('\n');

/** The task's story as the inspect timeline tells it (every record that names the task: its events,
 *  its tool calls and their error fingerprints, receipts, deliveries, messages). The friction events
 *  are marked; over the allowance the oldest unmarked lines go first and the friction stays. */
function timelineOf(task: FrictionTask, allowanceTokens: number): string {
  const friction = new Set(task.eventIds);
  const lines = timeline({ task_id: task.taskId }, getDb()).split('\n').filter((l) => l.startsWith('[')).map((l) => {
    const id = /\bwork_events #(\d+)\b/.exec(l)?.[1];
    const marked = id !== undefined && friction.has(Number(id));
    return { marked, line: marked ? `${l}  <- friction` : l };
  });
  let total = lines.reduce((a, l) => a + estimateTokens(l.line), 0);
  for (let i = 0; i < lines.length && total > allowanceTokens; ) {
    if (lines[i].marked) { i++; continue; }
    total -= estimateTokens(lines[i].line);
    lines.splice(i, 1);
  }
  return lines.map((l) => l.line).join('\n');
}

/** `budgetTokens`: what the Dreamer's batches may hold (maintenance.ts's one batch budget). */
export function buildRoughTasksBatch(sinceMs: number, budgetTokens: number): RoughTasksBatch | null {
  try {
    return buildBatch(sinceMs, budgetTokens);
  } catch (err) {
    // Lessons are a courtesy of the nightly cycle: a fault here must never stop the archives being filed.
    logger.warn('rough-tasks batch could not be built', { error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

function buildBatch(sinceMs: number, budgetTokens: number): RoughTasksBatch | null {
  const rough = frictionCensus(sinceMs);
  if (rough.length === 0) return null;
  markLessonCycleStart();   // the batch starts the cycle the one-lesson-per-task rule counts in
  const db = getDb();
  const allowance = Math.floor(budgetTokens / rough.length);
  const sections = rough.map((t) => {
    const w = db.prepare('SELECT title, goal, state FROM work WHERE id = ?').get(t.taskId) as { title: string | null; goal: string | null; state: string };
    return [
      `── Task ${t.taskId}: ${w.title ?? '(untitled)'} [${w.state}] (rough because: ${t.kinds.join(', ')})`,
      ...(w.goal ? [`Goal: ${w.goal}`] : []),
      'Timeline:',
      timelineOf(t, allowance),
    ].join('\n');
  });
  return { ids: [], text: `${HEADER}\n\n${sections.join('\n\n')}`, verbatim: true };
}

// Where the last census ended: the window is "since the last cycle that finished", kept in the config table;
// the first cycle on a box looks back one nightly cadence (24 hours).
const CURSOR_KEY = 'dreamer.lessons_cursor_ms';
const NIGHTLY_MS = 24 * 60 * 60 * 1000;

export function lessonsCensusSince(now: number = Date.now()): number {
  try {
    const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(CURSOR_KEY) as { value: string } | undefined;
    const at = row ? Number(row.value) : NaN;
    if (Number.isFinite(at)) return at;
  } catch { /* fall through to the first-cycle window */ }
  return now - NIGHTLY_MS;
}

/** The cycle that started at `ms` finished: the next census starts there. */
export function advanceLessonsCensus(ms: number): void {
  try {
    setConfigValue(CURSOR_KEY, String(ms));
  } catch { /* the next census just looks back a little further */ }
}
