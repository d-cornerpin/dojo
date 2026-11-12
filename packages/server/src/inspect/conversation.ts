// Any agent's messages, whole, each tagged ROLE · PARTY (as the summaries tag them) plus channel, id and turn.
// The window is scope.ts's; with no window and no pattern it is the agent's latest turn. The result ends
// with the ids of the messages just before and after, so paging is one call each way.

import type Database from 'better-sqlite3';
import { getReadOnlyDb } from '../db/connection.js';
import { rowToMessage, type MessageRow } from '../memory/store.js';
import { summaryPartyTag } from '../memory/party-label.js';
import { redactRows } from './redact.js';
import { agentLabel, agentNames, latestTurnWindow, resolveAgent, resolveWindow, short, utc, type Window } from './scope.js';
import { messageText, toolNamesIn } from './message-text.js';

export interface ConversationArgs { agent: string; since?: string; until?: string; around?: string; pattern?: string; include_engine?: boolean }

type Row = MessageRow & Record<string, unknown> & { created_at: number };

const ENGINE_ROWS = "role NOT IN ('system', 'tool') AND lane <> 'events'";

function tag(r: Row, names: Map<string, string>): string {
  // A peer's row names the peer; everything else is tagged exactly as the summaries tag it.
  const party = r.source_agent_id ? `${agentLabel(names, r.source_agent_id)} (agent)` : summaryPartyTag(rowToMessage(r));
  const parts = [r.role.toUpperCase(), party, r.channel, `msg ${short(r.id)}`, r.turn_number !== null ? `turn ${r.turn_number}` : null,
    r.a2a_thread_id ? `thread ${short(r.a2a_thread_id)}${r.a2a_intent ? ` ${r.a2a_intent}` : ''}` : null];
  return parts.filter((p): p is string => !!p).join(' · ');
}

function neighbour(db: Database.Database, agentId: string, seq: number, dir: 'before' | 'after', engine: boolean): string | null {
  const r = db.prepare(`SELECT id FROM messages WHERE agent_id = ? AND seq ${dir === 'before' ? '<' : '>'} ? ${engine ? '' : `AND ${ENGINE_ROWS}`}
    ORDER BY seq ${dir === 'before' ? 'DESC' : 'ASC'} LIMIT 1`).pluck().get(agentId, seq) as string | undefined;
  return r ?? null;
}

/** Any agent's messages in the window, tagged, whole, oldest first. */
export function conversation(a: ConversationArgs, db: Database.Database = getReadOnlyDb()): string {
  if (!a.agent) return 'Name the agent whose conversation to read (agent: its id or name).';
  const agent = resolveAgent(db, a.agent);
  const engine = a.include_engine !== false;
  let w: Window = resolveWindow(db, a, agent.id);
  if (w.from === null && w.to === null && !a.around && !a.pattern) w = latestTurnWindow(db, agent.id) ?? w;
  const where = ['agent_id = ?']; const args: unknown[] = [agent.id];
  if (w.from !== null) { where.push('created_at >= ?'); args.push(w.from); }
  if (w.to !== null) { where.push('created_at <= ?'); args.push(w.to); }
  if (a.pattern) { where.push('instr(lower(content), lower(?)) > 0'); args.push(a.pattern); }
  if (!engine) where.push(ENGINE_ROWS);
  // The SQL match only narrows; the pattern must also hold on the REDACTED text, or a search
  // could probe a secret a character at a time by which rows come back.
  const needle = a.pattern?.toLowerCase();
  const rows = redactRows(db.prepare(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY seq`).all(...args) as Row[], [agent.id])
    .filter((r) => !needle || r.content.toLowerCase().includes(needle));
  const head = `Conversation of ${agent.label}, ${w.note}${a.pattern ? `, matching "${a.pattern}"` : ''}${engine ? '' : ', engine notices and tool rows left out'}: `
    + `${rows.length} message${rows.length === 1 ? '' : 's'}.`;
  if (rows.length === 0) return `${head}\nNo messages for ${agent.label} in that window.`;
  const tools = toolNamesIn(rows.map((r) => r.content));
  const names = agentNames(db);
  const body = rows.map((r) => `[${utc(r.created_at)}] (${tag(r, names)}) ${messageText(r.content, tools)}`).join('\n\n');
  const call = (id: string): string => `around "${short(id)}"`;
  const prev = neighbour(db, agent.id, rows[0].seq, 'before', engine);
  const next = neighbour(db, agent.id, rows[rows.length - 1].seq, 'after', engine);
  const anchors = [prev ? `Earlier: ${call(prev)}` : 'Earlier: nothing, this is the start', next ? `Later: ${call(next)}` : 'Later: nothing yet'].join(' · ');
  return `${head}\n\n${body}\n\n${anchors}.`;
}
