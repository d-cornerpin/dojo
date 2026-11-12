// Distillation trigger: repeated task success distills into a draft technique, and techniques that keep
// failing are flagged for retirement. Constraints:
//  - outcome-gated: candidates come from the tracker's durable completion record, not conversation mining.
//  - batched: one engine pass per dreaming cycle, at most one message to the Trainer and one to the primary.
//  - draft-only (publish: false): recall matches only published techniques, so drafts never shadow user work.
//  - capped at MAX_CANDIDATES_PER_CYCLE; the owner is asked through the primary agent, and publishing stays
//    a deliberate act via the Trainer.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getTrainerAgentId } from '../config/platform.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { taskScope } from '../work/tracker-view.js';
import { lessonsTouchedSince, LESSON_LIFETIME_MS, type LessonRow } from '../vault/lessons-store.js';

const logger = createLogger('technique-distillation');

const MAX_CANDIDATES_PER_CYCLE = 2;
const SUCCESS_PATTERN_MIN_COMPLETIONS = 3;
const PATTERN_LOOKBACK_DAYS = 7;
const COVERED_SIMILARITY = 0.55;
const RETIRE_MIN_USES = 5;
const RETIRE_LOOKBACK_DAYS = 30;
const RETIRE_MAX_SUCCESS_RATE = 0.4;

interface CompletionGroup {
  normTitle: string;
  sampleTitle: string;
  sampleTaskId: string;
  sampleGoal: string | null;
  count: number;
}

// Grouping key: lowercase, digits and dates stripped, whitespace collapsed ("status email 6/3" and
// "status email 6/10" group together). Deterministic: no LLM in the trigger.
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\d+[\/\-.]\d+([\/\-.]\d+)?/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findRepeatedSuccessGroups(): CompletionGroup[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT w.id AS id, w.title AS title, w.goal AS goal FROM work w
    WHERE ${taskScope('w')} AND w.state = 'done'
      AND w.updated_at >= ?
      AND w.title IS NOT NULL
  `).all(Date.now() - PATTERN_LOOKBACK_DAYS * 86400000) as Array<{ id: string; title: string; goal: string | null }>;

  const groups = new Map<string, CompletionGroup>();
  for (const row of rows) {
    const norm = normalizeTitle(row.title);
    if (norm.length < 8) continue; // too generic to be a procedure
    const g = groups.get(norm);
    if (g) {
      g.count += 1;
      g.sampleTaskId = row.id; // keep the most recent sample
      g.sampleTitle = row.title;
      g.sampleGoal = row.goal;
    } else {
      groups.set(norm, { normTitle: norm, sampleTitle: row.title, sampleTaskId: row.id, sampleGoal: row.goal, count: 1 });
    }
  }
  return [...groups.values()].filter((g) => g.count >= SUCCESS_PATTERN_MIN_COMPLETIONS);
}

async function isCoveredByExistingTechnique(group: CompletionGroup): Promise<boolean> {
  try {
    const { vectorSearch } = await import('../memory/vector-search.js');
    const hits = await vectorSearch(`${group.sampleTitle}\n${group.sampleGoal ?? ''}`, undefined, {
      sourceType: 'technique',
      limit: 1,
      minSimilarity: COVERED_SIMILARITY,
    });
    return hits.length > 0;
  } catch {
    // Embeddings down: assume covered, so no drafts are created blind.
    return true;
  }
}

interface RetireCandidate { id: string; name: string; uses: number; successRate: number }

function findRetirementCandidates(): RetireCandidate[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.id, t.name,
           COUNT(u.id) AS uses,
           AVG(COALESCE(u.success, 0)) AS success_rate
    FROM techniques t
    JOIN technique_usage u ON u.technique_id = t.id
      AND u.used_at >= datetime('now', '-${RETIRE_LOOKBACK_DAYS} days')
      AND u.success IS NOT NULL
    WHERE t.state = 'published'
    GROUP BY t.id
    HAVING uses >= ${RETIRE_MIN_USES} AND success_rate < ${RETIRE_MAX_SUCCESS_RATE}
  `).all() as Array<{ id: string; name: string; uses: number; success_rate: number }>;
  return rows.map((r) => ({ id: r.id, name: r.name, uses: r.uses, successRate: r.success_rate }));
}

