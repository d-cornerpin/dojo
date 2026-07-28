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

// ── The legacy-column projection (T4) ──
// T6-DELETES / T10-DELETES. `origin_kind` and `source` are the two compat columns migration
// 127 carries. T4 converted every CALL SITE off them — no writer outside this module names
// either column any more — but ~120 `origin_kind` refs and 39 `source` refs are still READ
// across the tree, and T5/T6 own re-pointing those. R1 says the box stays alive and
// OR8-verifiable after EVERY task, so the single writer keeps the two columns TRUE by
// deriving them from `lane`, which is the exact inverse of the compat trigger T4 dropped.
// The derivation lives in ONE function with one demolition marker instead of firing as an
// invisible AFTER INSERT trigger on every row. When T6 has re-pointed the predicates and
// T10 drops the columns, this function and its two call sites go with them.
function legacyOriginKind(lane: Lane): string | null {
  return lane === 'events' ? 'engine' : null;   // T10-DELETES (T3-0b §1: origin_kind ⟺ lane)
}
function legacySource(lane: Lane, channel: string | null): string | null {
  if (lane === 'a2a') return 'a2a';             // T10-DELETES (T3-0b §3: source splits onto
  if (channel === 'voice') return 'voice';      //              lane + channel)
  return null;
}

const INSERT_SQL = `
    INSERT INTO messages (
      id, agent_id, conversation_id, lane, origin_intent, role, content, mood,
      display_kind, display_tier, turn_number, group_id, channel, sender_id, authorized,
      source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, token_count,
      model_id, cost, latency_ms, reasoning_content, inbound_meta, attachments,
      external_message_id, speaker, voice_session_id, task_id, run_id, root_kind, root_id,
      conv_key, origin_kind, source, provenance, sent_at, created_at
    ) VALUES (
      @id, @agentId, @conversationId, @lane, @originIntent, @role, @content, @mood,
      @displayKind, @displayTier, @turnNumber, @groupId, @channel, @senderId, @authorized,
      @sourceAgentId, @a2aThreadId, @a2aIntent, @a2aRequiresResponse, @tokenCount,
      @modelId, @cost, @latencyMs, @reasoningContent, @inboundMeta, @attachments,
      @externalMessageId, @speaker, @voiceSessionId, @taskId, @runId, @rootKind, @rootId,
      @convKey, @originKind, @source, 'live', @sentAt, datetime('now')
    )`;

function bind(m: NewMessage): { lane: Lane; id: string; displayKind: string; displayTier: DisplayTier;
  tokenCount: number; sentAt: number; params: Record<string, unknown> } {
  const lane: Lane = m.lane ?? 'owner';
  const id = m.id ?? randomUUID();
  const display = classify(lane, m.role);
  const displayKind = m.displayKind ?? display.kind;
  const displayTier = m.displayTier ?? display.tier;
  // Estimated at WRITE. Never zero: a row that costs nothing to carry does not exist, and a
  // zero here would make every budget arithmetic downstream quietly wrong.
  const tokenCount = m.tokenCount ?? Math.max(1, estimateTokens(m.content));
  const sentAt = Date.now();
  const channel = m.channel ?? null;
  return {
    lane, id, displayKind, displayTier, tokenCount, sentAt,
    params: {
      id, agentId: m.agentId, conversationId: m.conversationId ?? null, lane,
      originIntent: m.originIntent ?? null, role: m.role, content: m.content,
      mood: m.mood ?? null, displayKind, displayTier,
      turnNumber: m.turnNumber ?? null, groupId: m.groupId ?? null,
      channel, senderId: m.senderId ?? null,
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
      originKind: legacyOriginKind(lane), source: legacySource(lane, channel),
      sentAt,
    },
  };
}

/** The ONE INSERT into `messages`. Every column the row needs is decided here.
 *  Throws on a duplicate id — use `insertMessageIfAbsent` where a colliding id is a
 *  legitimate, designed no-op (inbound de-duplication). */
