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

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { createLogger } from '../../logger.js';
import { isDreamerAgent, isHealerAgent } from '../../config/platform.js';
import { getTunnelStatus } from '../../services/tunnel.js';
import { getCurrentToolCallId, currentTurnNumber, currentTurnRoot } from '../turn-state.js';

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
    // P6a execution lineage: every audit row carries the turn that ran it and
    // the root it served, read from the live turn state (the receipts
    // pattern), plus the exact tool_use call id where the caller has one.
    const turnNumber = currentTurnNumber.get(agentId) ?? null;
    const root = currentTurnRoot.get(agentId) ?? null;
    db.prepare(`
      INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, turn_number, call_id, root_kind, root_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(uuidv4(), agentId, normalizedAction, target, result, detail ?? null,
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
    const stat = fs.statSync(filePath);
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
