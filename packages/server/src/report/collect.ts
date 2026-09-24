// ════════════════════════════════════════════════════════════════════════════
// THE SIX READERS — ONE PREPARED STATEMENT EACH (DOJO-REPORT T3)
//
// The spec says "no new collectors". Measured at this HEAD that is impossible as
// written: there is no agent-scoped windowed log slice, no recent-turns reader
// and no agent+window audit reader anywhere in the tree. The plan therefore
// resolves it as NO NEW EVIDENCE SOURCES, and this file is that resolution —
// six SELECTs against tables that already hold these facts. No new table is
// written, no hot path is instrumented, no subsystem is born.
//
// Split out of `gather.ts` at the growth gate (an unpinned file crossing 240
// lines fails `check-growth.mjs` rule 2). The seam is real rather than
// arithmetic: everything here is a QUERY, everything next door is the SHAPING of
// what the queries returned, and the shaping is where the privacy split lives.
//
// ── THE STAMP FORMATS ARE NOT UNIFORM, AND THE PLAN'S PINNED SQL ASSUMED THEY
//    WERE ──
// `turns`, `cost_records`, `audit_log` and `agent_tool_failures` store TEXT in
// SQLite's `datetime('now')` shape (`YYYY-MM-DD HH:MM:SS`). `work` stores
// INTEGER epoch MILLISECONDS and HAS NO `created_at` COLUMN AT ALL — its
// creation stamp is `opened_at` (migration 135). Binding an ISO string against
// the TEXT columns compares `'T'` (0x54) against `' '` (0x20) and therefore
// matches NOTHING, silently: a window that looked bounded would have been a
// window that was always empty, on every box, forever. Both are corrections to
// the plan's pinned statements, re-derived against the migration chain.
//
// ── EVERY ORDER BY CARRIES A TIE-BREAK ──
// `signature.ts` warns that only the HEAD of each ranked list reaches the
// `ds1-` token. Two boxes with the same evidence must rank it the same way, or
// the dedupe is theatre — so no ordering here is allowed to be ambiguous.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getFilteredTools } from '../agent/tools/surface.js';
import { getReceiptMode } from '../agent/v2/receipt.js';
import { COLLECTOR_CAPS } from './window.js';
import type { SettingsFacts } from './telemetry-build.js';

/** A raw row. Deliberately untyped: `better-sqlite3` hands back `any` and the
 *  coercers below are the one place that is narrowed (T1 note N1). */
export interface Row { [k: string]: unknown }

// ── EVERY STATEMENT BELOW IS AN INLINE LITERAL, AND THAT IS THE POINT ──
// The first cut of this file routed all six through one `all(sql, params)` helper.
// It was shorter and it was wrong: `check-sql-prepares.mjs` extracts on the regex
// `/\.prepare\(\s*(['"`])/`, so a statement handed in as a VARIABLE is never seen
// by the gate — the file would have looked compliant while being the one place in
// the tree whose SQL nothing checked. The gate builds the real schema from the
// migration chain and prepares each literal against it, which is exactly what
// catches `work.created_at` (a column that does not exist) at build time instead
// of in a silent empty window. Repetition is the price of being checkable.

/** ISO → the `datetime('now')` text the four TEXT-stamped tables actually store. */
export function sqlStamp(iso: string): string { return iso.slice(0, 19).replace('T', ' '); }

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
export const numOrNull = (v: unknown): number | null =>
  (typeof v === 'number' && Number.isFinite(v) ? v : null);
export const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * 1. TURNS. `duration_ms` is computed by SQLite rather than by `Date.parse`,
 * because the stored shape is not ISO and JS reads it as LOCAL time; `julianday`
 * reads both stored shapes as UTC. A NULL `ended_at` — an OPEN turn, which is
 * exactly what a `silence`-lane report captures — yields NULL, never a
 * fabricated duration. Ordered by the primary key, so the sort is free.
 */
export function readTurns(agentId: string, since: string): Row[] {
  return getDb().prepare(
    `SELECT kind, subject_kind, lane, exit_reason, answered, effectful_calls, started_at, ended_at,
            CAST(ROUND((julianday(ended_at) - julianday(started_at)) * 86400000) AS INTEGER) AS duration_ms
       FROM turns WHERE agent_id = ? AND started_at >= ?
      ORDER BY turn_number DESC LIMIT ?`,
  ).all(agentId, since, COLLECTOR_CAPS.turns) as Row[];
}

