// ════════════════════════════════════════════════════════════════════════════════════════
// t144 — THE NIGHTLY JOB'S SECOND SELECTION: RECENT MIXED NOTES, REBUILT ONE CONVERSATION EACH.
//
// OR-V333-SET (8) with the owner's scope ruling OR-REBUILD-SCOPE (2026-10-12, his words: "Can we just
// maybe have it do it for like the last week or two of notes instead?"). Migration 192 marked each
// note from before this release that mixed conversations: `legacy_mixed_rebuild` when every source row
// is from the 14 days before the update, `legacy_mixed` (never rebuilt, labelled "older mixed notes")
// otherwise. This module is run by the EXISTING nightly job (`summary-rebuild.ts`), with the same writer
// resolution as every summary (the Settings compaction model, else the agent's own model and provider,
// else — only with no Settings choice — the cheapest; ruling R-V333-12). It re-condenses each queued
// note FROM ITS ORIGINAL MESSAGES, per conversation, dated; original messages are never touched.
//
// THE SHAPE, and why each part:
//   · STAGED, THEN SWAPPED PER AGENT IN ONE TRANSACTION. Each finished chunk is written to
//     `summary_rebuild_staged` at once (a crash loses no paid call; a resumed run skips it). Only when
//     every queued note of an agent is fully staged are they swapped in together, under the agent's
//     compaction lock — so the agent's cached prefix changes ONCE (G2), and until then the older note
//     stays in view, labelled "older mixed notes", so there is never a gap.
//   · NO COUNT (owner ruling 2026-10-13, no hard limits). The job works through every queued note,
//     paced only by real signals: a summary writer answering (`summary-writer-health.ts`, which also
//     honours the provider's breaker), the agent not mid-turn, and the money guardrail (`checkBudget`).
//     A hung call is ended by its own transport's patience (t140); this module adds no clock.
//   · NOTHING INVENTED. A note whose source rows are all gone becomes `lineage_lost` ("conversation
//     unknown, <dates>"), keeping its content. A refusal leaves the older note in place, labelled.
// ════════════════════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { withLock } from '../db/with-lock.js';
import { createLogger } from '../logger.js';
import type { Message } from '@dojo/shared';
import {
  buildLeafSummaryInput, chunkMessages, getLeafChunkTokens, rebuildContextItems, resolveSummaryWriterModel,
  NO_CONVERSATION_PLACEHOLDER, SUMMARY_TARGET_TOKENS,
} from './compaction.js';
import { createLeafSummary, deleteSummary, getDescendantMessages, getSummary } from './dag.js';
import { generateSummary, getDepthPrompt } from './summarize.js';
import { estimateTokens } from './budget.js';
import { annotateSummaryObligations } from './summary-obligations.js';
import { CONDENSE_MIN_TARGET_TOKENS } from './condense-until-fits.js';
import { rowSubjectKeys } from './summary-subject.js';
import { checkBudget } from '../costs/budget.js';
import { activeRuns } from '../agent/shared-state.js';

const logger = createLogger('legacy-notes-rebuild');

export interface LegacyRebuildStats {
  /** Notes written by a version that did not label them, classified this run. */
  classified: number;
  agentsSwapped: number;
  notesReplaced: number;
  notesWritten: number;
  lineageLost: number;
  modelCalls: number;
  /** Input tokens sent (system prompt included), for the cost the run reports. */
  inputTokens: number;
  /** Why the run left notes queued, per agent — `null` when nothing is left. */
  waiting: Record<string, string>;
}

/**
 * The classification rule: migration 192's own statements (its comments stripped), re-run over notes
 * nobody labelled — those a downgraded version wrote. Idempotent by predicate. ONE rule: a test holds
 * this text byte-equal to the migration file's (`t144-migration-192-labels-older-notes.test.ts`).
 */
