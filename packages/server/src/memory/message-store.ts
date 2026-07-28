// PHASE-1 T3 Step 3 — the single writer for `messages`, plus the sanctioned readers.
//
// ONE OWNER PER JOB (DOJO-OVERHAUL-PLAN Part I §3): every row in `messages` is written
// through this module. Lane, channel, sender, trust and the display classification are
// stamped HERE, at ingest, from the caller's own meta — never re-derived downstream and
// never parsed back out of prose (OR4).
//
// The conformance walk (memory/__tests__/single-writer-conformance.test.ts) holds the
// line: it fails on any INSERT/UPDATE/DELETE against `messages` outside this file that is
// not on the burn-down allowlist. T4 empties that allowlist; the allowlist IS the artefact
// that says how much of the conversion is left.
//
// SHAPE NOTE (2026-07-27, T3 resolution R1/R2). Migration 127 is the COMPATIBILITY cutover:
// the table is a superset carrying `origin_kind`/`source`/`conv_key` and TEXT time, with a
// compat trigger classifying rows that legacy writers insert. This module never writes
// those legacy columns — it always passes the real values — so the trigger is a no-op for
// everything written here. By T10 the compat structures are gone and this module is
// unchanged. What must NOT be "tidied" before then: the DEFAULTs on every NOT NULL column.
// They are what stops `INSERT OR IGNORE` (80 of the platform's 87 writers) from discarding
// rows in silence while T4 converts them. Measured, not theorised — see the task report.
//
// CACHE LAW (OR7 / roadmap #10): `content` is written ONCE and never rewritten. No function
// here updates it; markServed and claimForTurn touch routing columns only, so no historical
// prompt byte moves and the provider cache prefix is undisturbed. token_count is estimated
// at WRITE, never at read.

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/connection.js';
import { estimateTokens } from './store.js';

export type Lane = 'owner' | 'a2a' | 'events';
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type DisplayTier = 'user-visible' | 'agent-only' | 'never-shown';

export interface NewMessage {
  agentId: string;
  role: Role;
  content: string;
  /** Defaults to the owner lane: agent traffic must be declared, never assumed. */
  lane?: Lane;
  id?: string;
  conversationId?: string | null;
  /** Sub-classifies the events lane, and marks engine-composed owner-lane acks.
   *  Phase 4 (OR2) owns removing the owner-lane use; Phase 1 keeps it byte-identical. */
  originIntent?: string | null;
  turnNumber?: number | null;
  groupId?: string | null;
  channel?: string | null;
  senderId?: string | null;
  /** The producer's OWN verdict, carried from the meta it already had (OR4). */
  authorized?: boolean;
  sourceAgentId?: string | null;
  a2aThreadId?: string | null;
  a2aIntent?: string | null;
  a2aRequiresResponse?: boolean | null;
  tokenCount?: number;
  modelId?: string | null;
  cost?: number | null;
  latencyMs?: number | null;
  reasoningContent?: string | null;
  inboundMeta?: string | null;
  attachments?: string | null;
  externalMessageId?: string | null;
  speaker?: string | null;
  voiceSessionId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  rootKind?: string | null;
  rootId?: string | null;
  mood?: string | null;
  displayKind?: string;
  displayTier?: DisplayTier;
  /** PHASE2-DELETES — the claim/park machine keeps running unchanged this phase. */
  convKey?: string | null;
}

export interface Persisted {
  seq: number;
  id: string;
  lane: Lane;
  displayKind: string;
  displayTier: DisplayTier;
  tokenCount: number;
  createdAt: string;
  sentAt: number;
}

export interface StoredMessage extends Persisted {
  agentId: string;
  role: Role;
  content: string;
  turnNumber: number | null;
  channel: string | null;
  originIntent: string | null;
  sourceAgentId: string | null;
  servedByTurn: number | null;
}

interface MessageRowShape {
  seq: number; id: string; agent_id: string; role: Role; content: string;
  lane: Lane; display_kind: string; display_tier: DisplayTier; token_count: number;
  created_at: string; sent_at: number; turn_number: number | null; channel: string | null;
  origin_intent: string | null; source_agent_id: string | null; served_by_turn: number | null;
}

