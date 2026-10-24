// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect B3 — THE PLATFORM LOG, ACROSS ITS ROTATION.
//
// The log is JSON lines `{timestamp, level, component, message, agentId?, meta?}`, rotated at
// ~10 MB into exactly one backup (`log-rotation.ts`). `logger.readLogFiles()` hands both files
// over, oldest first; this parses them, puts every line in time order (a question about one
// minute can straddle the rotation), filters, scrubs and prints one line per entry:
//   [2026-10-19 09:03:00 UTC] warn gmail · label refused · {"status":403}
//
// FILTERS. level keeps that level and above; component is exact; agent matches the entry's
// agent id or the agent's id or name in its text; pattern is matched on the SCRUBBED line, so a
// search cannot probe a secret by which lines come back; tail keeps the last N that match.
// The window is the shared one (`scope.ts`); with no window and no filter it is the latest turn.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { getReadOnlyDb } from '../db/connection.js';
import { readLogFiles } from '../logger.js';
import { redactText } from './redact.js';
import { latestTurnWindow, msExpr, resolveAgent, resolveWindow, toMs, utc } from './scope.js';
import type { Rec, RecordScope } from './records.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };

interface Entry { at: number; level: string; component: string; agentId: string | null; line: string }

/** Every readable line of the log, oldest first, parsed but NOT yet scrubbed: the filters on
 *  time, level and component run on the parsed fields first, and only the lines that survive
 *  are scrubbed (`scrubbed`), so a view pays for what it returns, not for the whole log. */
function logEntries(): { entries: Entry[]; unreadable: number } {
  const entries: Entry[] = []; let unreadable = 0;
  for (const file of readLogFiles()) {
    for (const raw of file.split('\n')) {
      if (!raw.trim()) continue;
      let e: { timestamp?: unknown; level?: unknown; component?: unknown; message?: unknown; agentId?: unknown; meta?: unknown };
      try { e = JSON.parse(raw) as typeof e; } catch { unreadable++; continue; }
      const at = toMs(typeof e.timestamp === 'string' ? e.timestamp : null);
      if (at === null) { unreadable++; continue; }
      const agentId = typeof e.agentId === 'string' ? e.agentId
        : (e.meta && typeof (e.meta as { agentId?: unknown }).agentId === 'string' ? (e.meta as { agentId: string }).agentId : null);
      const meta = e.meta && typeof e.meta === 'object' && Object.keys(e.meta).length ? ` · ${JSON.stringify(e.meta)}` : '';
      entries.push({ at, level: String(e.level), component: String(e.component), agentId, line: `${String(e.level)} ${String(e.component)} · ${String(e.message ?? '')}${meta}` });
    }
  }
  // Stable: lines of the same millisecond keep their file order.
  entries.sort((a, b) => a.at - b.at);
  return { entries, unreadable };
}

/** One surviving line, scrubbed against the scope's agents and its own. */
const scrubbed = (e: Entry, agents: readonly string[]): Entry & { text: string } =>
  ({ ...e, text: redactText(e.line, e.agentId ? [...agents, e.agentId] : agents) });

const inWindow = (e: Entry, from: number | null, to: number | null): boolean => (from === null || e.at >= from) && (to === null || e.at <= to);

export interface LogsArgs { since?: string; until?: string; around?: string; level?: Level; component?: string; agent?: string; pattern?: string; tail?: number }

/** The platform log, filtered. */
export function logs(a: LogsArgs, db: Database.Database = getReadOnlyDb()): string {
  const agent = a.agent ? resolveAgent(db, a.agent) : null;
  let w = resolveWindow(db, a, agent?.id ?? null);
  const filtered = !!(a.level || a.component || a.agent || a.pattern || a.tail);
  if (w.from === null && w.to === null && !a.around && !filtered) w = latestTurnWindow(db, null) ?? w;
  const { entries, unreadable } = logEntries();
  const min = a.level ? RANK[a.level] ?? 0 : -1;
  const name = agent?.name?.toLowerCase() ?? null;
  const needle = a.pattern?.toLowerCase();
  // The parsed fields first; then scrub the survivors; then the text filters, on scrubbed text.
  let hits = entries.filter((e) => inWindow(e, w.from, w.to)
    && (min < 0 || (RANK[e.level] ?? 0) >= min)
    && (!a.component || e.component.toLowerCase() === a.component.toLowerCase()))
    .map((e) => scrubbed(e, agent ? [agent.id] : []))
    .filter((e) => (!agent || e.agentId === agent.id || e.text.includes(agent.id) || (name !== null && e.text.toLowerCase().includes(name)))
    && (!needle || e.text.toLowerCase().includes(needle)));
  if (a.tail && a.tail > 0) hits = hits.slice(-a.tail);
  const filters = [a.level && `${a.level} and above`, a.component && `component ${a.component}`, agent && `agent ${agent.label}`,
    a.pattern && `matching "${a.pattern}"`, a.tail && `the last ${a.tail}`].filter(Boolean).join(', ');
  const head = `Platform log (dojo.log and its rotated backup), ${w.note}${filters ? `, ${filters}` : ''}: ${hits.length} line${hits.length === 1 ? '' : 's'}`
    + `${unreadable ? ` (${unreadable} unreadable line${unreadable === 1 ? '' : 's'} skipped)` : ''}.`;
  if (hits.length === 0) return `${head}\nNothing in the log matches.`;
  return `${head}\n\n${hits.map((e) => `[${utc(e.at)}] ${e.text}`).join('\n')}`;
}

/** The warn and error lines of a timeline's scope, as timeline records. */
export function logRecords(db: Database.Database, scope: RecordScope, agentIds: readonly string[]): Rec[] {
  const spans: Array<{ agent: string; from: number; to: number }> = [];
  for (const t of scope.turnsOf ?? []) {
    for (const n of t.turns) {
      const r = db.prepare(`SELECT ${msExpr('started_at', 'text')} AS s, ${msExpr('ended_at', 'text')} AS e FROM turns WHERE agent_id = ? AND turn_number = ?`).get(t.agent, n) as { s: number; e: number | null } | undefined;
      if (r) spans.push({ agent: t.agent, from: r.s, to: r.e ?? Date.now() });
    }
  }
  const ids = [...(scope.ids ?? []), ...(scope.conversation ? [scope.conversation] : [])];
  const agents = new Set(scope.agents ?? []);
  const identity = agents.size > 0 || spans.length > 0 || ids.length > 0;
  return logEntries().entries
    .filter((e) => (RANK[e.level] ?? 0) >= RANK.warn && inWindow(e, scope.from, scope.to))
    .map((e) => scrubbed(e, agentIds))
    .filter((e) => !identity
      || (e.agentId !== null && agents.has(e.agentId))
      || spans.some((s) => e.agentId === s.agent && e.at >= s.from && e.at <= s.to)
      || ids.some((id) => e.text.includes(id)))
    .map((e) => ({ at: e.at, source: 'logs' as const, text: `log ${e.text}` }));
}
