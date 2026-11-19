// Toolbox helpers shared by relocated handlers: a category module may NOT import
// `agent/tools.ts` (that closes the cycle the split undoes), so shared helpers live here.

import path from 'node:path';
// The fs probes below answer their own `catch` with null / { opened: false }: they run on
// the caller's grant, not as tools. Null means "no file", never "refused".
import * as effectFs from '../effects/fs.js';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { isDreamerAgent, isHealerAgent } from '../../config/platform.js';
import { getTunnelStatus } from '../../services/tunnel.js';
import { getCurrentToolCallId } from '../turn-state.js';
import { turnStamp } from '../turn-context.js';
import { userWords, currentAddress } from '../v2/turn-address.js';
// A leaf (imports nothing): importing credentials/secret-fields.ts here would re-open the
// secret-fields -> registry -> tools cycle.
import { redactHandedCredentials } from '../../credentials/secret-values.js';
import { broadcast } from '../../gateway/ws.js';
import { queueCanvasDoc } from '../pending-attachments.js';
import { setCurrentCanvas, getCurrentCanvas } from '../canvas-state.js';

/** Shared toolbox logger: log through this, so every line carries the `tools` label. */
export const toolsLogger = createLogger('tools');

const AUDIT_ACTION_MAP: Record<string, string> = {
  file_read: 'file_read',
  file_list: 'file_read',
  file_write: 'file_write',
  exec: 'exec',
};

export function auditLog(agentId: string, actionType: string, target: string | null, result: 'success' | 'denied' | 'error', detail?: string, callId?: string | null): void {
  try {
    const db = getDb();
    // Normalize action_type to match the CHECK constraint
    const normalizedAction = AUDIT_ACTION_MAP[actionType] ?? 'tool_call';
    // Audit rows are a credential seam: no TTL, they ride the diagnostics export. Redact
    // against the DECLARED value set, never a value shape; an undeclared string is left alone.
    const safeTarget = target === null ? null : redactHandedCredentials(agentId, target);
    const safeDetail = detail === undefined ? null : redactHandedCredentials(agentId, detail);
    // Every audit row carries the turn that ran it, the root it served, and the call id.
    const { turnNumber, root } = turnStamp(agentId);
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
      // Strip any trailing slash: copy-pasted tunnel URLs often carry one and the join
      // would produce "host//api/...". The public-share.ts builder normalizes the same way.
      const base = tunnel.url.replace(/\/+$/, '');
      return `${base}/api/upload/download/${fileId}`;
    }
  } catch { /* tunnel module may not be loaded yet */ }
  const port = process.env.DOJO_PORT ?? '3001';
  return `http://localhost:${port}/api/upload/download/${fileId}`;
}

/** Where a link opens: from anywhere while the Cloudflare tunnel runs, else only on this Mac. */
export function linkReach(url: string): string {
  return /^https?:\/\/localhost[:/]/i.test(url)
    ? 'No tunnel is running, so this link only works on this Mac. To open it from another device, start the Cloudflare tunnel from the dashboard and ask for the link again.'
    : 'The Cloudflare tunnel is active, so this link opens from anywhere on the internet.';
}

/** For anything rendered INSIDE the dashboard: the absolute URL's host is only right on the
 * server's own machine, so a bare path is used; the route is auth-exempt by unguessable UUID. */
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

/** THE SINGLE SOURCE for whether an agent may end its own lifecycle via complete_task:
 * apprentice classification, a task_id, or the Dreamer/Healer. Deliberately NOT keyed on
 * parent_agent: role agents spawned with a parent must not self-terminate. Gates the tool. */
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

/** Reads the agent row fresh, for callers that must re-check current DB state, not a snapshot. */
export function agentCanSelfCompleteById(agentId: string): boolean {
  const row = getDb()
    .prepare('SELECT classification, task_id FROM agents WHERE id = ?')
    .get(agentId) as { classification: string | null; task_id: string | null } | undefined;
  if (!row) return false;
  return agentCanSelfComplete(agentId, row);
}

export function permissionDeniedMessage(reason: string | undefined, agentId: string): string {
  // complete_task ends a spawned agent's lifecycle, so only invite it from agents that can self-complete.
  const canSelfComplete = agentCanSelfCompleteById(agentId);
  const steps = ["Try an alternative approach that doesn't require this permission"];
  if (canSelfComplete) {
    steps.push(`Call complete_task(status="blocked", summary="Need permission for: ${reason ?? 'this action'}") to report you are blocked`);
  }
  steps.push('Use send_to_agent to ask another agent that has the required permissions');
  if (!canSelfComplete) {
    steps.push(`Or tell ${userWords(currentAddress(agentId))} you are blocked so they can act`);
  }
  const numbered = steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  return `[BLOCKED] Permission denied: ${reason ?? 'not allowed'}\n\nThis operation is permanently blocked by your permission settings. Retrying will fail every time.\n\nInstead, you should:\n${numbered}`;
}

// The canvas-open cluster: six helpers answering "the agent wrote a file; does the user get
// to SEE it?", needed by every category that writes and unable to live in `agent/tools.ts`.
// The update ping below matches the dock on absolute path, so an in-place edit to a document
// the user is watching refreshes it with no manual step.
export function broadcastCanvasUpdate(agentId: string, filePath: string): void {
  try {
    broadcast({ type: 'canvas:updated', agentId, data: { path: filePath } });
  } catch { /* best effort, never let a UI ping break a file write */ }
}

// Everything the canvas can render. Drives the auto-open on write and the "Open in canvas"
// chip; documents, data, AND source/config files all auto-open.
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

// Keep the canvas in sync after a write: already showing this exact file, refresh; else if
// renderable, AUTO-OPEN, so "write me a page" lands in the canvas without canvas_render.
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

// Open an on-disk file in the canvas (register, then dock:open), so Office documents
// "just appear" the way html/md/txt do via syncCanvasAfterWrite; a chip is not a preview.
export function openFileInCanvas(agentId: string, filePath: string): { opened: boolean } {
  try {
    if (!effectFs.existsSync(filePath)) return { opened: false };
    // Already showing this exact file (an in-place edit)? Refresh, don't re-open.
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

// Pull the local save path out of an Office result (OneDrive has a file_id, no path) to
// auto-open or refresh the canvas. Upload names have no spaces, so the \S+ patterns are safe.
export function localOfficePathFromResult(result: string): string | null {
  const created = result.match(/created locally at (\/\S+\.(?:docx|xlsx|xls|xlsm))\s*\(\d+\s*bytes\)/i);
  if (created) return created[1];
  const saved = result.match(/\bSaved to (\/\S+\.(?:docx|xlsx|xls|xlsm))\./i);
  return saved ? saved[1] : null;
}
