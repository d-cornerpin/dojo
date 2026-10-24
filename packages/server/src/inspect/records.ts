// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect B1 — EVERY RECORD THE PLATFORM KEEPS, AS ONE KIND OF LINE.
//
// Six tables say what happened: `work_events` (the tracker's story), `audit_log` (every tool
// call), `tool_receipts` (what a provider confirmed), `deliveries` (what reached a person),
// `turns` (each turn's start, end and exit) and `messages`. Each source is read on the
// read-only connection, filtered by one shared scope, passed through `redactRows`, and rendered
// to one line naming its table and a short id, so `sql` can follow any line up.
//
// A row matches the scope when it matches ANY identity clause given (an agent, an agent's
// turns, a work id, a conversation) and falls in the time window. No identity clause means
// every row in the window.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { redactRows } from './redact.js';
import { agentLabel, msExpr, short, utc, toMs } from './scope.js';
import { messageText, toolNamesIn } from './message-text.js';

export type Source = 'events' | 'tools' | 'receipts' | 'deliveries' | 'turns' | 'messages';
export const SOURCES: readonly Source[] = ['events', 'tools', 'receipts', 'deliveries', 'turns', 'messages'];

export interface RecordScope {
  agents?: string[];
  turnsOf?: Array<{ agent: string; turns: number[] }>;
  /** Work ids, matched on the indexed link columns (work_id, root_id, task_id). */
  ids?: string[];
  /** One id searched for in free text (message content, a call's target and detail). ONE id, so
   *  text is scanned once per view: a project names itself, its tasks are found by their links. */
  named?: string;
  conversation?: string;
  from: number | null;
  to: number | null;
}

export interface Rec { at: number; source: Source | 'logs'; text: string }

/** The plan's figure for one timeline line's own text: a line is an index, the row is one `sql` away. */
export const LINE_TEXT_CHARS = 200;
const clip = (s: unknown): string => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > LINE_TEXT_CHARS ? `${t.slice(0, LINE_TEXT_CHARS)}…` : t;
};

type Row = Record<string, unknown>;
type Clause = [string, unknown[]] | null;
const marks = (xs: readonly unknown[]): string => xs.map(() => '?').join(', ');
const workOf = (who: string): string => `work_id IN (SELECT id FROM work WHERE ${who})`;
const turnJson = "(CASE WHEN json_valid(payload) THEN json_extract(payload, '$.turn_number') END)";

interface Def {
  table: string; at: string;
  agent(a: string[]): Clause; turn(agent: string, turns: number[]): Clause; ids(ids: string[]): Clause; named(id: string): Clause; conv(c: string): Clause;
  render(r: Row, names: Map<string, string>, tools: Map<string, string>): string;
}

/** The clauses of a table with the usual agent_id / turn_number columns. */
const plain = (a: string[]): Clause => [`agent_id IN (${marks(a)})`, a];
const plainTurn = (agent: string, turns: number[]): Clause => [`(agent_id = ? AND turn_number IN (${marks(turns)}))`, [agent, ...turns]];
const join = (...cs: Clause[]): Clause => {
  const live = cs.filter((c): c is [string, unknown[]] => c !== null);
  return live.length ? [`(${live.map((c) => c[0]).join(' OR ')})`, live.flatMap((c) => c[1])] : null;
};

const turnTag = (r: Row): string => (r.turn_number !== null && r.turn_number !== undefined ? ` · turn ${r.turn_number}` : '');
const rootTag = (r: Row): string => (r.root_id ? ` · ${r.root_kind ?? 'root'} ${short(String(r.root_id))}` : '');
const who = (r: Row, names: Map<string, string>): string => `agent ${agentLabel(names, r.agent_id as string)}`;

function eventSummary(kind: string, payload: unknown): string {
  let p: Record<string, unknown> = {};
  try { p = typeof payload === 'string' ? JSON.parse(payload) as Record<string, unknown> : {}; } catch { return clip(payload); }
  if (kind === 'transition') return `${String(p.from)} → ${String(p.to)}${p.reason ? `: ${clip(p.reason)}` : ''}`;
  if (kind === 'claim_turn') return `claimed in turn ${String(p.turn_number)}`;
  return clip(p.reason ?? p.text ?? p.note ?? (Object.keys(p).length ? JSON.stringify(p) : ''));
}