export function insertMessage(m: NewMessage): Persisted {
  const db = getDb();
  const b = bind(m);
  const info = db.prepare(INSERT_SQL).run(b.params);
  const createdAt = (db.prepare('SELECT created_at FROM messages WHERE seq = ?')
    .get(info.lastInsertRowid as number) as { created_at: string }).created_at;
  return {
    seq: info.lastInsertRowid as number, id: b.id, lane: b.lane,
    displayKind: b.displayKind, displayTier: b.displayTier,
    tokenCount: b.tokenCount, createdAt, sentAt: b.sentAt,
  };
}

/** Idempotent insert: returns `null` when the row is already there.
 *
 *  R1, and this is the whole point of the form. The 80 legacy `INSERT OR IGNORE` writers
 *  used SQLite's IGNORE conflict resolution, which swallows **NOT NULL and CHECK** failures
 *  as well as UNIQUE ones — that is the silent-discard class T3 measured and the reason
 *  migration 127 had to default every spine column. `ON CONFLICT DO NOTHING` is scoped to
 *  uniqueness ALONE: a duplicate id or a repeat `external_message_id` is still a designed
 *  no-op, and a NOT NULL or CHECK violation now THROWS. Both halves proven on a VACUUM INTO
 *  copy before this was written (T4 report §2).
 *
 *  `lastInsertRowid` is stale on a no-op (SQLite reports the connection's last successful
 *  insert), so the outcome is read off `changes` and never off the rowid. */
export function insertMessageIfAbsent(m: NewMessage): Persisted | null {
  const db = getDb();
  const b = bind(m);
  const info = db.prepare(`${INSERT_SQL} ON CONFLICT DO NOTHING`).run(b.params);
  if (info.changes === 0) return null;
  const createdAt = (db.prepare('SELECT created_at FROM messages WHERE seq = ?')
    .get(info.lastInsertRowid as number) as { created_at: string }).created_at;
  return {
    seq: info.lastInsertRowid as number, id: b.id, lane: b.lane,
    displayKind: b.displayKind, displayTier: b.displayTier,
    tokenCount: b.tokenCount, createdAt, sentAt: b.sentAt,
  };
}

/** Platform coordination: never the agent speaking, never visible to a human. */
export function insertEngineEvent(
  e: Omit<NewMessage, 'lane' | 'role'> & { role?: Role },
): Persisted {
  return insertMessage({ ...e, lane: 'events', role: e.role ?? 'user' });
}

