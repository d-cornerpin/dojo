// ════════════════════════════════════════
// Microsoft 365 Activity Log
// Every Graph API call (read + write) gets logged here
// ════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';

const logger = createLogger('ms-activity');

export interface MicrosoftActivityEntry {
  id: string;
  agentId: string;
  agentName: string | null;
  action: string;
  actionType: 'read' | 'write';
  details: string | null;
  apiEndpoint: string | null;
  success: boolean;
  error: string | null;
  createdAt: string;
}

export interface LogMsActivityParams {
  agentId: string;
  agentName: string | null;
  action: string;
  actionType: 'read' | 'write';
  details: string | null;
  apiEndpoint: string | null;
  success: boolean;
  error?: string | null;
}

export function logMicrosoftActivity(params: LogMsActivityParams): void {
  try {
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO microsoft_activity (id, agent_id, agent_name, action, action_type, details, api_endpoint, success, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      id,
      params.agentId,
      params.agentName,
      params.action,
      params.actionType,
      params.details,
      params.apiEndpoint,
      params.success ? 1 : 0,
      params.error ?? null,
    );
  } catch (err) {
    logger.error('Failed to log Microsoft activity', {
      error: err instanceof Error ? err.message : String(err),
      action: params.action,
    });
  }
}

export interface MsActivityQuery {
  agentId?: string;
  action?: string;
  actionType?: 'read' | 'write';
  limit?: number;
  offset?: number;
}

export function queryMicrosoftActivity(query: MsActivityQuery): MicrosoftActivityEntry[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (query.agentId) { conditions.push('agent_id = ?'); params.push(query.agentId); }
  if (query.action) { conditions.push('action = ?'); params.push(query.action); }
  if (query.actionType) { conditions.push('action_type = ?'); params.push(query.actionType); }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = query.limit ?? 50;
  const offset = query.offset ?? 0;

  const rows = db.prepare(`
    SELECT id, agent_id, agent_name, action, action_type, details, api_endpoint, success, error, created_at
    FROM microsoft_activity
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as Array<{
    id: string; agent_id: string; agent_name: string | null; action: string;
    action_type: string; details: string | null; api_endpoint: string | null;
    success: number; error: string | null; created_at: string;
  }>;

  return rows.map(row => ({
    id: row.id,
    agentId: row.agent_id,
    agentName: row.agent_name,
    action: row.action,
    actionType: row.action_type as 'read' | 'write',
    details: row.details,
    apiEndpoint: row.api_endpoint,
    success: row.success === 1,
    error: row.error,
    createdAt: row.created_at,
  }));
}

export function getTodayMsActivityCounts(): { reads: number; writes: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN action_type = 'read' THEN 1 ELSE 0 END) as reads,
      SUM(CASE WHEN action_type = 'write' THEN 1 ELSE 0 END) as writes
    FROM microsoft_activity
    WHERE date(created_at) = date('now')
  `).get() as { reads: number | null; writes: number | null } | undefined;

  return { reads: row?.reads ?? 0, writes: row?.writes ?? 0 };
}

export function getLastMsActivityTimestamp(): string | null {
  const db = getDb();
  const row = db.prepare('SELECT created_at FROM microsoft_activity ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined;
  return row?.created_at ?? null;
}
