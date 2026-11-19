// Nightly job, second selection: recent mixed notes (marked `legacy_mixed_rebuild`) are re-condensed
// one conversation each, FROM THEIR ORIGINAL MESSAGES (never touched), dated, by the writer `pickWriter` picks.
// Run by `summary-rebuild.ts`. Older mixed notes stay `legacy_mixed`, labelled "older mixed notes".
//
// Staged, then swapped per agent in one transaction: each finished chunk is written to
// `summary_rebuild_staged` at once (a crash loses no paid call; a resumed run skips it). Only when every
// queued note of an agent is staged are they swapped in together under its compaction lock, so the
// agent's cached prefix changes once and the older note stays in view until then.
//
// No count limit: pacing comes only from real signals (a writer answering, `writer.ts`; the agent not
// mid-turn and the budget, `rebuild-signals.ts`). This module adds no clock.
//
// Nothing invented: a note whose source rows are all gone becomes `lineage_lost`, keeping its content;
// a refusal leaves the older note in place, labelled.

import { createHash } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { withLock } from '../db/with-lock.js';
import { createLogger } from '../logger.js';
import type { Message } from '@dojo/shared';
import {
  buildLeafSummaryInput, chunkMessages, getLeafChunkTokens, NO_CONVERSATION_PLACEHOLDER,
} from './compaction.js';
import { pickWriter } from './writer.js';
import { createLeafSummary, deleteSummary, getDescendantMessages, getSummary } from './dag.js';
import { generateSummary, getDepthPrompt } from './summarize.js';
import { estimateTokens } from './budget.js';
import { annotateSummaryObligations } from './summary-obligations.js';
import { summaryTargetTokens } from './summary-target.js';
import { modelCharsPerToken } from '../services/token-density.js';
import { rowSubjectKeys } from './summary-subject.js';
import { agentBusy, waitReason } from './rebuild-signals.js';
import { CLASSIFY_SQL } from './notes-classify-sql.js';

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
  /** Why the run left notes queued, per agent; empty when nothing is left. */
  waiting: Record<string, string>;
}

/** Label notes nobody labelled (a downgraded version wrote them) by migration 192's own rule. */
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
      const target = summaryTargetTokens(content, modelCharsPerToken(writer));   // the one target rule, at the writer's density
      const inputTokens = estimateTokens(content) + estimateTokens(getDepthPrompt(0, target, unit.agentId));
      const wait = waitReason(unit.agentId, writer, inputTokens, target);
      if (wait) return wait;
      stats.modelCalls++;
      stats.inputTokens += inputTokens;
      const result = await generateSummary({ content, depth: 0, targetTokens: target, agentId: unit.agentId, modelId: writer, spanIds: chunk.map((m) => m.id) });
      if (!result.ok) return `the summary writer refused (${result.reason})`;
      text = annotateSummaryObligations(result.text, unit.agentId);
    }
    insert.run(unit.id, key, unit.agentId, subject, text, estimateTokens(text), JSON.stringify(chunk.map((m) => m.id)));
  }
  return 'staged';
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
  return replaced;
}

function deleteSubtree(id: string): void {
  const kids = getDb().prepare('SELECT parent_id FROM summary_parents WHERE summary_id = ?').all(id) as Array<{ parent_id: string }>;
  deleteSummary(id);
  for (const k of kids) deleteSubtree(k.parent_id);
}

async function rebuildAgent(agentId: string, units: readonly Unit[], stats: LegacyRebuildStats): Promise<void> {
  if (agentBusy(agentId)) { stats.waiting[agentId] = 'the agent is mid-turn'; return; }
  const ready: Unit[] = [];
  for (const unit of units) {
    const writer = pickWriter(agentId);
    if (!writer) { stats.waiting[agentId] = 'no summary writer is answering'; return; }
    const outcome = await stageUnit(unit, writer, stats);
    if (outcome === 'staged') ready.push(unit);
    else if (outcome !== 'lost') { stats.waiting[agentId] = outcome; return; }
  }
  if (agentBusy(agentId)) { stats.waiting[agentId] = 'the agent is mid-turn'; return; }
  const swapped = await withLock(`compact:${agentId}`, async () => swapAgent(agentId, ready, stats), { ifBusy: 'skip' });
  if (swapped === undefined) { stats.waiting[agentId] = 'another compaction holds the lock'; return; }
  stats.notesReplaced += swapped;
  if (swapped > 0) stats.agentsSwapped++;
}

/** One pass over every queued note, agent by agent. Returns what it did and why anything waits. */
export async function rebuildLegacyMixedNotes(): Promise<LegacyRebuildStats> {
  const stats: LegacyRebuildStats = { classified: classifyUnlabelledNotes(), agentsSwapped: 0, notesReplaced: 0, notesWritten: 0, lineageLost: 0, modelCalls: 0, inputTokens: 0, waiting: {} };
  const db = getDb();
  db.prepare('DELETE FROM summary_rebuild_staged WHERE NOT EXISTS (SELECT 1 FROM summaries s WHERE s.id = summary_rebuild_staged.unit_id)').run();   // an older version deleted the note
  const byAgent = new Map<string, Unit[]>();
  for (const u of queuedUnits()) byAgent.set(u.agentId, [...(byAgent.get(u.agentId) ?? []), u]);
  for (const [agentId, units] of byAgent) {
    // One agent's failure is logged against it and skipped: it never starves the agents after it.
    try {
      await rebuildAgent(agentId, units, stats);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      stats.waiting[agentId] = `the rebuild failed (${why}); the older notes stay, labelled, and the next run resumes`;
      logger.warn('Older mixed notes: one agent\'s rebuild failed; continuing with the others', { error: why }, agentId);
    }
  }
  logger.info('Older mixed notes: rebuild pass done', { ...stats });
  return stats;
}