/** Idempotent twin of `insertEngineEvent`. */
export function insertEngineEventIfAbsent(
  e: Omit<NewMessage, 'lane' | 'role'> & { role?: Role },
): Persisted | null {
  return insertMessageIfAbsent({ ...e, lane: 'events', role: e.role ?? 'user' });
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

// ════════════════════════════════════════════════════════════════════════════════
// THE MUTATION VOCABULARY (T4)
//
// Every UPDATE and DELETE against `messages` lives here. "A single-writer rule that
// only covers INSERT is not one" — the conformance walk says exactly that and enforces
// it. The payoff is that this section IS the complete, enumerable list of things that
// can happen to a message row after it is written; before T4 that list was 49 statements
// scattered over 24 files and nobody could state it.
//
// TWO-TABLE DISPATCH — T10-DELETES. `inter_agent_messages` is NOT renamed until T10 (R5:
// renaming it at T3 killed every assembled turn — measured), so rows written before T4
// still live there and their lifecycle columns must stay reachable. `src` carries that,
// and this file is now the ONLY place in the tree that knows two tables exist: T4 Step 3
// removed the `${table}` interpolation from every call site.
//
// CACHE LAW (OR7): none of these touch `content` except `rewriteSystemPromptRow`, which
// is annotated at its own definition and predates this phase.
// ════════════════════════════════════════════════════════════════════════════════

/** Which physical table a pre-T4 row lives in. T10-DELETES along with the table. */
export type LegacySrc = 'm' | 'ia';
function home(src: LegacySrc = 'm'): 'messages' | 'inter_agent_messages' {
  return src === 'ia' ? 'inter_agent_messages' : 'messages';
}

// ── conv_key: the claim/park machine (PHASE2-DELETES — Phase 2 replaces it wholesale) ──

/** Compare-and-swap a row's conv_key by rowid. `expect` is the guard the call sites all
 *  carried inline: `null` = only if unclaimed, a string = only if it still holds that key,
 *  `undefined` = unconditional. Returns rows changed, which every caller uses to detect a
 *  concurrent claim — so it must stay a real count, never a boolean. */
export function setConvKeyByRowid(
  p: { rowid: number; agentId?: string; value: string | null; expect?: string | null },
  src: LegacySrc = 'm',
): number {
  const db = getDb();
  const guard = p.expect === undefined ? '' : p.expect === null ? 'AND conv_key IS NULL' : 'AND conv_key = @expect';
  const agent = p.agentId ? 'AND agent_id = @agentId' : '';
  return db.prepare(
    `UPDATE ${home(src)} SET conv_key = @value WHERE rowid = @rowid ${agent} ${guard}`,
  ).run({ rowid: p.rowid, agentId: p.agentId ?? null, value: p.value, expect: p.expect ?? null }).changes;
}

/** Tag this turn's OWN output rows with the conversation they served, so one
 *  counterparty's work cannot bleed into another's turn (content isolation, mig 076).
 *
 *  `lane` is not decoration. Before T4 this UPDATE could only ever reach owner-lane rows,
 *  because the agent's a2a own output physically lived in `inter_agent_messages` and had
 *  its own tagger. T4 folded that output into `messages` as `lane='a2a'`, so without the
 *  predicate the human conversation's key would start landing on coordination rows — a
 *  behaviour change T4 has no mandate to make. The lane filter keeps it byte-identical. */
export function tagTurnOutputConvKey(
  p: { agentId: string; turnNumber: number; convKey: string; lane?: Lane },
  src: LegacySrc = 'm',
): number {
  const db = getDb();
  const laneClause = src === 'ia' ? '' : `AND lane = @lane`;
  return db.prepare(
    `UPDATE ${home(src)} SET conv_key = @convKey
       WHERE agent_id = @agentId AND turn_number = @turnNumber
         AND role IN ('assistant','tool') AND conv_key IS NULL ${laneClause}`,
  ).run({ agentId: p.agentId, turnNumber: p.turnNumber, convKey: p.convKey, lane: p.lane ?? 'owner' }).changes;
}

/** Claim a queued engine/peer row for a turn: stamp its conv_key and, optionally, the
 *  serving turn in the same statement. Only ever claims an UNclaimed row. */
export function claimRowByRowid(
  p: { agentId: string; rowid: number; convKey: string; servedByTurn?: number | null },
  src: LegacySrc = 'm',
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE ${home(src)} SET conv_key = @convKey,
        served_by_turn = COALESCE(@servedByTurn, served_by_turn)
      WHERE agent_id = @agentId AND rowid = @rowid AND conv_key IS NULL`,
  ).run({ ...p, servedByTurn: p.servedByTurn ?? null }).changes;
}

/** Claim the assignment notice(s) for a task that has gone terminal. The content LIKE is
 *  the documented legacy fallback for pre-112 rows whose task_id is NULL; it is carried
 *  verbatim, not improved, because narrowing it here would silently change which rows
 *  retire. The `origin_kind` predicate is T6's to convert to `lane`. */
export function claimTrackerNoticeForTask(
  p: { agentId: string; contentLike: string }, src: LegacySrc = 'm',
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE ${home(src)} SET conv_key = 'engine'
       WHERE agent_id = @agentId AND origin_kind = 'engine' AND origin_intent = 'tracker'
         AND conv_key IS NULL AND content LIKE @contentLike`,
  ).run(p).changes;
}

// ── Turn boundary ──

/** Mark one row served by a turn, addressed by rowid (the shape the claim path holds). */
export function markServedByRowid(rowid: number, turnNumber: number, src: LegacySrc = 'm'): number {
  const db = getDb();
  return db.prepare(`UPDATE ${home(src)} SET served_by_turn = ? WHERE rowid = ?`)
    .run(turnNumber, rowid).changes;
}

/** Record which message answered the rows a turn served (the delivery receipt the
 *  "did I actually reply" probes read). Never overwrites an existing answer. */