export const CLASSIFY_SQL = `CREATE TEMP TABLE t192_desc AS
WITH RECURSIVE d(root, id) AS (
  SELECT id, id FROM summaries WHERE subject_key IS NULL AND rebuild_state IS NULL
  UNION
  SELECT d.root, sp.parent_id FROM d JOIN summary_parents sp ON sp.summary_id = d.id
)
SELECT root, id FROM d;
CREATE INDEX t192_desc_id ON t192_desc(id);

CREATE TEMP TABLE t192_root AS
SELECT d.root AS root,
       COUNT(DISTINCT k.key) AS keys,
       MIN(k.key) AS one_key,
       MIN(k.created_at) AS first_at
  FROM t192_desc d
  JOIN summary_messages sm ON sm.summary_id = d.id
  JOIN (SELECT m.id AS id, m.created_at AS created_at,
               CASE
                 WHEN m.role = 'system' THEN NULL
                 WHEN m.role = 'user' AND (m.lane = 'a2a' OR m.source_agent_id IS NOT NULL) THEN 'a2a:' || COALESCE(m.a2a_thread_id, '')
                 WHEN m.role = 'user' AND m.lane = 'events' THEN 'engine'
                 WHEN m.role = 'user' THEN COALESCE('conv:' || m.conversation_id, 'unknown')
                 WHEN m.subject_kind IN ('conv', 'legacy', 'delivered') THEN COALESCE('conv:' || m.conversation_id, 'unknown')
                 WHEN m.subject_kind = 'a2a_thread' THEN 'a2a:' || COALESCE(m.a2a_thread_id, '')
                 WHEN m.subject_kind = 'engine_event' THEN 'engine'
                 WHEN m.subject_kind = 'background' THEN 'background'
                 WHEN m.subject_kind = 'unknown' THEN 'unknown'
                 ELSE COALESCE('conv:' || m.conversation_id, 'a2a:' || m.a2a_thread_id, 'unknown')
               END AS key
          FROM messages m) k ON k.id = sm.message_id
 GROUP BY d.root;
CREATE UNIQUE INDEX t192_root_key ON t192_root(root);

UPDATE summaries SET subject_key = (SELECT r.one_key FROM t192_root r WHERE r.root = summaries.id)
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root WHERE keys = 1);

UPDATE summaries SET subject_key = 'unknown'
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root WHERE keys = 0);

UPDATE summaries SET rebuild_state = 'legacy_mixed_rebuild'
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root
               WHERE keys > 1 AND first_at >= (CAST(strftime('%s', 'now') AS INTEGER) - 14 * 86400) * 1000);

UPDATE summaries SET rebuild_state = 'legacy_mixed'
 WHERE subject_key IS NULL AND rebuild_state IS NULL
   AND id IN (SELECT root FROM t192_root WHERE keys > 1);

UPDATE summaries SET rebuild_state = 'lineage_lost'
 WHERE subject_key IS NULL AND rebuild_state IS NULL;

DROP TABLE t192_root;
DROP TABLE t192_desc;`;

export function classifyUnlabelledNotes(): number {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM summaries WHERE subject_key IS NULL AND rebuild_state IS NULL LIMIT 1').get()) return 0;
  let changed = 0;
  db.transaction(() => {
    db.exec('DROP TABLE IF EXISTS temp.t192_root; DROP TABLE IF EXISTS temp.t192_desc;');
    for (const st of CLASSIFY_SQL.split(';').map((x) => x.trim()).filter(Boolean)) changed += st.startsWith('UPDATE') ? db.prepare(st).run().changes : (db.exec(st), 0);
  })();
  if (changed > 0) logger.info('Labelled notes a version without conversation labels wrote', { changed });
  return changed;
}

interface Unit { id: string; agentId: string; tokenCount: number }

function queuedUnits(): Unit[] {
  return (getDb().prepare(
    `SELECT id, agent_id, token_count FROM summaries
      WHERE rebuild_state = 'legacy_mixed_rebuild' AND NOT EXISTS (SELECT 1 FROM summary_parents sp WHERE sp.parent_id = summaries.id)
      ORDER BY agent_id, earliest_at, id`,
  ).all() as Array<{ id: string; agent_id: string; token_count: number }>).map((r) => ({ id: r.id, agentId: r.agent_id, tokenCount: r.token_count }));
}

const chunkKey = (rows: readonly Message[]): string => createHash('sha256').update(rows.map((m) => m.id).join('\n')).digest('hex').slice(0, 32);

