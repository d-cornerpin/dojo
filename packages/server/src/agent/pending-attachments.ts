// ════════════════════════════════════════
// Pending Attachments (P6b-2c: durable turn_artifacts rows, migrations 121/122)
//
// Files queued via show_to_user (plus canvas-doc and screen chips) that should
// ride the agent's next persisted assistant message. Why a queue instead of
// inserting an assistant message during the tool call: persisting an extra
// assistant row mid-tool-loop breaks the strict assistant→tool→assistant
// alternation the model expects, confuses the model into re-calling
// show_to_user, and inflates the chat with synthetic bubbles.
//
// P6b-2c rekey: the queue is turn_artifacts ROWS, not an in-memory map. The
// map could strand its contents on a crash/reload (the 2026-06-06 lost-report
// incident class); rows survive, carry the queueing turn + payload, and a
// drain is an UPDATE of delivered_at, so "was this surfaced" is durable state
// instead of process memory. The end-of-turn surfacing paths in the loop stop
// being safety nets over fragile state and become plain consumers of the
// undelivered set. The old per-session filename dedup died with the rekey:
// delivered_at itself is the once-only guarantee, and a re-generated file in
// a later turn is a new artifact that legitimately surfaces again.
//
// clearPendingAttachments / peekPendingAttachmentCount had no callers left
// and were dropped in the rekey.
// ════════════════════════════════════════
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { currentTurnNumber } from './turn-state.js';

const logger = createLogger('pending-attachments');

export interface PendingAttachment {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  category: 'image' | 'pdf' | 'text' | 'office' | 'audio' | 'video' | 'unknown';
  /** A canvas-viewable document the agent opened in the right dock this turn.
   * The dashboard renders an "Open in canvas" affordance for these (so the
   * user can re-open it from the chat after closing the canvas). */
  openInCanvas?: boolean;
  /** The agent opened the live screen-share viewer this turn. The dashboard
   * renders an "Open screen" chip so the user can re-open it after closing. */
  screenShare?: boolean;
}

function insertArtifact(
  agentId: string,
  kind: 'attachment' | 'canvas' | 'screen',
  att: PendingAttachment,
  caption: string | null,
): void {
  getDb().prepare(`
    INSERT INTO turn_artifacts (id, agent_id, turn_number, kind, path, caption, payload_json, queued_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))
  `).run(
    uuidv4(),
    agentId,
    currentTurnNumber.get(agentId) ?? null,
    kind,
    att.path || null,
    caption,
    JSON.stringify(att),
  );
}