const DEFS: Record<Source, Def> = {
  events: {
    table: 'work_events', at: msExpr('created_at', 'ms'),
    agent: (a) => [`(actor IN (${marks(a)}) OR ${workOf(`agent_id IN (${marks(a)}) OR assignee_agent IN (${marks(a)})`)})`, [...a, ...a, ...a]],
    turn: (agent, turns) => [`(${turnJson} IN (${marks(turns)}) AND ${workOf('agent_id = ? OR assignee_agent = ?')})`, [...turns, agent, agent]],
    ids: (ids) => [`work_id IN (${marks(ids)})`, ids], named: () => null, conv: (c) => [workOf('conversation_id = ?'), [c]],
    render: (r, names) => `task ${short(r.work_id as string)} · ${r.kind} by ${names.has(r.actor as string) ? agentLabel(names, r.actor as string) : r.actor} · work_events #${r.id}  ${eventSummary(r.kind as string, r.payload)}`,
  },
  tools: {
    table: 'audit_log', at: msExpr('created_at', 'text'),
    agent: plain, turn: plainTurn,
    ids: (ids) => [`root_id IN (${marks(ids)})`, ids], named: (id) => ['(instr(target, ?) > 0 OR instr(detail, ?) > 0)', [id, id]], conv: () => null,
    render: (r, names) => `${who(r, names)} · ${r.action_type === 'tool_call' ? 'tool' : r.action_type} ${r.target ?? ''} (${r.result}) · audit_log ${short(String(r.id))}${turnTag(r)}${rootTag(r)}  ${clip(r.detail)}`,
  },
  receipts: {
    table: 'tool_receipts', at: msExpr('created_at', 'text'),
    agent: plain, turn: plainTurn,
    ids: (ids) => [`(root_id IN (${marks(ids)}) OR task_id IN (${marks(ids)}))`, [...ids, ...ids]], named: () => null, conv: () => null,
    render: (r, names) => `${who(r, names)} · receipt ${r.tool} (${r.verified ? 'verified' : 'unverified'}, ${r.basis}) · tool_receipts ${short(String(r.id))}${r.provider_id ? ` · provider id ${r.provider_id}` : ''}${turnTag(r)}  ${clip(r.detail)}`,
  },
  deliveries: {
    table: 'deliveries', at: msExpr('created_at', 'text'),
    agent: plain, turn: plainTurn,
    ids: (ids) => [`root_id IN (${marks(ids)})`, ids], named: () => null, conv: (c) => ['conversation_id = ?', [c]],
    render: (r, names) => `${who(r, names)} · delivery ${r.tool} → ${r.channel}${r.recipient_display ? ` ${r.recipient_display}` : ''} (${r.outcome}) · deliveries ${short(String(r.id))}${turnTag(r)}${rootTag(r)}  ${clip(r.detail)}`,
  },
  turns: {
    table: 'turns', at: msExpr('started_at', 'text'),
    agent: plain, turn: plainTurn,
    ids: (ids) => [`root_id IN (${marks(ids)})`, ids], named: () => null, conv: (c) => ['source_message_id IN (SELECT id FROM messages WHERE conversation_id = ?)', [c]],
    render: (r, names) => {
      const end = toMs(r.ended_at as string | null);
      return `${who(r, names)} · turn ${r.turn_number}${r.kind ? ` ${r.kind}` : ''} started · turns${rootTag(r)}  ${end === null ? 'still running' : `ended ${utc(end)} (${r.exit_reason}, ${r.effectful_calls} effectful call${r.effectful_calls === 1 ? '' : 's'})`}`;
    },
  },
  messages: {
    table: 'messages', at: msExpr('created_at', 'ms'),
    agent: plain, turn: plainTurn,
    ids: (ids) => [`(root_id IN (${marks(ids)}) OR task_id IN (${marks(ids)}))`, [...ids, ...ids]], named: (id) => ['instr(content, ?) > 0', [id]], conv: (c) => ['conversation_id = ?', [c]],
    render: (r, names, tools) => `${who(r, names)} · msg ${short(r.id as string)} ${r.role}${r.channel ? ` · ${r.channel}` : ''}${turnTag(r)}${r.a2a_thread_id ? ` · thread ${short(r.a2a_thread_id as string)} ${r.a2a_intent ?? ''}` : ''}  ${clip(messageText(String(r.content), tools))}`,
  },
};

function whereOf(def: Def, s: RecordScope): { sql: string; args: unknown[] } {
  const identity: Clause[] = [];
  if (s.agents?.length) identity.push(def.agent(s.agents));
  for (const t of s.turnsOf ?? []) if (t.turns.length) identity.push(def.turn(t.agent, t.turns));
  if (s.ids?.length) identity.push(def.ids(s.ids));
  if (s.named) identity.push(def.named(s.named));
  if (s.conversation) identity.push(def.conv(s.conversation));
  const parts: string[] = []; const args: unknown[] = [];
  if (identity.length) {
    // An identity this table cannot express matches none of its rows, never all of them.
    const any = join(...identity);
    if (any) { parts.push(any[0]); args.push(...any[1]); } else parts.push('0');
  }
  if (s.from !== null) { parts.push(`${def.at} >= ?`); args.push(s.from); }
  if (s.to !== null) { parts.push(`${def.at} <= ?`); args.push(s.to); }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', args };
}

/** Every record of the given sources in scope, rendered, redacted, unsorted. */
export function readRecords(db: Database.Database, scope: RecordScope, sources: readonly Source[], names: Map<string, string>, agentIds: readonly string[]): Rec[] {
  const out: Rec[] = [];
  for (const source of sources) {
    const def = DEFS[source];
    const w = whereOf(def, scope);
    const rows = redactRows(db.prepare(`SELECT *, ${def.at} AS at_ms FROM ${def.table} ${w.sql}`).all(...w.args) as Row[], agentIds);
    const tools = source === 'messages' ? toolNamesIn(rows.map((r) => String(r.content))) : new Map<string, string>();
    for (const r of rows) out.push({ at: Number(r.at_ms), source, text: def.render(r, names, tools) });
  }
  return out;
}
