// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 field fix Y (owner ruling 2026-11-03: "gradually, in the background") — WHEN A TURN'S WINDOW
// SHRINKS, THE HISTORY THAT NO LONGER FITS IS CAUGHT UP OUTSIDE THE CONVERSATION.
//
// The one router window (N42, GitHub #25, the owner's design, kept) sizes every automatic pick to the
// smallest tier model. An agent that grew on a bigger window finds most of its history out of view on
// its first turn after that, and the engine's assembly door (`out-of-view-fold.ts`) folded ALL of it
// before the reply: 30K-token summary calls on the agent's own model, inside the owner's turn, and
// tens of them on a lived-in agent (field failure 4). The same happens to any agent whose window
// shrinks for another reason (a smaller model chosen, the Router slider lowered).
//
// THE SIGNAL, read off the rows themselves. The rows out of view and not yet summarised hold more than
// one summary's worth (`LEAF_CHUNK_TOKENS`, the span one leaf summary covers): that is not a turn
// overflowing a little — which the door still folds inline, as before — it is a CATCH-UP. While a
// catch-up STANDS (its record here, and a placeholder note still waiting), every turn's door labels
// what leaves its view, so no turn dials a summary while the folder works. The routine pressure fold
// (`context-gates.ts`) is unchanged: it was already fire-and-forget, and the rows a door labelled are
// covered, so it never takes the backlog again.
//
// THE TURN covers the backlog with placeholder notes (`uncondensed-placeholder.ts`): model-free, the
// rows archived first and kept, searchable. It assembles the newest rows that fit beside the summaries
// and the notes. Nothing is lost or discarded; the notes are the backlog the folder works through.
//
// THE FOLDER is the existing placeholder replacement, launched in the background
// (`replacePlaceholdersInBackground`): one note at a time, the next when the one before lands, in the
// writer order the owner ruled (`summary-writer-health.ts`), yielding to the agent's live turn.
//
// THE PROGRESS GLYPH (round 3's card, v3.5 field fix 3 #9) is raised by a real signal: a person's turn starting while
// the agent still runs on notes (a backlog that folds before the next turn never shows one). Owner ruling OR-FIELD3 (c):
// "It shouldn't be a persistent notification if it doesn't require the intervention of the user. It also shouldn't
// be red." So it is no card: it is the orb's task glyph for this agent (`ownerProgressFrame`, the `engine:activity`
// frames compaction already sends), shown again at each person's turn while it stands (a dashboard opened since, or
// one that reconnected and dropped its engine items, picks it up there) and ended when the last note is replaced.
// While the compaction-failure notice speaks for the agent (no writer can replace notes), it is withdrawn: the
// glyph says the work is moving, and it is not.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getMessagesOutsideFreshTail } from './store.js';
import { getCompactedMessageIds } from './dag.js';
import { UNCONDENSED_KIND } from './uncondensed-head.js';
import { LEAF_CHUNK_TOKENS } from './summary-target.js';
import { estimateTokens } from './budget.js';
import { ownerProgressFrame } from '../services/owner-card-frames.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('memory-catch-up');

/** Unsummarised rows of this session at or below `throughSeq` (the fold's own reader). */
export function owedThrough(agentId: string, throughSeq: number): Message[] {
  const compacted = getCompactedMessageIds(agentId);
  return getMessagesOutsideFreshTail(agentId, 1)
    .filter((m) => !compacted.has(m.id) && (m.rowid ?? Number.POSITIVE_INFINITY) <= throughSeq);
}

export function hasUncondensedPlaceholders(agentId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM summaries WHERE agent_id = ? AND kind = ? LIMIT 1').get(agentId, UNCONDENSED_KIND);
}

/** `askedThrough`: the newest person's message when it began; `carded`: its progress is shown (the name is the stored
 *  field's, kept so a record written by preflight.3 reads right); `failing`: the compaction-failure notice speaks for
 *  this agent instead (round 3). */
interface CatchUp { at: number; askedThrough?: number; carded?: boolean; failing?: boolean }
const keyOf = (agentId: string): string => `memory_catch_up.${agentId}`;
const progressKeyOf = (agentId: string): string => `memory-catch-up:${agentId}`;
/** The line the active-work list shows beside the glyph: what is measured (older history being summarised), never
 *  an assumed cause. */
const PROGRESS_LABEL = 'Summarising older memory';

function readCatchUp(agentId: string): CatchUp | null {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(keyOf(agentId)) as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as CatchUp : null; } catch { return { at: 0 }; }
}

function writeCatchUp(agentId: string, value: CatchUp | null): void {
  if (value === null) getDb().prepare('DELETE FROM config WHERE key = ?').run(keyOf(agentId));
  else getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(keyOf(agentId), JSON.stringify(value));
}

