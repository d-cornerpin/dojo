// Which ONE conversation a row, and so a condensed note, belongs to: a note is written about one conversation and
// labelled with it, never hidden. The KEY is a pure function of the row's STORED columns: `conv:<conversation id>`
// (a person's conversation), `a2a:<thread id>`, `engine`, `background` (a wake that served no conversation) or
// `unknown`. A `system` row has no subject of its own and travels with the row before it. `several` is never a
// row's key: it names a note merged across conversations as a last resort. The LABEL is rendered from the key with
// `LabelFacts`, the same words the tail's block headers use; stored columns only, never the turn or the clock.
import type { Message } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { LabelFacts, labelText } from './row-label.js';
import { renderInstant } from './message-stamp.js';
import { subjectKindsBySeq, type SubjectKind } from './message-store.js';

/** A condensed note merged across conversations (the last resort only). */
export const SEVERAL_SUBJECTS = 'several';

type KeyedRow = Pick<Message, 'role' | 'conversationId' | 'a2aThreadId' | 'sourceAgentId' | 'origin'> & { subjectKind?: SubjectKind | null };

/** One row's conversation key, or null for a `system` row (it has none of its own). */
export function rowSubjectKey(m: KeyedRow): string | null {
  if (m.role === 'system') return null;
  if (m.role === 'user') {
    if (m.origin?.kind === 'agent' || m.sourceAgentId) return `a2a:${m.a2aThreadId ?? ''}`;
    if (m.origin?.kind === 'engine') return 'engine';
    return m.conversationId ? `conv:${m.conversationId}` : 'unknown';
  }
  switch (m.subjectKind) {
    case 'conv': case 'legacy': case 'delivered': return m.conversationId ? `conv:${m.conversationId}` : 'unknown';
    case 'a2a_thread': return `a2a:${m.a2aThreadId ?? ''}`;
    case 'engine_event': return 'engine';
    case 'background': return 'background';
    case 'unknown': return 'unknown';
    default: return m.conversationId ? `conv:${m.conversationId}` : m.a2aThreadId ? `a2a:${m.a2aThreadId}` : 'unknown';
  }
}

/** Every row's key, oldest first; a `system` row takes its predecessor's (else its successor's). */
export function rowSubjectKeys(agentId: string, rows: readonly Message[]): string[] {
  const kinds = subjectKindsBySeq(agentId, rows.map((m) => m.rowid).filter((s): s is number => typeof s === 'number'));
  const own = rows.map((m) => rowSubjectKey({ ...m, subjectKind: m.rowid != null ? kinds.get(m.rowid) ?? null : null }));
  const out: string[] = [];
  let last: string | null = null;
  for (let i = 0; i < own.length; i++) {
    last = own[i] ?? last ?? own.slice(i + 1).find((k) => k !== null) ?? 'unknown';
    out.push(last);
  }
  return out;
}

/** The rows grouped by conversation, each group oldest first, groups in order of first appearance. */
export function groupBySubject(agentId: string, rows: readonly Message[]): Array<{ key: string; rows: Message[] }> {
  const keys = rowSubjectKeys(agentId, rows);
  const groups = new Map<string, Message[]>();
  rows.forEach((m, i) => { const g = groups.get(keys[i]); if (g) g.push(m); else groups.set(keys[i], [m]); });
  return [...groups.entries()].map(([key, g]) => ({ key, rows: g }));
}