/** The agent is mid-turn: its rebuild waits (its notes stay in view, labelled) — never a clock. */
function agentBusy(agentId: string): boolean {
  if (activeRuns.has(agentId)) return true;
  const row = getDb().prepare('SELECT status FROM agents WHERE id = ?').get(agentId) as { status: string } | undefined;
  return row?.status === 'working';
}

/** The rebuilt notes keep the agent's footprint: the older note's size, shared by its conversations. */
function targetFor(unit: Unit, chunkTokens: number, unitTokens: number): number {
  const share = unitTokens > 0 ? Math.round(unit.tokenCount * (chunkTokens / unitTokens)) : SUMMARY_TARGET_TOKENS.leaf;
  return Math.max(CONDENSE_MIN_TARGET_TOKENS, Math.min(SUMMARY_TARGET_TOKENS.leaf, share));
}

/** Stage every chunk of one queued note. True when the note is fully staged. */
async function stageUnit(unit: Unit, writer: string, stats: LegacyRebuildStats): Promise<'staged' | 'lost' | string> {
  const db = getDb();
  const rows = getDescendantMessages(unit.id);
  if (rows.length === 0) {
    db.prepare("UPDATE summaries SET rebuild_state = 'lineage_lost' WHERE id = ?").run(unit.id);
    stats.lineageLost++;
    return 'lost';
  }
  const chunks = chunkMessages(rows, getLeafChunkTokens());
  const unitTokens = rows.reduce((t, m) => t + (m.tokenCount ?? estimateTokens(m.content)), 0);
  const staged = new Set((db.prepare('SELECT chunk_key FROM summary_rebuild_staged WHERE unit_id = ?').all(unit.id) as Array<{ chunk_key: string }>).map((r) => r.chunk_key));
  const insert = db.prepare(`INSERT OR REPLACE INTO summary_rebuild_staged (unit_id, chunk_key, agent_id, subject_key, content, token_count, message_ids)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`);
  for (const chunk of chunks) {
    const key = chunkKey(chunk);
    if (staged.has(key)) continue;
    const subject = rowSubjectKeys(unit.agentId, chunk)[0];
    const content = buildLeafSummaryInput(chunk);
    let text = NO_CONVERSATION_PLACEHOLDER;
    if (content.trim().length > 0) {
      const target = targetFor(unit, chunk.reduce((t, m) => t + (m.tokenCount ?? estimateTokens(m.content)), 0), unitTokens);
      const inputTokens = estimateTokens(content) + estimateTokens(getDepthPrompt(0, target, undefined, unit.agentId));
      const budget = checkBudget(unit.agentId, estimateCost(writer, inputTokens, target));
      if (!budget.allowed) return `the spending limit is reached (${budget.reason ?? 'budget'})`;
      stats.modelCalls++;
      stats.inputTokens += inputTokens;
      const result = await generateSummary({ content, depth: 0, targetTokens: target, agentId: unit.agentId, modelId: writer });
      if (!result.ok) return `the summary writer refused (${result.reason})`;
      text = annotateSummaryObligations(result.text, unit.agentId);
    }
    insert.run(unit.id, key, unit.agentId, subject, text, estimateTokens(text), JSON.stringify(chunk.map((m) => m.id)));
  }
  return 'staged';
}

function estimateCost(modelId: string, inputTokens: number, outputTokens: number): number {
  const m = getDb().prepare('SELECT input_cost_per_m, output_cost_per_m FROM models WHERE id = ?').get(modelId) as
    { input_cost_per_m: number | null; output_cost_per_m: number | null } | undefined;
  return ((m?.input_cost_per_m ?? 0) * inputTokens + (m?.output_cost_per_m ?? 0) * outputTokens) / 1_000_000;
}

/** Swap an agent's fully staged notes in, all at once. Re-checks each note is still queued and on top;
 *  a staged note covers exactly the rows its older note still covers, or that note waits. */
