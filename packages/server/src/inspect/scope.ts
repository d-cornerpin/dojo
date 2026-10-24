// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect B1 — WHO and WHEN, shared by every view that reads records.
//
// TIME. The records keep time two ways: epoch milliseconds (`messages`, `work_events`) and
// SQLite's `datetime('now')` text in UTC (`audit_log`, `tool_receipts`, `deliveries`, `turns`).
// Every view prints one form, `2026-10-19 09:23:07 UTC`, so lines from different tables and the
// log sort and read as one story.
//
// AROUND. "Around a moment" is the TURN that moment falls in, never a fixed number of minutes:
// around a message is that message's turn; around a time is from the start of the latest turn
// that began at or before it to the end of the earliest turn that ended at or after it. That is
// the span in which something was happening, measured, not guessed.
//
// AGENTS. An agent is named by id or name. One that no longer exists is still answered from the
// records that remain, labelled "(agent deleted)".
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';

/** Epoch ms from an ISO string, a SQLite UTC datetime, or epoch ms (number or digits). */
export function toMs(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = v.trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s) ? `${s.replace(' ', 'T')}Z` : s;
  const ms = Date.parse(sqlite);
  return Number.isNaN(ms) ? null : ms;
}

/** `2026-10-19 09:23:07 UTC`. */
export function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** The SQL expression that reads a time column as epoch ms. */
export function msExpr(column: string, stored: 'ms' | 'text'): string {
  return stored === 'ms' ? column : `(CAST(strftime('%s', ${column}) AS INTEGER) * 1000)`;
}

/** How many characters of an id every inspect view prints; a prefix this long finds the row again. */
export const SHORT_ID_CHARS = 8;
export const short = (id: string | null | undefined): string => (id ? String(id).slice(0, SHORT_ID_CHARS) : '-');

export interface AgentRef { id: string; name: string | null; label: string; deleted: boolean }