export function queuePendingAttachments(
  agentId: string,
  attachments: PendingAttachment[],
  caption?: string,
): void {
  if (attachments.length === 0) return;
  try {
    const cap = caption && caption.trim().length > 0 ? caption.trim() : null;
    // The caption belongs to the queue CALL; carry it on the first row of the
    // batch so drains reproduce the old parallel-captions ordering.
    attachments.forEach((att, i) => insertArtifact(agentId, 'attachment', att, i === 0 ? cap : null));
  } catch (err) {
    logger.warn('queuePendingAttachments failed (files will not surface this turn)', {
      agentId, count: attachments.length, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

/**
 * Queue an "open in canvas" document reference onto the agent's next assistant
 * message, deduped by path so repeated edits in one turn don't stack chips.
 */
export function queueCanvasDoc(agentId: string, att: PendingAttachment): void {
  try {
    const dup = getDb().prepare(
      `SELECT 1 FROM turn_artifacts
        WHERE agent_id = ? AND kind = 'canvas' AND path = ? AND delivered_at IS NULL LIMIT 1`,
    ).get(agentId, att.path);
    if (dup) return;
    insertArtifact(agentId, 'canvas', att, null);
  } catch (err) {
    logger.warn('queueCanvasDoc failed (chip will not surface)', {
      agentId, path: att.path, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

/**
 * Queue a single "Open screen" chip onto the agent's next assistant message
 * (deduped, one undelivered at a time) so the user can re-open the live screen
 * viewer after closing the canvas. Carries no file; just the screenShare flag.
 */
export function queueScreenChip(agentId: string): void {
  try {
    const dup = getDb().prepare(
      `SELECT 1 FROM turn_artifacts
        WHERE agent_id = ? AND kind = 'screen' AND delivered_at IS NULL LIMIT 1`,
    ).get(agentId);
    if (dup) return;
    insertArtifact(agentId, 'screen', {
      fileId: 'screen', filename: 'Screen', mimeType: 'application/x-dojo-screen',
      size: 0, path: '__screen__', category: 'unknown', screenShare: true,
    }, null);
  } catch (err) {
    logger.warn('queueScreenChip failed (chip will not surface)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

interface ArtifactRow { id: string; caption: string | null; payload_json: string | null }

/** The undelivered set, oldest first, marked delivered atomically. */
function drainRows(agentId: string): ArtifactRow[] {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, caption, payload_json FROM turn_artifacts
      WHERE agent_id = ? AND delivered_at IS NULL AND kind != 'link'
      ORDER BY queued_at ASC, rowid ASC`,
  ).all(agentId) as ArtifactRow[];
  if (rows.length === 0) return [];
  const mark = db.prepare(
    "UPDATE turn_artifacts SET delivered_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND delivered_at IS NULL",
  );
  const txn = db.transaction(() => { for (const r of rows) mark.run(r.id); });
  txn();
  return rows;
}

function rowsToAttachments(rows: ArtifactRow[]): PendingAttachment[] {
  const out: PendingAttachment[] = [];
  for (const r of rows) {
    if (!r.payload_json) continue;
    try { out.push(JSON.parse(r.payload_json) as PendingAttachment); } catch { /* skip a corrupt row */ }
  }
  return out;
}

export function drainPendingAttachments(agentId: string): PendingAttachment[] {
  try {
    return rowsToAttachments(drainRows(agentId));
  } catch (err) {
    logger.warn('drainPendingAttachments failed (returning empty; rows stay undelivered for the next drain)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return [];
  }
}

/**
 * Drain attachments AND any captions captured from show_to_user calls. Used by
 * the end-of-turn surfacing paths when the model finished without terminal
 * text; the captions become the bubble text.
 */
export function drainPendingAttachmentsWithCaptions(
  agentId: string,
): { attachments: PendingAttachment[]; captions: string[] } {
  try {
    const rows = drainRows(agentId);
    return {
      attachments: rowsToAttachments(rows),
      captions: rows.map((r) => r.caption).filter((c): c is string => !!c && c.trim().length > 0),
    };
  } catch (err) {
    logger.warn('drainPendingAttachmentsWithCaptions failed (returning empty; rows stay undelivered)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return { attachments: [], captions: [] };
  }
}


// ── Download-link artifacts (P6b-2 final batch) ──
// file_write / file_append record the download URL they minted as a keyed row
// at the SOURCE (they hold url + path as variables), so the loop's
// never-drop-the-link backstop reads rows instead of regex-mining tool-result
// prose. kind='link' rows are excluded from the attachment drains above.

export function queueLinkArtifact(agentId: string, url: string, filePath: string): void {
  try {
    getDb().prepare(`
      INSERT INTO turn_artifacts (id, agent_id, turn_number, kind, path, caption, payload_json, queued_at, created_at, updated_at)
      VALUES (?, ?, ?, 'link', ?, NULL, ?, datetime('now'), datetime('now'), datetime('now'))
    `).run(uuidv4(), agentId, currentTurnNumber.get(agentId) ?? null, filePath, JSON.stringify({ url }));
  } catch (err) {
    logger.warn('queueLinkArtifact failed (backstop will not see this link)', {
      agentId, path: filePath, error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

/** This turn's undelivered link artifacts, marked delivered atomically. */
export function drainTurnLinkArtifacts(agentId: string, turnNumber: number): Array<{ url: string; path: string | null }> {
  try {
    const db = getDb();
    const rows = db.prepare(
      `SELECT id, path, payload_json FROM turn_artifacts
        WHERE agent_id = ? AND kind = 'link' AND turn_number = ? AND delivered_at IS NULL
        ORDER BY queued_at ASC, rowid ASC`,
    ).all(agentId, turnNumber) as Array<{ id: string; path: string | null; payload_json: string | null }>;
    if (rows.length === 0) return [];
    const mark = db.prepare("UPDATE turn_artifacts SET delivered_at = datetime('now'), updated_at = datetime('now') WHERE id = ?");
    const txn = db.transaction(() => { for (const r of rows) mark.run(r.id); });
    txn();
    const out: Array<{ url: string; path: string | null }> = [];
    for (const r of rows) {
      if (!r.payload_json) continue;
      try {
        const p = JSON.parse(r.payload_json) as { url?: string };
        if (p.url) out.push({ url: p.url, path: r.path });
      } catch { /* skip a corrupt row */ }
    }
    return out;
  } catch (err) {
    logger.warn('drainTurnLinkArtifacts failed (returning empty)', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return [];
  }
}
