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
// THE CARD. One plain card per agent while its catch-up stands, through the existing owner-card frames
// (keyed, so it is one card per agent) and the owner-notices list (so it lasts across a reload). It
// leaves when the last note is replaced. No name is written here: the card reads the agent's own.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { getMessagesOutsideFreshTail } from './store.js';
import { getCompactedMessageIds } from './dag.js';
import { UNCONDENSED_KIND } from './uncondensed-head.js';
import { LEAF_CHUNK_TOKENS } from './summary-target.js';
import { estimateTokens } from './budget.js';
import { ownerCardEnded, ownerCardFrame } from '../services/owner-card-frames.js';
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

interface CatchUp { at: number; dismissedAt?: number }
const keyOf = (agentId: string): string => `memory_catch_up.${agentId}`;
const cardKeyOf = (agentId: string): string => `memory-catch-up:${agentId}`;

function readCatchUp(agentId: string): CatchUp | null {
  const row = getDb().prepare('SELECT value FROM config WHERE key = ?').get(keyOf(agentId)) as { value: string } | undefined;
  try { return row ? JSON.parse(row.value) as CatchUp : null; } catch { return { at: 0 }; }
}

function writeCatchUp(agentId: string, value: CatchUp | null): void {
  if (value === null) getDb().prepare('DELETE FROM config WHERE key = ?').run(keyOf(agentId));
  else getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`).run(keyOf(agentId), JSON.stringify(value));
}

/** The card, in the owner's words, naming the agent by its own name and the size it is fitting. */
function catchUpWords(agentId: string): string {
  // Automatic model choice read as `router/router-window.ts`'s `isAutoRouted` reads it; that module is not imported
  // here because it loads the model module, and this one is loaded by the summary writer's own callers.
  const row = getDb().prepare("SELECT name, model_id IN ('auto', '__auto__') AS auto FROM agents WHERE id = ?").get(agentId) as { name?: string; auto?: number } | undefined;
  const size = row?.auto === 1 ? 'the Router\'s memory size' : 'its model\'s memory size';
  return `Dojo: ${row?.name ?? 'An agent'} is tidying its older memory to fit ${size}. Replies are not held up; this finishes on its own.`;
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

/** A turn handed its backlog to the background folder: record it and tell the owner, once per catch-up. */
export function beginCatchUp(agentId: string, rowsLabelled: number): void {
  try {
    if (readCatchUp(agentId) !== null) return;
    writeCatchUp(agentId, { at: Date.now() });
    logger.info('Catch-up: older history no longer fits this agent\'s window; it is folded in the background, a span at a time', { rowsLabelled }, agentId);
    ownerCardFrame(catchUpWords(agentId), 'warning', cardKeyOf(agentId));
  } catch (err) {
    logger.warn('Catch-up could not be recorded; the notes stand and the folder still replaces them', { error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}

/** The folder landed its last note: the catch-up is over, and its card leaves every open dashboard. */
export function endCatchUpIfDone(agentId: string): void {
  try {
    if (readCatchUp(agentId) === null || hasUncondensedPlaceholders(agentId)) return;
    writeCatchUp(agentId, null);
    logger.info('Catch-up finished: every older span has its summary', {}, agentId);
    ownerCardEnded(catchUpWords(agentId), cardKeyOf(agentId));
  } catch { /* the record stays; the next landing note ends it */ }
}

/** The catch-up cards a dashboard shows on load: started, still running, not dismissed. */
export function catchUpOwnerCards(): Array<{ words: string; severity: 'notice'; cardKey: string; dismiss: () => void }> {
  const rows = getDb().prepare("SELECT key FROM config WHERE key LIKE 'memory_catch_up.%'").all() as Array<{ key: string }>;
  return rows.map(({ key }) => key.slice('memory_catch_up.'.length)).flatMap((agentId) => {
    const told = readCatchUp(agentId);
    if (told === null || told.dismissedAt !== undefined || !hasUncondensedPlaceholders(agentId)) return [];
    return [{ words: catchUpWords(agentId), severity: 'notice' as const, cardKey: cardKeyOf(agentId), dismiss: () => writeCatchUp(agentId, { ...told, dismissedAt: Date.now() }) }];
  });
}
