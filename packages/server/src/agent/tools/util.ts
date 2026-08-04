// ════════════════════════════════════════════════════════════════════════════
// TOOLBOX UTILITIES (PHASE-5 T4 — relocated from `agent/tools.ts`)
//
// The helpers a relocated handler needs that are not specific to any one
// category. Research 05 §(a) names this module in the split skeleton, and it
// exists for a structural reason rather than a tidiness one: a category module
// may NOT import `agent/tools.ts` (that would close the cycle the split is
// undoing), so anything a handler body used from that file has to move here
// first. This module imports only leaves and stores; nothing in the toolbox
// depends back on it.
//
// RELOCATION, NOT REWRITE. Each function below is the function that stood in
// `agent/tools.ts`, byte-faithful. `agent/tools.ts` now imports them from here
// rather than declaring them, so there is ONE copy and the audit rows the
// remaining switch writes and the ones a relocated handler writes are the same
// rows written by the same code.
// ════════════════════════════════════════════════════════════════════════════

import path from 'node:path';
// PHASE-5 T8 Step 3, and this module converted LAST on purpose. Its three
// filesystem PROBES run on the CALLER's grant — they are helpers, not tools —
// and all three answer their own `catch` with `null` / `{ opened: false }`,
// which is the right shape for a missing file and would be the WRONG shape for
// a refusal: the user would simply stop getting a download link or an
// "Open in canvas" chip, with no error anywhere. So it converted only after
// every caller's declaration was corrected, the ten call sites were enumerated
// and asserted covered (`agent/effects/__tests__/facade-contract.test.ts`), and
// the behaviour itself was pinned as an oracle that passed BEFORE the
// conversion and passes identically after it
// (`__tests__/canvas-chip-survives.test.ts`).
import * as effectFs from '../effects/fs.js';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { isDreamerAgent, isHealerAgent } from '../../config/platform.js';
import { getTunnelStatus } from '../../services/tunnel.js';
import { getCurrentToolCallId, currentTurnNumber, currentTurnRoot } from '../turn-state.js';
// A LEAF by construction (`credentials/secret-values.ts` imports nothing), which
// is why the toolbox's shared util can reach the declared-value set without
// re-opening the `secret-fields -> registry -> tools -> credentials/tools` cycle
// that module was split out of at T1.
import { redactHandedCredentials } from '../../credentials/secret-values.js';
import { broadcast } from '../../gateway/ws.js';
import { queueCanvasDoc } from '../pending-attachments.js';
import { setCurrentCanvas, getCurrentCanvas } from '../canvas-state.js';

/**
 * THE TOOLBOX LOGGER, shared rather than re-created per module.
 *
 * It is named `tools` because that is the name every one of these lines has
 * always carried, and a relocation that silently re-labels the operator's log
 * stream is not a relocation. A category module logs through this, so a line
 * emitted by a moved handler is byte-identical to the line it emitted from the
 * switch.
 */
export const toolsLogger = createLogger('tools');

// Map tool names to valid audit_log action_type values
const AUDIT_ACTION_MAP: Record<string, string> = {
  file_read: 'file_read',
  file_list: 'file_read',
  file_write: 'file_write',
  file_delete: 'file_write',
  exec: 'exec',
};

export function auditLog(agentId: string, actionType: string, target: string | null, result: 'success' | 'denied' | 'error', detail?: string, callId?: string | null): void {
  try {
    const db = getDb();
    // Normalize action_type to match the CHECK constraint
    const normalizedAction = AUDIT_ACTION_MAP[actionType] ?? 'tool_call';
    // PHASE-5 T6 — THE AUDIT ROW IS PART OF THE CREDENTIAL SEAM, and it was the
    // one copy the seam did not cover. A credential the agent legitimately
    // FETCHED and USED has to appear in the argv line for the command to work,
    // and `process-run.ts` audits that argv line verbatim — so the supported
    // capability was minting a plaintext copy in `audit_log.target` on every
    // single use (measured on the dev box: three exec calls, three rows).
    // `audit_log` has no TTL and rides the diagnostics export, so this is the
    // longest-lived copy the flow produced.
    //
    // The key is the DECLARED value set — values this process learned from a
    // tool's own `secret: true` field or handed out through `credential_get` —
    // never a value shape. An undeclared secret-shaped string is deliberately
    // left alone; `__tests__/audit-credential-redaction.test.ts` clause 4 pins
    // that, because shape-matching is the prose-keying this overhaul deletes.
    const safeTarget = target === null ? null : redactHandedCredentials(agentId, target);
    const safeDetail = detail === undefined ? null : redactHandedCredentials(agentId, detail);
    // P6a execution lineage: every audit row carries the turn that ran it and
    // the root it served, read from the live turn state (the receipts
    // pattern), plus the exact tool_use call id where the caller has one.
    const turnNumber = currentTurnNumber.get(agentId) ?? null;
    const root = currentTurnRoot.get(agentId) ?? null;
    db.prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, turn_number, call_id, root_kind, root_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(uuidv4(), agentId, normalizedAction, safeTarget, result, safeDetail,
      turnNumber, callId ?? getCurrentToolCallId(agentId), root?.kind ?? null, root?.id ?? null);
  } catch (err) {
    toolsLogger.error('Failed to write audit log', {
      error: err instanceof Error ? err.message : String(err),
    }, agentId);
  }
}