// Persist the retirement signal on the technique row: set retire_flagged_at on new candidates (the first
// flag time is kept) and clear it on any flagged technique that is no longer a candidate. Retirement
// itself stays owner-manual; this only tracks the suggestion.
function persistRetirementFlags(candidates: RetireCandidate[]): void {
  const db = getDb();
  const flaggedIds = new Set(candidates.map((c) => c.id));

  const setStmt = db.prepare(
    "UPDATE techniques SET retire_flagged_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND retire_flagged_at IS NULL",
  );
  for (const c of candidates) setStmt.run(c.id);

  const stillFlagged = db.prepare(
    'SELECT id FROM techniques WHERE retire_flagged_at IS NOT NULL',
  ).all() as Array<{ id: string }>;
  const clearStmt = db.prepare(
    "UPDATE techniques SET retire_flagged_at = NULL, updated_at = datetime('now') WHERE id = ?",
  );
  for (const row of stillFlagged) {
    if (!flaggedIds.has(row.id)) clearStmt.run(row.id);
  }
}

// Lessons the Dreamer wrote about techniques are candidates too.
// A lesson is fed to the Trainer once per write: the cursor is the latest write time already fed.
const LESSONS_FED_KEY = 'trainer.lessons_fed_ms';
const touchedAt = (l: LessonRow): number => l.expires_at - LESSON_LIFETIME_MS;

function unfedTechniqueLessons(): LessonRow[] {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(LESSONS_FED_KEY) as { value: string } | undefined;
  const fed = Number(row?.value);
  return lessonsTouchedSince(Number.isFinite(fed) ? fed + 1 : 0, 'technique');
}