export function setAnswerMessageId(
  p: { agentId: string; servedByTurn: number; answerMessageId: string }, src: LegacySrc = 'm',
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE ${home(src)} SET answer_message_id = @answerMessageId
       WHERE agent_id = @agentId AND served_by_turn = @servedByTurn AND answer_message_id IS NULL`,
  ).run(p).changes;
}

// ── Engine-event lifecycle (serve boundary, mig 099/112) ──

/** Retire a queued engine event without serving it. `requireUnclaimed` is the serve
 *  boundary's guard: a row already claimed by a turn is not ours to sweep. */
export function sweepByRowid(
  p: { rowid: number; agentId?: string; requireUnclaimed?: boolean }, src: LegacySrc = 'm',
): number {
  const db = getDb();
  const agent = p.agentId ? 'AND agent_id = @agentId' : '';
  const unclaimed = p.requireUnclaimed ? 'AND conv_key IS NULL' : '';
  return db.prepare(
    `UPDATE ${home(src)} SET swept_at = datetime('now')
       WHERE rowid = @rowid ${agent} ${unclaimed} AND swept_at IS NULL`,
  ).run({ rowid: p.rowid, agentId: p.agentId ?? null }).changes;
}

/** Retire every unclaimed engine event pointing at one referent (a task or a run whose
 *  premise is spent). The referent column is a fixed enum, never caller SQL. */
export function sweepByReferent(
  p: { referent: 'task_id' | 'run_id'; id: string }, src: LegacySrc = 'm',
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE ${home(src)} SET swept_at = datetime('now')
       WHERE ${p.referent} = ? AND conv_key IS NULL AND swept_at IS NULL`,
  ).run(p.id).changes;
}

/** Retire one row by its message id. */
export function sweepById(id: string, src: LegacySrc = 'm'): number {
  const db = getDb();
  return db.prepare(`UPDATE ${home(src)} SET swept_at = datetime('now') WHERE id = ?`)
    .run(id).changes;
}

/** Bookkeep a failed delivery: attempt counter + backoff window (mig 084). */
export function recordDeliveryAttempt(
  p: { agentId: string; rowid: number; attempts: number; backoffMinutes: number },
  src: LegacySrc = 'm',
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE ${home(src)} SET delivery_attempts = @attempts,
        next_attempt_at = datetime('now', @offset)
      WHERE agent_id = @agentId AND rowid = @rowid`,
  ).run({ agentId: p.agentId, rowid: p.rowid, attempts: p.attempts, offset: `+${p.backoffMinutes} minutes` }).changes;
}

/** Move a fired-but-undelivered engine event forward across a session reset so the new
 *  session can still serve it (D-A step 4).
 *
 *  `eligibleWhere` is a caller-supplied SQL fragment — deliberately, and it is the only
 *  one in this module. It is `DELIVERABLE_ENGINE_EVENT_WHERE`, a shared CONSTANT defined
 *  next to the eligibility reads it must stay identical to (agent/v2/counterparty.ts).
 *  Copying it here would fork the definition of "deliverable", which is the duplication
 *  this phase exists to remove. It is never built from user input. T6 owns collapsing it
 *  onto `lane` along with the rest of the eligibility predicates. */
export function rehomeUndeliveredCreatedAt(
  p: { agentId: string; newBoundary: string; eligibleWhere: string; maxAttempts: number; expiryHours: number },
  src: LegacySrc = 'm',
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE ${home(src)} SET created_at = @newBoundary
       WHERE agent_id = @agentId AND ${p.eligibleWhere}
         AND created_at < @newBoundary
         AND delivery_attempts < ${p.maxAttempts}
         AND created_at >= datetime('now', '-${p.expiryHours} hours')`,
  ).run({ agentId: p.agentId, newBoundary: p.newBoundary }).changes;
}

// ── Row fields stamped after the insert ──

/** Stamp structured routing metadata onto an inbound row (OR4). Channel producers hold
 *  the id from their own insert. T4 also passes `channel`/`authorized`/`sender_id` INTO
 *  the insert, so this now records the full meta blob for the resolver rather than being
 *  the only carrier of the routing facts. */
export function stampInboundMeta(id: string, metaJson: string): number {
  const db = getDb();
  return db.prepare('UPDATE messages SET inbound_meta = ? WHERE id = ?').run(metaJson, id).changes;
}