function getDownloadUrl(fileId: string): string {
  try {
    const tunnel = getTunnelStatus();
    if (tunnel.status === 'active' && tunnel.url) {
      // v2.7.25, strip any trailing slash on the tunnel URL so the
      // concatenation doesn't produce "https://host//api/...". User-
      // entered named-tunnel URLs often have a trailing slash from
      // copy-paste; the public-share.ts builder already normalizes
      // this way (see line 329), match that here too.
      const base = tunnel.url.replace(/\/+$/, '');
      return `${base}/api/upload/download/${fileId}`;
    }
  } catch { /* tunnel module may not be loaded yet */ }
  const port = process.env.DOJO_PORT ?? '3001';
  return `http://localhost:${port}/api/upload/download/${fileId}`;
}

/**
 * Strip the scheme+host off a download URL, leaving a same-origin path
 * (`/api/upload/download/<id>`). Use this for anything rendered INSIDE the
 * dashboard (<img>/<iframe> src). getDownloadUrl bakes in an absolute host
 * (the tunnel URL, else localhost:3001) which is only correct on the server's
 * own machine. When the dashboard is loaded from a LAN IP or the Cloudflare
 * tunnel, that "localhost" points at the viewing device, so the asset 404s
 * (broken-image icon). A bare path resolves against whatever origin the
 * user actually loaded the page from, so it works for localhost, a LAN IP, and
 * the tunnel alike. The download route is auth-exempt (unguessable UUID), so a
 * pathless <img> with no token still loads.
 */
export function toDashboardPath(downloadUrl: string): string {
  return downloadUrl.replace(/^https?:\/\/[^/]+/, '');
}