/**
 * 2. MODEL CALLS. `providers.type` is joined for the KIND; the provider's NAME is
 * text the USER typed ("Dave's Mac Studio") and is never selected. `model_id` is
 * read only to assign an ordinal and is discarded before anything reaches the
 * attachment. Covered end to end by `idx_cost_agent_created`.
 */
export function readCalls(agentId: string, since: string): Row[] {
  return getDb().prepare(
    `SELECT p.type AS provider_kind, c.model_id, c.request_type, c.input_tokens, c.output_tokens,
            c.cache_read_tokens, c.cache_creation_tokens, c.latency_ms, c.estimated_input_tokens
       FROM cost_records c LEFT JOIN providers p ON p.id = c.provider_id
      WHERE c.agent_id = ? AND c.created_at >= ?
      ORDER BY c.created_at DESC, c.id DESC LIMIT ?`,
  ).all(agentId, since, COLLECTOR_CAPS.calls) as Row[];
}

/**
 * 3. TOOL-CALL OUTCOMES. `target` and `detail` are selected FOR THE LOCAL BUNDLE
 * ONLY: they carry the user's file paths and the platform's interpolated
 * messages, and T1's whitelist names both as forbidden sources. `call_id` is the
 * join key to the `tool_use` block that names the tool.
 */
export function readAudit(agentId: string, since: string): Row[] {
  return getDb().prepare(
    `SELECT action_type, target, result, detail, call_id, created_at
       FROM audit_log WHERE agent_id = ? AND created_at >= ?
      ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(agentId, since, COLLECTOR_CAPS.toolCalls) as Row[];
}

/** 4. TOOL FAILURES. A success DELETES the row, so this is live streaks only. */
export function readFailures(agentId: string, since: string): Row[] {
  return getDb().prepare(
    `SELECT tool_name, hit_count, last_at FROM agent_tool_failures
      WHERE agent_id = ? AND last_at >= ? ORDER BY hit_count DESC, tool_name ASC LIMIT ?`,
  ).all(agentId, since, COLLECTOR_CAPS.toolFailures) as Row[];
}

/** 5. WORK. Epoch MILLISECONDS, and the creation stamp is `opened_at` (header). */
export function readWork(agentId: string, sinceMs: number): Row[] {
  return getDb().prepare(
    `SELECT kind, state, opened_at, updated_at FROM work
      WHERE agent_id = ? AND updated_at >= ? ORDER BY updated_at DESC, id DESC LIMIT ?`,
  ).all(agentId, sinceMs, COLLECTOR_CAPS.work) as Row[];
}

/**
 * 6. SETTINGS. THIS READER IS THE SPEC'S "REDACTED CONFIG SNAPSHOT", built as a
 * CONSTRUCTED eight-field record — `getAllPlatformConfig()` returns the whole
 * `config` table unredacted and is deliberately never called here. LEFT JOINs
 * because `agents.model_id` is nullable: an agent with no model yields nulls,
 * not a dropped row and not a thrown query.
 */
export function readSettings(agentId: string): SettingsFacts {
  const row = (getDb().prepare(
    `SELECT p.type AS provider_kind, p.behaves_like, p.first_chunk_timeout_ms, p.stream_idle_timeout_ms,
            p.max_unattended_minutes, p.prefill_tokens_per_sec
       FROM agents a LEFT JOIN models m ON m.id = a.model_id
                     LEFT JOIN providers p ON p.id = m.provider_id
      WHERE a.id = ? LIMIT 1`,
  ).get(agentId) ?? {}) as Row;
  return {
    providerKind: str(row.provider_kind), behavesLike: str(row.behaves_like),
    firstChunkTimeoutMs: numOrNull(row.first_chunk_timeout_ms),
    streamIdleTimeoutMs: numOrNull(row.stream_idle_timeout_ms),
    maxUnattendedMinutes: numOrNull(row.max_unattended_minutes),
    prefillTokensPerSec: numOrNull(row.prefill_tokens_per_sec),
    toolsGrantedCount: getFilteredTools(agentId).length,
    // Binding forward from T1: the RESOLVED mode through its front door, never the
    // raw `config` row — `DOJO_RECEIPT_MODE` outranks the row and only this knows it.
    contextReceiptMode: getReceiptMode(),
  };
}
