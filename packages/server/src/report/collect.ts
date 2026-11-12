// Six readers, one inline prepared statement each: `check-sql-prepares.mjs` only checks literal SQL.
// `turns`, `cost_records`, `audit_log`, `agent_tool_failures` store text `YYYY-MM-DD HH:MM:SS` (`sqlStamp`);
// `work` stores epoch ms (`opened_at`). Every ORDER BY has a tie-break (`signature.ts` hashes heads).

import { getDb } from '../db/connection.js';
import { getFilteredTools } from '../agent/tools/surface.js';
import { getReceiptMode } from '../agent/v2/receipt.js';
import { COLLECTOR_CAPS } from './window.js';
import type { SettingsFacts } from './telemetry-build.js';

export interface Row { [k: string]: unknown }


export function sqlStamp(iso: string): string { return iso.slice(0, 19).replace('T', ' '); }

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const numOrNull = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// `duration_ms` is computed in SQL because the stored shape is not ISO; an open turn yields NULL.
// `Math.min` binds the window at the statement so no caller can widen the read.
export function readTurns(agentId: string, since: string, turns: number): Row[] {
  return getDb().prepare(
    `SELECT kind, subject_kind, lane, exit_reason, answered, effectful_calls, started_at, ended_at,
            CAST(ROUND((julianday(ended_at) - julianday(started_at)) * 86400000) AS INTEGER) AS duration_ms
       FROM turns WHERE agent_id = ? AND started_at >= ?
      ORDER BY turn_number DESC LIMIT ?`,
  ).all(agentId, since, Math.min(turns, COLLECTOR_CAPS.turns)) as Row[];
}

/** The provider NAME is user-typed text and is never selected; `model_id` only assigns an ordinal. */
export function readCalls(agentId: string, since: string): Row[] {
  return getDb().prepare(
    `SELECT p.type AS provider_kind, c.model_id, c.request_type, c.input_tokens, c.output_tokens,
            c.cache_read_tokens, c.cache_creation_tokens, c.latency_ms, c.estimated_input_tokens
       FROM cost_records c LEFT JOIN providers p ON p.id = c.provider_id
      WHERE c.agent_id = ? AND c.created_at >= ?
      ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
  ).all(agentId, since, COLLECTOR_CAPS.calls) as Row[];
}

/** `target` and `detail` are for the local bundle only: they carry user paths and interpolated messages. */
export function readAudit(agentId: string, since: string): Row[] {
  return getDb().prepare(
    `SELECT action_type, target, result, detail, call_id, created_at
       FROM audit_log WHERE agent_id = ? AND created_at >= ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(agentId, since, COLLECTOR_CAPS.toolCalls) as Row[];
}

/** Tool failures. A success DELETES the row, so this is live streaks only. */
export function readFailures(agentId: string, since: string): Row[] {
  return getDb().prepare(
    `SELECT tool_name, hit_count, last_at FROM agent_tool_failures
      WHERE agent_id = ? AND last_at >= ? ORDER BY hit_count DESC, tool_name ASC LIMIT ?`,
  ).all(agentId, since, COLLECTOR_CAPS.toolFailures) as Row[];
}

export function readWork(agentId: string, sinceMs: number): Row[] {
  return getDb().prepare(
    `SELECT kind, state, opened_at, updated_at FROM work
      WHERE agent_id = ? AND updated_at >= ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
  ).all(agentId, sinceMs, COLLECTOR_CAPS.work) as Row[];
}

/** A constructed seven-field record, never `getAllPlatformConfig()` (unredacted); `model_id` is nullable. */
export function readSettings(agentId: string): SettingsFacts {
  const row = (getDb().prepare(
    `SELECT p.type AS provider_kind, p.behaves_like, p.first_chunk_timeout_ms, p.stream_idle_timeout_ms,
            p.prefill_tokens_per_sec
       FROM agents a LEFT JOIN models m ON m.id = a.model_id
                     LEFT JOIN providers p ON p.id = m.provider_id
      WHERE a.id = ? LIMIT 1`,
  ).get(agentId) ?? {}) as Row;
  return {
    providerKind: str(row.provider_kind), behavesLike: str(row.behaves_like),
    firstChunkTimeoutMs: numOrNull(row.first_chunk_timeout_ms),
    streamIdleTimeoutMs: numOrNull(row.stream_idle_timeout_ms),
    prefillTokensPerSec: numOrNull(row.prefill_tokens_per_sec),
    toolsGrantedCount: getFilteredTools(agentId).length,
    contextReceiptMode: getReceiptMode(),
  };
}