/** id → name of every agent that still exists. */
export function agentNames(db: Database.Database): Map<string, string> {
  return new Map((db.prepare('SELECT id, name FROM agents').all() as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
}

export function agentLabel(names: Map<string, string>, id: string | null | undefined): string {
  if (!id) return 'engine';
  const name = names.get(id);
  return name ? (name === id ? id : `${name} (${short(id)})`) : `${short(id)} (agent deleted)`;
}

/** An agent named by id or by name; an unknown one is taken as the id of a deleted agent. */
export function resolveAgent(db: Database.Database, input: string): AgentRef {
  const names = agentNames(db);
  if (names.has(input)) return { id: input, name: names.get(input) ?? null, label: agentLabel(names, input), deleted: false };
  const byName = [...names].find(([, n]) => n.toLowerCase() === input.toLowerCase());
  if (byName) return { id: byName[0], name: byName[1], label: agentLabel(names, byName[0]), deleted: false };
  return { id: input, name: null, label: `${input} (agent deleted)`, deleted: true };
}

export interface Window { from: number | null; to: number | null; note: string }

interface TurnSpan { start: number; end: number | null }

/**
 * When a turn ended: its own end; or, for a turn that never closed (a crash, a restart — 85 of
 * them on the dev box), its last record; or the agent's next turn's start; or null, meaning it
 * is still running. A turn left open months ago must not stretch every window to now.
 */
function endOf(db: Database.Database, agentId: string, turn: number, start: number, ended: string | null): number | null {
  const own = toMs(ended);
  if (own !== null) return own;
  const lastMsg = db.prepare('SELECT max(created_at) FROM messages WHERE agent_id = ? AND turn_number = ?').pluck().get(agentId, turn) as number | null;
  const lastCall = db.prepare(`SELECT max(${msExpr('created_at', 'text')}) FROM audit_log WHERE agent_id = ? AND turn_number = ?`).pluck().get(agentId, turn) as number | null;
  const last = Math.max(lastMsg ?? -Infinity, lastCall ?? -Infinity);
  if (Number.isFinite(last)) return Math.max(last, start);
  const next = db.prepare(`SELECT min(${msExpr('started_at', 'text')}) FROM turns WHERE agent_id = ? AND ${msExpr('started_at', 'text')} > ?`).pluck().get(agentId, start) as number | null;
  return next ?? null;
}

/** The span of one turn, or null when no such turn row exists. */
function turnSpan(db: Database.Database, agentId: string, turn: number): TurnSpan | null {
  const r = db.prepare('SELECT started_at, ended_at FROM turns WHERE agent_id = ? AND turn_number = ?').get(agentId, turn) as
    { started_at: string; ended_at: string | null } | undefined;
  const start = r ? toMs(r.started_at) : null;
  return start === null || !r ? null : { start, end: endOf(db, agentId, turn, start, r.ended_at) };
}

/** The turn a moment falls in, for one agent or for any: from the latest start at or before it
 *  to the earliest end at or after it. A never-closed turn ends where `endOf` says. */
function bracket(db: Database.Database, at: number, agentId: string | null): TurnSpan {
  const a = agentId ? 'AND agent_id = ?' : '';
  const args = (x: number): unknown[] => (agentId ? [x, agentId] : [x]);
  const started = db.prepare(`SELECT max(${msExpr('started_at', 'text')}) FROM turns WHERE ${msExpr('started_at', 'text')} <= ? ${a}`).pluck().get(...args(at)) as number | null;
  const ended = db.prepare(`SELECT min(${msExpr('ended_at', 'text')}) FROM turns WHERE ended_at IS NOT NULL AND ${msExpr('ended_at', 'text')} >= ? ${a}`).pluck().get(...args(at)) as number | null;
  const open = db.prepare(`SELECT agent_id, turn_number, ${msExpr('started_at', 'text')} AS s FROM turns WHERE ended_at IS NULL AND ${msExpr('started_at', 'text')} <= ? ${a}`)
    .all(...args(at)) as Array<{ agent_id: string; turn_number: number; s: number }>;
  const ends = open.map((t) => endOf(db, t.agent_id, t.turn_number, t.s, null)).filter((e) => e === null || e >= at);
  const finite = [ended, ...ends].filter((e): e is number => e !== null);
  const end = finite.length ? Math.min(...finite) : (ends.includes(null) ? null : at);
  return { start: started ?? at, end };
}

/** A message by id (or the first characters of one), with its agent, turn and time. */
export function findMessage(db: Database.Database, id: string): { id: string; agent_id: string; turn_number: number | null; created_at: number; seq: number } | null {
  const row = db.prepare(`SELECT id, agent_id, turn_number, created_at, seq FROM messages WHERE id = ? OR (length(?) >= ${SHORT_ID_CHARS} AND id LIKE ? || '%') ORDER BY seq LIMIT 1`)
    .get(id, id, id) as { id: string; agent_id: string; turn_number: number | null; created_at: number; seq: number } | undefined;
  return row ?? null;
}

/** The time window a view covers. `around` wins over since/until; nothing given means open. */
export function resolveWindow(db: Database.Database, a: { since?: string; until?: string; around?: string }, agentId: string | null): Window {
  if (a.around) {
    const msg = findMessage(db, a.around);
    if (msg) {
      const span = msg.turn_number !== null ? turnSpan(db, msg.agent_id, msg.turn_number) : null;
      const s = span ?? bracket(db, msg.created_at, msg.agent_id);
      return { from: Math.min(s.start, msg.created_at), to: s.end === null ? null : Math.max(s.end, msg.created_at), note: `around message ${short(msg.id)}${msg.turn_number !== null ? ` (turn ${msg.turn_number})` : ''}` };
    }
    const at = toMs(a.around);
    if (at === null) return { from: null, to: null, note: `"${a.around}" is neither a message id nor a time, so no window was applied` };
    const s = bracket(db, at, agentId);
    return { from: s.start, to: s.end, note: `around ${utc(at)} (the turn in progress then)` };
  }
  const from = toMs(a.since ?? null);
  const to = toMs(a.until ?? null);
  const note = from === null && to === null ? 'all time' : `${from === null ? 'the beginning' : utc(from)} → ${to === null ? 'now' : utc(to)}`;
  return { from, to, note };
}

/** The window of an agent's (or any agent's) latest turn: the default when no time is given. */
export function latestTurnWindow(db: Database.Database, agentId: string | null): Window | null {
  const r = db.prepare(`SELECT agent_id, turn_number FROM turns ${agentId ? 'WHERE agent_id = ?' : ''} ORDER BY ${msExpr('started_at', 'text')} DESC, turn_number DESC LIMIT 1`)
    .get(...(agentId ? [agentId] : [])) as { agent_id: string; turn_number: number } | undefined;
  const span = r ? turnSpan(db, r.agent_id, r.turn_number) : null;
  return span && r ? { from: span.start, to: span.end, note: `the latest turn (turn ${r.turn_number}); give since/until or around for more` } : null;
}