function swapAgent(agentId: string, units: readonly Unit[], stats: LegacyRebuildStats): number {
  const db = getDb();
  let replaced = 0;
  db.transaction(() => {
    for (const unit of units) {
      const now = getSummary(unit.id);
      const onTop = !db.prepare('SELECT 1 FROM summary_parents WHERE parent_id = ? LIMIT 1').get(unit.id);
      const staged = db.prepare('SELECT chunk_key, content, token_count, message_ids FROM summary_rebuild_staged WHERE unit_id = ?')
        .all(unit.id) as Array<{ chunk_key: string; content: string; token_count: number; message_ids: string }>;
      if (!now || now.rebuildState !== 'legacy_mixed_rebuild' || !onTop) { db.prepare('DELETE FROM summary_rebuild_staged WHERE unit_id = ?').run(unit.id); continue; }
      const rows = getDescendantMessages(unit.id);
      const want = new Set(chunkMessages(rows, getLeafChunkTokens()).map(chunkKey));
      const have = staged.filter((s) => want.has(s.chunk_key));
      if (have.length !== want.size) continue;   // rows changed since staging: the next run stages the rest
      const byId = new Map(rows.map((m) => [m.id, m]));
      for (const s of have) {
        const ids = (JSON.parse(s.message_ids) as string[]).filter((id) => byId.has(id));
        if (ids.length === 0) continue;
        const first = byId.get(ids[0])!; const last = byId.get(ids[ids.length - 1])!;
        createLeafSummary(agentId, s.content, s.token_count, ids, first.createdAt, last.createdAt);
        stats.notesWritten++;
      }
      deleteSubtree(unit.id);
      db.prepare('DELETE FROM summary_rebuild_staged WHERE unit_id = ?').run(unit.id);
      replaced++;
    }
  })();
  if (replaced > 0) rebuildContextItems(agentId);
  return replaced;
}

function deleteSubtree(id: string): void {
  const kids = getDb().prepare('SELECT parent_id FROM summary_parents WHERE summary_id = ?').all(id) as Array<{ parent_id: string }>;
  deleteSummary(id);
  for (const k of kids) deleteSubtree(k.parent_id);
}

/** One pass over every queued note, agent by agent. Returns what it did and why anything waits. */
export async function rebuildLegacyMixedNotes(): Promise<LegacyRebuildStats> {
  const stats: LegacyRebuildStats = { classified: classifyUnlabelledNotes(), agentsSwapped: 0, notesReplaced: 0, notesWritten: 0, lineageLost: 0, modelCalls: 0, inputTokens: 0, waiting: {} };
  const db = getDb();
  db.prepare('DELETE FROM summary_rebuild_staged WHERE NOT EXISTS (SELECT 1 FROM summaries s WHERE s.id = summary_rebuild_staged.unit_id)').run();   // an older version deleted the note
  const byAgent = new Map<string, Unit[]>();
  for (const u of queuedUnits()) byAgent.set(u.agentId, [...(byAgent.get(u.agentId) ?? []), u]);
  for (const [agentId, units] of byAgent) {
    if (agentBusy(agentId)) { stats.waiting[agentId] = 'the agent is mid-turn'; continue; }
    const own = (db.prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? undefined;
    const ready: Unit[] = [];
    let waiting: string | null = null;
    for (const unit of units) {
      const writer = resolveSummaryWriterModel(agentId, own, { background: true });
      if (!writer) { waiting = 'no summary writer is answering'; break; }
      const outcome = await stageUnit(unit, writer, stats);
      if (outcome === 'staged') ready.push(unit);
      else if (outcome !== 'lost') { waiting = outcome; break; }
    }
    if (waiting) { stats.waiting[agentId] = waiting; continue; }
    if (agentBusy(agentId)) { stats.waiting[agentId] = 'the agent is mid-turn'; continue; }
    const swapped = await withLock(`compact:${agentId}`, async () => swapAgent(agentId, ready, stats), { ifBusy: 'skip' });
    if (swapped === undefined) { stats.waiting[agentId] = 'another compaction holds the lock'; continue; }
    stats.notesReplaced += swapped;
    if (swapped > 0) stats.agentsSwapped++;
  }
  logger.info('Older mixed notes: rebuild pass done', { ...stats });
  return stats;
}