function markLessonsFed(lessons: LessonRow[]): void {
  const latest = Math.max(...lessons.map(touchedAt));
  getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`)
    .run(LESSONS_FED_KEY, String(latest));
}

// One engine pass per dreaming cycle; never spawns agents. At most one batched A2A to the Trainer (drafts)
// and one agent notice (not A2A) to the primary (owner-approval relay and retirement flags).
export async function runDistillationCycle(): Promise<void> {
  // Repeated success: draft candidates.
  const groups = findRepeatedSuccessGroups();
  const candidates: CompletionGroup[] = [];
  for (const group of groups) {
    if (candidates.length >= MAX_CANDIDATES_PER_CYCLE) {
      logger.info('distillation: candidate cap reached, deferring remainder', {
        deferred: groups.length - candidates.length,
      });
      break;
    }
    if (await isCoveredByExistingTechnique(group)) continue;
    candidates.push(group);
  }

  // Failing published techniques: retirement flags.
  const retireFlags = findRetirementCandidates();
  // Persisted every cycle, before the early return, so a cycle with no candidates still clears recovered ones.
  persistRetirementFlags(retireFlags);

  const lessons = unfedTechniqueLessons();

  if (candidates.length === 0 && retireFlags.length === 0 && lessons.length === 0) {
    logger.debug('distillation: nothing to do this cycle');
    return;
  }

  const { deliverA2ANotice } = await import('../agent/a2a-notice.js');

  // deliverA2ANotice returns delivered: false on refusal instead of throwing. A refused batch reached nobody:
  // lessons stay unfed (offered again next cycle) and the owner is not told drafts were made.
  let batchDelivered = false;

  if (candidates.length > 0 || lessons.length > 0) {
    const bodies: string[] = [];
    if (candidates.length > 0) {
      const list = candidates.map((c, i) =>
        `${i + 1}. "${c.sampleTitle}" — completed ${c.count}x in the last ${PATTERN_LOOKBACK_DAYS} days (latest task id ${c.sampleTaskId}).${c.sampleGoal ? ` Goal: ${c.sampleGoal.slice(0, 200)}` : ''}`,
      ).join('\n');
      bodies.push(
        `These task patterns completed repeatedly and no existing technique covers them:\n${list}\n\n` +
        `For each: read the latest task's tracker entry and ledger, and author a DRAFT technique capturing the repeatable procedure (save_technique with publish: false — DRAFTS ONLY, never publish, never modify an existing technique). ` +
        `Name it after the procedure, not the specific dates/people.`,
      );
    }
    if (lessons.length > 0) {
      const list = lessons.map((l, i) => `${i + 1}. When: ${l.cue}\n   Lesson: ${l.lesson} (task ${l.task_id}, confidence ${l.confidence})`).join('\n');
      bodies.push(
        `These lessons came from tasks that went badly; each says what a technique should have covered:\n${list}\n\n` +
        `For each: author a DRAFT technique (save_technique with publish: false) for the better procedure, unless an existing technique already covers it, in which case leave it alone.`,
      );
    }
    try {
      const res = await deliverA2ANotice({
        intent: 'ASSIGN',
        threadId: uuidv4(),
        requiresResponse: false,
        payload:
          `Technique distillation (engine, one batch per dreaming cycle). ${bodies.join('\n\n')} ` +
          `When the drafts exist, you are done; the owner decides promotion.`,
        toAgent: getTrainerAgentId(),
        fromAgent: 'system',
      }, 'Technique-distillation draft batch to the Trainer', { count: candidates.length, lessons: lessons.length, toAgent: getTrainerAgentId() });
      batchDelivered = res?.delivered === true;
      if (batchDelivered) {
        if (lessons.length > 0) markLessonsFed(lessons);
        logger.info('distillation: sent draft batch to Trainer', { count: candidates.length, lessons: lessons.length });
      } else {
        logger.warn('distillation: Trainer batch was not delivered', {
          reason: res?.reason,
          count: candidates.length,
          lessons: lessons.length,
        });
      }
    } catch (err) {
      logger.error('distillation: Trainer batch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The primary gets a brief heads-up only; the full enumeration goes to the Trainer's thread. The retirement
  // half names the flagged techniques (capped, with an overflow count) and says nothing is auto-retired.
  const RETIRE_NAME_CAP = 6;
  if (candidates.length > 0 || retireFlags.length > 0) {
    const lines: string[] = ['Nightly learning pass:'];
    let hadBullet = false;
    // Claim drafts only if the batch actually reached the Trainer.
    if (candidates.length > 0 && batchDelivered) {
      lines.push(
        `• Drafted ${candidates.length} technique${candidates.length === 1 ? '' : 's'} from repeated task patterns (inert drafts until you promote them).`,
      );
      hadBullet = true;
    }
    if (retireFlags.length > 0) {
      const named = retireFlags
        .slice(0, RETIRE_NAME_CAP)
        .map((r) => `   - "${r.name}": ${r.uses} uses, ${Math.round(r.successRate * 100)}% success`)
        .join('\n');
      const overflow = retireFlags.length > RETIRE_NAME_CAP
        ? `\n   - …and ${retireFlags.length - RETIRE_NAME_CAP} more`
        : '';
      lines.push(
        `• Flagged ${retireFlags.length} published technique${retireFlags.length === 1 ? '' : 's'} for you to review (low success rate lately). ` +
        `These are suggestions only, nothing was auto-retired:\n${named}${overflow}`,
      );
      hadBullet = true;
    }
    lines.push('Want me to promote any drafts or archive any flagged ones? Say the word; otherwise nothing changes.');
    // Nothing drafted and nothing flagged: post nothing.
    if (!hadBullet) return;
    postAgentNotice({
      toAgentId: getPrimaryAgentId(),
      fromName: 'Learning loop',
      selfIntro: false,
      intent: 'learning_loop',
      brief: lines.join('\n'),
    });
  }
}
