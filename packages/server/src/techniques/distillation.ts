// ════════════════════════════════════════
// Distillation trigger — remediation Phase 5 (5b/5c/5d), Invariant VI.
//
// "Learn over time" needs the open half of the loop closed: repeated task
// SUCCESS distills into a reusable technique, and techniques that keep
// failing get retired. A previous auto path (Dreamer→Trainer handoff) was
// removed in v1.15.96 because it burned tokens and broke user-built
// techniques. Those reasons are BINDING constraints here:
//
//   OUTCOME-GATED — candidates come from the tracker's durable completion
//     record, never from conversation mining.
//   BATCHED — one engine pass per dreaming cycle; at most ONE message to the
//     Trainer and ONE to the primary per cycle, regardless of candidates.
//   DRAFT-ONLY — the Trainer is instructed to save drafts (publish: false).
//     Drafts are inert: recall only matches published techniques, so an
//     auto-distilled procedure can never shadow or modify user-built work.
//   CAPPED — at most MAX_CANDIDATES_PER_CYCLE new draft requests per cycle.
//   OWNER-IN-THE-LOOP — the approval ask reaches the owner through the
//     PRIMARY agent (engine-delivered notice; the primary asks on its normal
//     channel; publishing stays a deliberate act via the Trainer).
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getPrimaryAgentId } from '../config/platform.js';
import { getTrainerAgentId, isTrainerEnabled } from '../config/platform.js';
import { postAgentNotice } from '../agent/agent-notice.js';
import { taskScope } from '../work/tracker-view.js';

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

// Normalized grouping key: lowercase, digits and dates stripped, whitespace
// collapsed — "Send weekly status email 6/3" and "Send weekly status email
// 6/10" group together. Deterministic by design (no LLM in the trigger).
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
    // Embeddings down: assume covered (do NOT create drafts blind — the
    // v1.15.96 lesson says err toward not flooding the store).
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

/**
 * FA-TS6: persist the retirement signal durably on the technique row so it
 * survives the cycle and any dashboard reading the table sees it. Set
 * retire_flagged_at on current candidates that aren't already flagged (the first
 * flag time is preserved while a technique stays a candidate), and clear it back
 * to NULL on any still-flagged technique that is NOT a candidate this cycle,
 * i.e. it became healthy again (success rate recovered) or its usage fell below
 * the retirement floor. Retirement itself stays owner-manual; this only tracks
 * the suggestion.
 */
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

/**
 * One engine pass per dreaming cycle. Never spawns agents itself; it sends
 * at most one batched A2A to the Trainer (draft authoring) and one to the
 * primary (owner-approval relay + retirement flags).
 */
export async function runDistillationCycle(): Promise<void> {
  if (!isTrainerEnabled()) {
    logger.debug('distillation: trainer disabled, skipping');
    return;
  }

  // ── 5b: repeated-success → draft candidates ──
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

  // ── 5d: failing published techniques → retirement flags ──
  const retireFlags = findRetirementCandidates();
  // FA-TS6: persist the flag durably (and clear healthy-again techniques) EVERY
  // cycle, before the early-return, so a cycle with zero current candidates
  // still un-flags anything that recovered.
  persistRetirementFlags(retireFlags);

  if (candidates.length === 0 && retireFlags.length === 0) {
    logger.debug('distillation: nothing to do this cycle');
    return;
  }

  const { deliverA2AMessage } = await import('../agent/a2a-transport.js');

  if (candidates.length > 0) {
    const list = candidates.map((c, i) =>
      `${i + 1}. "${c.sampleTitle}" — completed ${c.count}x in the last ${PATTERN_LOOKBACK_DAYS} days (latest task id ${c.sampleTaskId}).${c.sampleGoal ? ` Goal: ${c.sampleGoal.slice(0, 200)}` : ''}`,
    ).join('\n');
    try {
      await deliverA2AMessage({
        intent: 'ASSIGN',
        threadId: uuidv4(),
        requiresResponse: false,
        payload:
          `Technique distillation (engine, one batch per dreaming cycle). These task patterns completed repeatedly and no existing technique covers them:\n${list}\n\n` +
          `For each: read the latest task's tracker entry and ledger, and author a DRAFT technique capturing the repeatable procedure (save_technique with publish: false — DRAFTS ONLY, never publish, never modify an existing technique). ` +
          `Name it after the procedure, not the specific dates/people. When the drafts exist, you are done; the owner decides promotion.`,
        toAgent: getTrainerAgentId(),
        fromAgent: 'system',
      });
      logger.info('distillation: sent draft batch to Trainer', { count: candidates.length });
    } catch (err) {
      logger.error('distillation: Trainer batch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 5c: the primary hears about it — briefly ──
  // comms-audit (critic find): this used to deliver an enumerated nightly report
  // ("spotted N patterns and asked the Trainer to draft: 'title' (Nx), … Retirement
  // flags: 'name' succeeded only X% of its last Y uses; …") as an FYI through the A2A
  // transport, which lands it as an unstamped role='user' [A2A:FYI from:system] row in
  // the primary's live tail and reaches the model — a verbose firehose. The full
  // candidate + retirement enumeration already goes to the Trainer's ASSIGN thread
  // (above) and the technique/tracker tables the owner reads when acting. The primary
  // only needs a brief, actionable heads-up in its awareness lane.
  //
  // FA-TS6: the retirement half now NAMES the flagged techniques (name + uses +
  // success%) so the owner knows which ones to look at, and says plainly they
  // are suggestions, nothing is auto-retired. Kept compact for the floor model:
  // the named list is capped, with an overflow count.
  const RETIRE_NAME_CAP = 6;
  if (candidates.length > 0 || retireFlags.length > 0) {
    const lines: string[] = ['Nightly learning pass:'];
    if (candidates.length > 0) {
      lines.push(
        `• Drafted ${candidates.length} technique${candidates.length === 1 ? '' : 's'} from repeated task patterns (inert drafts until you promote them).`,
      );
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
    }
    lines.push('Want me to promote any drafts or archive any flagged ones? Say the word; otherwise nothing changes.');
    postAgentNotice({
      toAgentId: getPrimaryAgentId(),
      fromName: 'Learning loop',
      selfIntro: false,
      intent: 'learning_loop',
      brief: lines.join('\n'),
    });
  }
}