/** Does a catch-up stand for this agent: started, and a note still waiting for its summary? */
export function catchUpStands(agentId: string): boolean {
  try {
    return readCatchUp(agentId) !== null && hasUncondensedPlaceholders(agentId);
  } catch {
    return false;
  }
}

/** Are the rows out of view through `throughSeq` the background folder's — a catch-up standing, or a
 *  backlog more than one summary's worth? A read that fails answers no: the turn folds as before. */
export function catchUpOwns(agentId: string, throughSeq: number): boolean {
  try {
    if (catchUpStands(agentId)) return true;
    endCatchUpIfDone(agentId);   // its last note may have been taken by a real fold beside it
    if (throughSeq <= 0) return false;
    const owed = owedThrough(agentId, throughSeq).reduce((n, m) => n + (m.tokenCount ?? estimateTokens(m.content)), 0);
    return owed > LEAF_CHUNK_TOKENS;
  } catch {
    return false;
  }
}

const newestAsk = (agentId: string): number =>
  (getDb().prepare("SELECT MAX(seq) AS r FROM messages WHERE agent_id = ? AND role = 'user'").get(agentId) as { r: number | null }).r ?? 0;

/** A turn handed its backlog to the background folder: record it. Nothing shown yet (round 3, F3): a backlog that
 *  folds before the next turn never touches the owner; the glyph is raised by `showCatchUpAtTurnStart`. */
export function beginCatchUp(agentId: string, rowsLabelled: number): void {
  try {
    if (readCatchUp(agentId) !== null) return;
    writeCatchUp(agentId, { at: Date.now(), askedThrough: newestAsk(agentId) });
    logger.info('Catch-up: older history no longer fits this agent\'s window; it is folded in the background, a span at a time', { rowsLabelled }, agentId);
  } catch (err) {
    logger.warn('Catch-up could not be recorded; the notes stand and the folder still replaces them', { error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}

/** The folder landed its last note: the catch-up is over, and its glyph leaves every open dashboard. */
export function endCatchUpIfDone(agentId: string): void {
  try {
    if (readCatchUp(agentId) === null || hasUncondensedPlaceholders(agentId)) return;
    const was = readCatchUp(agentId);
    writeCatchUp(agentId, null);
    logger.info('Catch-up finished: every older span has its summary', {}, agentId);
    if (was?.carded) ownerProgressFrame('end', progressKeyOf(agentId), agentId, PROGRESS_LABEL);
  } catch { /* the record stays; the next landing note ends it */ }
}

/** THE GLYPH'S SIGNAL (round 3, F3): a person's turn starts while this agent still runs on notes. Called by the
 *  engine's assembly door; shown again at each such turn while it stands, never while the failure notice speaks
 *  (F2). Never throws. */
export function showCatchUpAtTurnStart(agentId: string): void {
  try {
    const rec = readCatchUp(agentId);
    if (rec === null || rec.failing || !hasUncondensedPlaceholders(agentId)) return;
    if (newestAsk(agentId) <= (rec.askedThrough ?? 0)) return;   // the turn that began it: not yet a turn on notes
    if (!rec.carded) writeCatchUp(agentId, { ...rec, carded: true });
    ownerProgressFrame('start', progressKeyOf(agentId), agentId, PROGRESS_LABEL);
  } catch { /* the glyph is the courtesy; the folder works regardless */ }
}

/** Round 3 (F2): the compaction-failure notice was raised for this agent (`compaction-defect.ts`). The glyph that says
 *  the work is moving leaves; it may return at a later turn once the failure is over. */
export function withdrawCatchUpProgress(agentId: string): void {
  try {
    const rec = readCatchUp(agentId);
    if (rec === null) return;
    writeCatchUp(agentId, { ...rec, failing: true, carded: false });
    if (rec.carded) ownerProgressFrame('end', progressKeyOf(agentId), agentId, PROGRESS_LABEL);
  } catch { /* best effort */ }
}

/** The failure is over: the catch-up glyph may be shown again at the next turn on notes. */
export function catchUpFailureOver(agentId: string): void {
  try {
    const rec = readCatchUp(agentId);
    if (rec?.failing) writeCatchUp(agentId, { ...rec, failing: false });
  } catch { /* best effort */ }
}

/** The agents whose catch-up record is open (the boot resumes each: `legacy-rebuild-boot.ts`). */
export function openCatchUps(): string[] {
  const rows = getDb().prepare("SELECT key FROM config WHERE key LIKE 'memory_catch_up.%'").all() as Array<{ key: string }>;
  return rows.map(({ key }) => key.slice('memory_catch_up.'.length));
}