/** Attach (or re-path) a row's attachment manifest. */
export function setAttachments(id: string, attachmentsJson: string): number {
  const db = getDb();
  return db.prepare('UPDATE messages SET attachments = ? WHERE id = ?').run(attachmentsJson, id).changes;
}

/** Name the human who spoke a voice-session row. */
export function stampVoiceSpeaker(id: string, speaker: string, voiceSessionId: string | null): number {
  const db = getDb();
  return db.prepare(
    'UPDATE messages SET speaker = ?, voice_session_id = COALESCE(?, voice_session_id) WHERE id = ?',
  ).run(speaker, voiceSessionId, id).changes;
}

/** "This assistant row was spoken aloud." Was `source='voice'`; `channel` is where that
 *  fact lives now (T3-0b §3). `source` is kept in step for the compat window — T10-DELETES
 *  with the column. Routing columns only, so the cache prefix is untouched. */
export function markSpokenAloud(id: string): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET channel = 'voice', source = 'voice'
       WHERE id = ? AND role = 'assistant' AND (channel IS NULL OR channel = '')`,
  ).run(id).changes;
}

/** Re-write the agent's persisted SYSTEM-PROMPT row in place.
 *
 *  CACHE LAW EXCEPTION, pre-existing and deliberate. The cache-prefix rule is that a row's
 *  `content` is written once and never rewritten; this is the one row where the platform
 *  has always done otherwise, because the system prompt IS the prefix and editing the
 *  agent's instructions is meant to move it. Three call sites had this statement inline
 *  (the prompt editor, the agent route, the vault's prompt refresh); they are the same
 *  operation and now say so. It must never be generalised to ordinary history rows —
 *  one such backfill invalidates every conversation prefix on every provider at once. */
export function rewriteSystemPromptRow(id: string, content: string): number {
  const db = getDb();
  return db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id).changes;
}

// ── Deletes ──

/** Every message for an agent. Used by agent deletion and by the three singleton agents
 *  (imaginer/trainer/PM) that reset their own scratch history. */
export function deleteAllForAgent(agentId: string, src: LegacySrc = 'm'): number {
  const db = getDb();
  return db.prepare(`DELETE FROM ${home(src)} WHERE agent_id = ?`).run(agentId).changes;
}

/** Everything older than a cutoff row, for the PM's bounded scratch history. Deletes the
 *  dependent summary rows first, in one transaction, exactly as the call site did. */
export function deleteForAgentBefore(agentId: string, cutoffId: string): number {
  const db = getDb();
  const txn = db.transaction((aid: string, cid: string): number => {
    db.prepare(`
      DELETE FROM summary_messages
      WHERE message_id IN (
        SELECT id FROM messages WHERE agent_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)
      )
    `).run(aid, cid);
    return db.prepare(
      'DELETE FROM messages WHERE agent_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)',
    ).run(aid, cid).changes;
  });
  return txn(agentId, cutoffId);
}

/** Wipe an agent's conversation but keep its system rows (identity + session boundary). */
export function deleteNonSystemForAgent(agentId: string): number {
  const db = getDb();
  return db.prepare("DELETE FROM messages WHERE agent_id = ? AND role != 'system'").run(agentId).changes;
}

/** The agent-bus rows an agent is either end of. Replaces the third store's own DELETE
 *  cascade (`DELETE FROM agent_messages WHERE from_agent = ? OR to_agent = ?`) exactly:
 *  both directions, and scoped by `origin_intent` so it can never reach ordinary peer
 *  A2A traffic, which that statement could not see. */
export function deleteAgentBusRowsFor(agentId: string): number {
  const db = getDb();
  return db.prepare(
    `DELETE FROM messages WHERE origin_intent = '${AGENT_BUS_INTENT}'
       AND (agent_id = @agentId OR source_agent_id = @agentId)`,
  ).run({ agentId }).changes;
}

/** What marks a row as the agent BUS (spawn results, PM status, scheduler notices)
 *  rather than ordinary peer conversation. `origin_intent` is the open-vocabulary
 *  "which subsystem produced this" column (T3-0b §2) and this is exactly its job. */
export const AGENT_BUS_INTENT = 'agent_bus';