/** The one key a set of message ids shares, `several` when they span more than one, `unknown` when none. */
export function subjectKeyOfIds(messageIds: readonly string[]): string {
  if (messageIds.length === 0) return 'unknown';
  const rows = getDb().prepare(
    `SELECT seq, role, lane, conversation_id, a2a_thread_id, source_agent_id, subject_kind FROM messages
      WHERE id IN (${messageIds.map(() => '?').join(',')}) ORDER BY seq`,
  ).all(...messageIds) as Array<{ seq: number; role: Message['role']; lane: string; conversation_id: string | null;
    a2a_thread_id: string | null; source_agent_id: string | null; subject_kind: SubjectKind | null }>;
  const keys = new Set(rows.map((r) => rowSubjectKey({
    role: r.role, conversationId: r.conversation_id, a2aThreadId: r.a2a_thread_id, sourceAgentId: r.source_agent_id,
    subjectKind: r.subject_kind,
    origin: r.lane === 'a2a' ? { kind: 'agent' } as Message['origin'] : r.lane === 'events' ? { kind: 'engine' } as Message['origin'] : undefined,
  })).filter((k): k is string => k !== null));
  return keys.size === 0 ? 'unknown' : keys.size === 1 ? [...keys][0] : SEVERAL_SUBJECTS;
}

/** The lineage columns (mig 115) of a single-conversation note, read off its key. */
export function lineageOf(key: string | null): { conversationId: string | null; a2aThreadId: string | null } {
  return { conversationId: key?.startsWith('conv:') ? key.slice(5) : null, a2aThreadId: key?.startsWith('a2a:') ? key.slice(4) || null : null };
}

const day = (at: string): string => (renderInstant(at) ?? at).split(',').slice(0, 2).join(',');

export function summaryConversationLabel(
  s: { subjectKey?: string | null; rebuildState?: string | null; earliestAt: string; latestAt: string }, facts: LabelFacts,
): string {
  const range = `${day(s.earliestAt)} to ${day(s.latestAt)}`;
  if (s.rebuildState === 'legacy_mixed' || s.rebuildState === 'legacy_mixed_rebuild') return `older mixed notes, ${range}`;
  const key = s.subjectKey ?? null;
  let label: string | null = null;
  if (key?.startsWith('conv:')) label = facts.conversation(key.slice(5));
  else if (key?.startsWith('a2a:')) label = facts.thread(key.slice(4) || null);
  else if (key === 'engine') label = 'engine events (scheduled tasks, reminders, system notices)';
  else if (key === 'background') label = 'background work, not part of any conversation';
  else if (key === SEVERAL_SUBJECTS) label = 'several conversations, each named inside';
  return labelText(label ?? `conversation unknown, ${range}`, 200);
}

/** Each row's conversation label for a summariser input, and whether the rows are all one conversation. */
export function conversationLabels(rows: readonly Message[]): { one: boolean; labelOf: Map<string, string> } {
  const agentId = rows[0]?.agentId;
  const groups = agentId ? groupBySubject(agentId, rows) : [];
  const facts = new LabelFacts(agentId ?? '');
  const labelOf = new Map<string, string>();
  for (const g of groups) {
    const label = summaryConversationLabel({ subjectKey: g.key, earliestAt: g.rows[0].createdAt, latestAt: g.rows[g.rows.length - 1].createdAt }, facts);
    for (const m of g.rows) labelOf.set(m.id, label);
  }
  return { one: groups.length === 1, labelOf };
}

const QUEUED_STATE = 'legacy_mixed_rebuild';

/** Condensation batches: a conversation's notes merge with its own first; older mixed notes merge only with notes in
 *  the SAME state (a note queued for rebuild never joins them, or its rebuild would never reach it). Only when no
 *  conversation has two notes left do batches cross conversations, never taking a queued note, so the climb ends. */
export function subjectBatches<T extends { subjectKey?: string | null; rebuildState?: string | null }>(rows: readonly T[], size: number): T[][] {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const g = r.rebuildState ? `state:${r.rebuildState}` : r.subjectKey ?? 'unknown';
    groups.set(g, [...(groups.get(g) ?? []), r]);
  }
  const within = [...groups.values()].flatMap((g) => chunksOf(g, size)).filter((b) => b.length > 1);
  if (within.length > 0) return within;
  const free = rows.filter((r) => r.rebuildState !== QUEUED_STATE);
  return chunksOf(free, size);
}

function chunksOf<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export { LabelFacts };