const SELECT_COLS = `seq, id, agent_id, role, content, lane, display_kind, display_tier,
  token_count, created_at, sent_at, turn_number, channel, origin_intent, source_agent_id,
  served_by_turn`;

function toStored(r: MessageRowShape): StoredMessage {
  return {
    seq: r.seq, id: r.id, agentId: r.agent_id, role: r.role, content: r.content,
    lane: r.lane, displayKind: r.display_kind, displayTier: r.display_tier,
    tokenCount: r.token_count, createdAt: r.created_at, sentAt: r.sent_at,
    turnNumber: r.turn_number, channel: r.channel, originIntent: r.origin_intent,
    sourceAgentId: r.source_agent_id, servedByTurn: r.served_by_turn,
  };
}

// ── Display classification (write-time, 17 §C1) ──
// Deliberately minimal here. T8 replaces this with the ONE shared taxonomy in
// `packages/shared/src/visibility.ts` (kinds, tiers, mood and marker regexes) and adds the
// enum CHECK to the column. What T3 owes is only this: a row NEVER reaches the table
// unclassified, so the display contract has a floor from the first commit.

function classify(lane: Lane, role: Role): { kind: string; tier: DisplayTier } {
  if (lane === 'events') return { kind: 'engine-note', tier: 'agent-only' };
  if (lane === 'a2a') return { kind: 'a2a', tier: 'agent-only' };
  if (role === 'tool') return { kind: 'tool-turn', tier: 'agent-only' };
  if (role === 'system') return { kind: 'engine-note', tier: 'agent-only' };
  return { kind: role === 'user' ? 'user-text' : 'agent-text', tier: 'user-visible' };
}

/** The ONE INSERT into `messages`. Every column the row needs is decided here. */
export function insertMessage(m: NewMessage): Persisted {
  const db = getDb();
  const lane: Lane = m.lane ?? 'owner';
  const id = m.id ?? randomUUID();
  const display = classify(lane, m.role);
  const displayKind = m.displayKind ?? display.kind;
  const displayTier = m.displayTier ?? display.tier;
  // Estimated at WRITE. Never zero: a row that costs nothing to carry does not exist, and a
  // zero here would make every budget arithmetic downstream quietly wrong.
  const tokenCount = m.tokenCount ?? Math.max(1, estimateTokens(m.content));
  const sentAt = Date.now();

  const info = db.prepare(`
    INSERT INTO messages (
      id, agent_id, conversation_id, lane, origin_intent, role, content, mood,
      display_kind, display_tier, turn_number, group_id, channel, sender_id, authorized,
      source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, token_count,
      model_id, cost, latency_ms, reasoning_content, inbound_meta, attachments,
      external_message_id, speaker, voice_session_id, task_id, run_id, root_kind, root_id,
      conv_key, provenance, sent_at, created_at
    ) VALUES (
      @id, @agentId, @conversationId, @lane, @originIntent, @role, @content, @mood,
      @displayKind, @displayTier, @turnNumber, @groupId, @channel, @senderId, @authorized,
      @sourceAgentId, @a2aThreadId, @a2aIntent, @a2aRequiresResponse, @tokenCount,
      @modelId, @cost, @latencyMs, @reasoningContent, @inboundMeta, @attachments,
      @externalMessageId, @speaker, @voiceSessionId, @taskId, @runId, @rootKind, @rootId,
      @convKey, 'live', @sentAt, datetime('now')
    )
  `).run({
    id, agentId: m.agentId, conversationId: m.conversationId ?? null, lane,
    originIntent: m.originIntent ?? null, role: m.role, content: m.content,
    mood: m.mood ?? null, displayKind, displayTier,
    turnNumber: m.turnNumber ?? null, groupId: m.groupId ?? null,
    channel: m.channel ?? null, senderId: m.senderId ?? null,
    authorized: (m.authorized ?? true) ? 1 : 0,
    sourceAgentId: m.sourceAgentId ?? null, a2aThreadId: m.a2aThreadId ?? null,
    a2aIntent: m.a2aIntent ?? null,
    a2aRequiresResponse: m.a2aRequiresResponse == null ? null : (m.a2aRequiresResponse ? 1 : 0),
    tokenCount, modelId: m.modelId ?? null, cost: m.cost ?? null,
    latencyMs: m.latencyMs ?? null, reasoningContent: m.reasoningContent ?? null,
    inboundMeta: m.inboundMeta ?? null, attachments: m.attachments ?? null,
    externalMessageId: m.externalMessageId ?? null, speaker: m.speaker ?? null,
    voiceSessionId: m.voiceSessionId ?? null, taskId: m.taskId ?? null, runId: m.runId ?? null,
    rootKind: m.rootKind ?? null, rootId: m.rootId ?? null, convKey: m.convKey ?? null,
    sentAt,
  });

  const createdAt = (db.prepare('SELECT created_at FROM messages WHERE seq = ?')
    .get(info.lastInsertRowid as number) as { created_at: string }).created_at;

  return {
    seq: info.lastInsertRowid as number, id, lane,
    displayKind, displayTier, tokenCount, createdAt, sentAt,
  };
}

