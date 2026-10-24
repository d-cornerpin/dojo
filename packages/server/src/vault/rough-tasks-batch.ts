// ════════════════════════════════════════
// The ROUGH TASKS batch (K34): once per dreaming cycle, after the archives, the engine hands the
// Dreamer the tasks that went badly (vault/friction-census.ts), each with its timeline, and the
// four-line form to fill: CUE / LESSON / EVIDENCE / CONFIDENCE, or NO_ENTRY. The Dreamer records
// each lesson through `lesson_record`. The batch is sent as written (`verbatim`), not wrapped in
// the archive-processing instructions, because it is not an archive.
// ════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { estimateTokens } from '../memory/budget.js';
import { frictionCensus, type FrictionTask } from './friction-census.js';

export interface RoughTasksBatch { ids: string[]; text: string; verbatim: true }

const logger = createLogger('rough-tasks-batch');

interface EventRow { id: number; kind: string; actor: string; payload: string | null; created_at: number }

const HEADER = [
  'ROUGH TASKS (engine). These tracker tasks went badly since the last cycle. For each one, read its timeline and answer in this form, or write NO_ENTRY if there is nothing to learn:',
  'CUE: the situation that should bring this lesson to mind, in the task\'s own terms',
  'LESSON: one sentence, what to do differently next time',
  'EVIDENCE: the event ids (the #numbers in the timeline) that show it',
  'CONFIDENCE: a number from 0 to 1',
  'Record each answer with lesson_record(task_id, cue, lesson, evidence_event_ids, confidence, component), where component says what should change: technique, door_text (a tool\'s or refusal\'s wording), soul (an agent\'s instructions) or engine. Lessons are not vault entries: do not save them with vault_remember. Then call complete_task.',
].join('\n');

function timelineOf(task: FrictionTask, allowanceTokens: number): string {
  const rows = getDb().prepare(
    'SELECT id, kind, actor, payload, created_at FROM work_events WHERE work_id = ? ORDER BY id',
  ).all(task.taskId) as EventRow[];
  const friction = new Set(task.eventIds);
  const lines = rows.map((r) => ({
    id: r.id,
    line: `#${r.id} ${new Date(r.created_at).toISOString().slice(0, 16).replace('T', ' ')} ${r.kind} (${r.actor})${r.payload ? ` ${r.payload}` : ''}${friction.has(r.id) ? '  <- friction' : ''}`,
  }));
  // Over the allowance: drop the oldest lines that are not friction. The friction itself stays.
  let total = lines.reduce((a, l) => a + estimateTokens(l.line), 0);
  for (let i = 0; i < lines.length && total > allowanceTokens; ) {
    if (friction.has(lines[i].id)) { i++; continue; }
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

// ── Where the last census ended ──
// The window is "since the last cycle that finished", kept in the config table. The first cycle
// on a box looks back one nightly cadence (24 hours).
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
    getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
      .run(CURSOR_KEY, String(ms));
  } catch { /* the next census just looks back a little further */ }
}
