// The lessons table's single writer. A lesson is the Dreamer's one-sentence answer to "what should a technique
// have covered" for one rough task; the Trainer's nightly pass reads it. It is not a vault entry.
// `recordLesson` holds the three rules:
//   · the task must exist, and every evidence id must be one of THAT task's own events;
//   · every lesson expires 90 days after it was last written;
//   · a cue we already hold (same words, or a cosine at the shared dedup threshold) renews that lesson.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { setConfigValue } from '../config/config-value.js';
import { SEMANTIC_DEDUP_THRESHOLD } from '../memory/dedup-threshold.js';
import { cosineSimilarity } from './bounded-reads.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A lesson lives this long after it was last written or renewed. */
export const LESSON_LIFETIME_MS = 90 * DAY_MS;

/** A refusal that is the model's to read and fix. */
export class LessonRefused extends Error {}

export interface LessonInput {
  taskId: string;
  cue: string;
  lesson: string;
  evidenceEventIds: number[];
  confidence: number;
}

export interface LessonRow {
  id: string; agent_id: string | null; task_id: string | null; cue: string; lesson: string;
  evidence_event_ids: string; confidence: number; component: string;
  created_at: number; expires_at: number; renewed_count: number;
}

// One lesson per task per cycle: the ROUGH TASKS batch stamps the instant the cycle starts, and a task with a
// lesson written or renewed since then is done for this cycle.
const CYCLE_KEY = 'dreamer.lessons_batch_ms';

export function markLessonCycleStart(now: number = Date.now()): void {
  setConfigValue(CYCLE_KEY, String(now));
}

function lessonCycleStart(): number {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(CYCLE_KEY) as { value: string } | undefined;
  const at = Number(row?.value);
  return Number.isFinite(at) ? at : 0;
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

async function findMatch(cue: string, now: number): Promise<LessonRow | undefined> {
  const live = getDb().prepare("SELECT * FROM lessons WHERE component = 'technique' AND expires_at > ?").all(now) as LessonRow[];
  const exact = live.find((l) => normalize(l.cue) === normalize(cue));
  if (exact || live.length === 0) return exact;
  try {
    const { generateEmbedding } = await import('../memory/embeddings.js');
    const mine = await generateEmbedding(cue);
    let best: { row: LessonRow; score: number } | undefined;
    for (const l of live) {
      const score = cosineSimilarity(mine, await generateEmbedding(l.cue));
      if (score >= SEMANTIC_DEDUP_THRESHOLD && (!best || score > best.score)) best = { row: l, score };
    }
    return best?.row;
  } catch {
    // No embedding backend: only an identical cue renews. A near-duplicate row is a smaller harm
    // than refusing to record the lesson.
    return undefined;
  }
}

/** Validate and write one lesson. Returns its id and whether it renewed an existing one. */
export async function recordLesson(input: LessonInput, now: number = Date.now()): Promise<{ id: string; renewed: boolean }> {
  const db = getDb();
  const cue = input.cue?.trim();
  const lesson = input.lesson?.trim();
  if (!cue || !lesson) throw new LessonRefused('Error: cue and lesson are both required.');
  if (typeof input.confidence !== 'number' || !(input.confidence >= 0 && input.confidence <= 1)) {
    throw new LessonRefused('Error: confidence must be a number from 0 to 1.');
  }
  const ids = [...new Set(input.evidenceEventIds)];
  if (ids.length === 0 || ids.some((n) => !Number.isInteger(n))) {
    throw new LessonRefused('Error: evidence_event_ids must list at least one event id from the task\'s timeline.');
  }
  const task = db.prepare('SELECT COALESCE(assignee_agent, agent_id) AS agent_id FROM work WHERE id = ?')
    .get(input.taskId) as { agent_id: string } | undefined;
  if (!task) throw new LessonRefused(`Error: no task ${input.taskId}.`);
  const own = new Set((db.prepare(
    `SELECT id FROM work_events WHERE work_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
  ).all(input.taskId, ...ids) as Array<{ id: number }>).map((r) => r.id));
  const foreign = ids.filter((n) => !own.has(n));
  if (foreign.length > 0) {
    throw new LessonRefused(`Error: event id${foreign.length === 1 ? '' : 's'} ${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not in task ${input.taskId}'s timeline. Cite only ids shown in that task's timeline.`);
  }

  const done = db.prepare('SELECT id FROM lessons WHERE task_id = ? AND expires_at - ? >= ? LIMIT 1')
    .get(input.taskId, LESSON_LIFETIME_MS, lessonCycleStart()) as { id: string } | undefined;
  if (done) {
    throw new LessonRefused(`Task ${input.taskId} already has a lesson from this cycle (${done.id}). One lesson per task: go on to the next task, or write NO_ENTRY.`);
  }

  const match = await findMatch(cue, now);
  if (match) {
    const merged = [...new Set([...(JSON.parse(match.evidence_event_ids) as number[]), ...ids])];
    db.prepare(
      `UPDATE lessons SET lesson = ?, evidence_event_ids = ?, confidence = ?, expires_at = ?, renewed_count = renewed_count + 1,
              task_id = ?, agent_id = ?
        WHERE id = ?`,
    ).run(lesson, JSON.stringify(merged), input.confidence, now + LESSON_LIFETIME_MS, input.taskId, task.agent_id, match.id);
    return { id: match.id, renewed: true };
  }
  const id = uuidv4();
  db.prepare(
    `INSERT INTO lessons (id, agent_id, task_id, cue, lesson, evidence_event_ids, confidence, component, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'technique', ?, ?)`,
  ).run(id, task.agent_id, input.taskId, cue, lesson, JSON.stringify(ids), input.confidence, now, now + LESSON_LIFETIME_MS);
  return { id, renewed: false };
}

/** Lessons written or renewed since `sinceMs` that have not expired (a lesson's last write is its expiry minus its lifetime). */
export function lessonsTouchedSince(sinceMs: number, component?: string, now: number = Date.now()): LessonRow[] {
  return getDb().prepare(
    `SELECT * FROM lessons WHERE expires_at > ? AND expires_at - ? >= ? AND (? IS NULL OR component = ?)
      ORDER BY expires_at`,
  ).all(now, LESSON_LIFETIME_MS, sinceMs, component ?? null, component ?? null) as LessonRow[];
}