/** Platform coordination: never the agent speaking, never visible to a human. */
export function insertEngineEvent(
  e: Omit<NewMessage, 'lane' | 'role'> & { role?: Role },
): Persisted {
  return insertMessage({ ...e, lane: 'events', role: e.role ?? 'user' });
}

// ── Turn boundary ──

/** Hand every unclaimed row for this agent to `turnNumber`, oldest first, and report what
 *  was claimed. Routing columns only — `content` is untouched (cache law). */
export function claimForTurn(agentId: string, turnNumber: number): StoredMessage[] {
  const db = getDb();
  const claim = db.transaction((aid: string, turn: number): StoredMessage[] => {
    const rows = db.prepare(`
      SELECT ${SELECT_COLS} FROM messages
      WHERE agent_id = ? AND served_by_turn IS NULL AND swept_at IS NULL
      ORDER BY seq ASC
    `).all(aid) as MessageRowShape[];
    if (rows.length === 0) return [];
    db.prepare(`
      UPDATE messages SET served_by_turn = ?, turn_number = COALESCE(turn_number, ?)
      WHERE agent_id = ? AND served_by_turn IS NULL AND swept_at IS NULL
    `).run(turn, turn, aid);
    return rows.map(r => toStored({ ...r, served_by_turn: turn, turn_number: r.turn_number ?? turn }));
  });
  return claim(agentId, turnNumber);
}

/** Mark specific rows as served by a turn. Never rewrites `content`. */
export function markServed(ids: string[], turnNumber: number): void {
  if (ids.length === 0) return;
  const db = getDb();
  const stmt = db.prepare('UPDATE messages SET served_by_turn = ? WHERE id = ?');
  db.transaction((list: string[]) => { for (const id of list) stmt.run(turnNumber, id); })(ids);
}

// ── Sanctioned readers ──
// These are the read surface this module vouches for. `chat_messages` remains the ONLY
// human-facing accessor; anything rendered to a person reads the view, not these.

export function recentTail(
  agentId: string,
  opts: { limit: number; lanes?: Lane[] } = { limit: 50 },
): StoredMessage[] {
  const db = getDb();
  const lanes = opts.lanes;
  const laneClause = lanes?.length ? `AND lane IN (${lanes.map(() => '?').join(',')})` : '';
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT ${SELECT_COLS} FROM messages
      WHERE agent_id = ? ${laneClause}
      ORDER BY seq DESC LIMIT ?
    ) ORDER BY seq ASC
  `).all(agentId, ...(lanes ?? []), opts.limit) as MessageRowShape[];
  return rows.map(toStored);
}

export function byIds(ids: string[]): StoredMessage[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${SELECT_COLS} FROM messages
    WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY seq ASC
  `).all(...ids) as MessageRowShape[];
  return rows.map(toStored);
}

/** Everything waiting for a turn to pick it up, oldest first. */
export function unservedHead(agentId: string): StoredMessage[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT ${SELECT_COLS} FROM messages
    WHERE agent_id = ? AND served_by_turn IS NULL AND swept_at IS NULL
    ORDER BY seq ASC
  `).all(agentId) as MessageRowShape[];
  return rows.map(toStored);
}