/** Register a file for sharing and return its full download URL */
export function registerSharedFile(agentId: string, filePath: string): string | null {
  try {
    const fileId = uuidv4();
    const filename = path.basename(filePath);
    const ext = path.extname(filename).toLowerCase();
    const mimeMap: Record<string, string> = {
      '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
      '.csv': 'text/csv', '.html': 'text/html', '.xml': 'application/xml',
      '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
      '.svg': 'image/svg+xml', '.zip': 'application/zip',
      '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    };
    const mimeType = mimeMap[ext] ?? 'application/octet-stream';
    const stat = effectFs.statSync(filePath);
    const db = getDb();
    db.prepare(`
      INSERT OR IGNORE INTO shared_files (id, agent_id, file_path, filename, mime_type, size, created_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(fileId, agentId, filePath, filename, mimeType, stat.size);
    return getDownloadUrl(fileId);
  } catch {
    return null;
  }
}

/**
 * FN-8: single source of truth for whether an agent may terminate its own
 * lifecycle via complete_task. complete_task ends a SPAWNED agent's lifecycle;
 * exposing it to a persistent agent (the primary, a role agent, a standalone
 * agent) lets the engine terminate a long-lived agent the moment the model
 * emits the tool, which violates the engine-enforces-correctness law.
 *
 * The rule: ordinary work spawns carry classification 'apprentice'; spawn-time
 * task linkage is agents.task_id; and the Dreamer and Healer are the only
 * PERSISTENT per-cycle consumers whose lifecycle legitimately ends in
 * complete_task (batch/cycle filing keys off it). Deliberately NOT keyed on
 * parent_agent: role agents spawned at setup with a parent (PM, trainer,
 * imaginer) must not be able to self-terminate. An exotic non-apprentice spawn
 * that loses self-completion degrades gracefully, the handler guard refuses
 * with guidance, and the spawner's engine-initiated timeout/kill path (which
 * bypasses the tool handler entirely) still reaps it.
 *
 * This predicate gates both the tool's availability (getFilteredTools) and the
 * handler's actual termination path.
 */
export function agentCanSelfComplete(
  agentId: string,
  fields: { classification: string | null; task_id: string | null },
): boolean {
  return (
    fields.classification === 'apprentice' ||
    fields.task_id != null ||
    isDreamerAgent(agentId) ||
    isHealerAgent(agentId)
  );
}

/**
 * FN-8: convenience wrapper that reads the agent row fresh, for callers (the
 * complete_task handler) that must re-check against current DB state rather than
 * a filter-time snapshot.
 */
export function agentCanSelfCompleteById(agentId: string): boolean {
  const row = getDb()
    .prepare('SELECT classification, task_id FROM agents WHERE id = ?')
    .get(agentId) as { classification: string | null; task_id: string | null } | undefined;
  if (!row) return false;
  return agentCanSelfComplete(agentId, row);
}

export function permissionDeniedMessage(reason: string | undefined, agentId: string): string {
  // FN-8: complete_task terminates a spawned agent's lifecycle, so only invite
  // it from agents that can actually self-complete. A persistent agent gets a
  // "tell the user" hint instead of being pointed at a tool it does not have.
  const canSelfComplete = agentCanSelfCompleteById(agentId);
  const steps = ["Try an alternative approach that doesn't require this permission"];
  if (canSelfComplete) {
    steps.push(`Call complete_task(status="blocked", summary="Need permission for: ${reason ?? 'this action'}") to report you are blocked`);
  }
  steps.push('Use send_to_agent to ask another agent that has the required permissions');
  if (!canSelfComplete) {
    steps.push('Or tell the user you are blocked so they can act');
  }
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `[BLOCKED] Permission denied: ${reason ?? 'not allowed'}\n\nThis operation is permanently blocked by your permission settings. Retrying will fail every time.\n\nInstead, you should:\n${numbered}`;
}

// ── THE CANVAS-OPEN CLUSTER (PHASE-5 T4) ────────────────────────────────────
// Six helpers that answer one question — "the agent just wrote a file; does the
// user get to SEE it?" — and every category that writes a file needs the answer:
// the fs verbs, the office block, the pdf interceptor in the executor, and the
// canvas verbs themselves. They lived in `agent/tools.ts` and a category module
// may not import that, so they live here, ONCE, byte-faithful.
// Tell any open canvas showing this file to re-fetch. The right dock matches on
// absolute path, so editing a document the user is watching (file_write /
// file_patch / file_append) refreshes the canvas with no manual step.
export function broadcastCanvasUpdate(agentId: string, filePath: string): void {
  try {
    broadcast({ type: 'canvas:updated', agentId, data: { path: filePath } });
  } catch { /* best effort, never let a UI ping break a file write */ }
}

// Everything the canvas can render. Used both to AUTO-OPEN a file the moment
// it's written/created (file_write, office, pdf) and to drop an "Open in
// canvas" chip on the reply so the user can re-open it later. Per the owner's
// choice, every type here auto-opens, documents, data, AND source/config code.
const CANVAS_VIEWABLE_EXTS = new Set([
  '.html', '.htm', '.md', '.markdown', '.txt', '.text', '.json', '.csv',
  '.docx', '.xlsx', '.xls', '.xlsm', '.pdf', '.svg',
  '.js', '.ts', '.tsx', '.jsx', '.py', '.css', '.xml', '.yaml', '.yml',
  '.sh', '.sql', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.toml',
]);

export function canvasMime(ext: string): string {
  switch (ext) {
    case '.pdf': return 'application/pdf';
    case '.html': case '.htm': return 'text/html';
    case '.json': return 'application/json';
    case '.csv': return 'text/csv';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xlsx': case '.xls': case '.xlsm': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.md': case '.markdown': return 'text/markdown';
    default: return 'text/plain';
  }
}

// Queue an "Open in canvas" reference onto the agent's reply for a doc it just
// showed, so the user can re-open it from the chat after closing the canvas.
export function queueCanvasDocAttachment(agentId: string, filePath: string, downloadUrl: string | null): void {
  try {
    const ext = path.extname(filePath).toLowerCase();
    if (!CANVAS_VIEWABLE_EXTS.has(ext)) return;
    const fileId = downloadUrl?.match(/\/download\/([^/?#]+)/)?.[1];
    if (!fileId) return;
    const stat = effectFs.statSync(filePath);
    const category = ext === '.pdf' ? 'pdf'
      : ext === '.docx' || ext === '.xlsx' || ext === '.xls' || ext === '.xlsm' ? 'office'
      : 'text';
    queueCanvasDoc(agentId, {
      fileId,
      filename: path.basename(filePath),
      mimeType: canvasMime(ext),
      size: stat.size,
      path: filePath,
      category,
      openInCanvas: true,
    });
  } catch { /* best effort, never let a UI chip break a tool */ }
}

// Keep the canvas in sync after writing a file. If the canvas is already showing
// this exact file, just refresh it. Otherwise, if it's anything the canvas can
// render (CANVAS_VIEWABLE_EXTS, documents, data, AND source/config code),
// AUTO-OPEN it in the dock, so "write me a page / doc / script" lands in the
// canvas without the model having to remember canvas_render (weaker models
// routinely don't, even when explicitly told to). Non-renderable writes only
// ping (a no-op unless some canvas already watches that path).
export function syncCanvasAfterWrite(agentId: string, filePath: string, downloadUrl: string | null): { opened: boolean } {
  const cur = getCurrentCanvas(agentId);
  if (cur?.kind === 'canvas' && cur.path === filePath) {
    broadcastCanvasUpdate(agentId, filePath);
    return { opened: false };
  }
  const ext = path.extname(filePath).toLowerCase();
  if (!CANVAS_VIEWABLE_EXTS.has(ext) || !downloadUrl) {
    broadcastCanvasUpdate(agentId, filePath);
    return { opened: false };
  }
  let url = downloadUrl;
  if (/\/api\/upload\/download\/[^?#]+/.test(url) && !/[?&]inline=1\b/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + 'inline=1';
  }
  const title = path.basename(filePath);
  try {
    broadcast({ type: 'dock:open', agentId, data: { kind: 'canvas', url, title, path: filePath } });
    setCurrentCanvas(agentId, { kind: 'canvas', url, path: filePath, title });
    queueCanvasDocAttachment(agentId, filePath, downloadUrl);
    return { opened: true };
  } catch {
    return { opened: false };
  }
}

// Open an arbitrary on-disk file in the canvas (register it, then broadcast the
// dock:open). Used to AUTO-OPEN Office documents the moment they're created, 
// the same "it just appears in the canvas" behaviour html/md/txt get from
// syncCanvasAfterWrite. Without this the model has to pick canvas_render over
// show_to_user / share_file, and weak models reliably pick the wrong one (a
// .docx via show_to_user is a useless download chip, not a preview).
export function openFileInCanvas(agentId: string, filePath: string): { opened: boolean } {
  try {
    if (!effectFs.existsSync(filePath)) return { opened: false };
    // Already showing this exact file (e.g. an in-place edit to the open doc)?
    // Just refresh it rather than re-opening, the canvas re-fetches/re-renders.
    const cur = getCurrentCanvas(agentId);
    if (cur?.kind === 'canvas' && cur.path === filePath) {
      broadcastCanvasUpdate(agentId, filePath);
      return { opened: true };
    }
    const registered = registerSharedFile(agentId, filePath);
    if (!registered) return { opened: false };
    let url = registered;
    if (/\/api\/upload\/download\/[^?#]+/.test(url) && !/[?&]inline=1\b/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'inline=1';
    }
    const title = path.basename(filePath);
    broadcast({ type: 'dock:open', agentId, data: { kind: 'canvas', url, title, path: filePath } });
    setCurrentCanvas(agentId, { kind: 'canvas', url, path: filePath, title });
    queueCanvasDocAttachment(agentId, filePath, registered);
    return { opened: true };
  } catch {
    return { opened: false };
  }
}

// Office tools report the saved file as "...created locally at <path> (<n>
// bytes)" (create) or "Saved to <path>." (in-place edit). Pull that local path
// back out so we can auto-open / refresh the canvas. Only the local-save
// branch matches (OneDrive results carry a file_id + webUrl, no on-disk path).
// Uploads filenames are sanitized (no spaces), so \S+ is safe.
export function localOfficePathFromResult(result: string): string | null {
  const created = result.match(/created locally at (\/\S+\.(?:docx|xlsx|xls|xlsm))\s*\(\d+\s*bytes\)/i);
  if (created) return created[1];
  const saved = result.match(/\bSaved to (\/\S+\.(?:docx|xlsx|xls|xlsm))\./i);
  return saved ? saved[1] : null;
}
