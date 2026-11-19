// The single writer for `messages`: lane, channel, sender, trust and display kind are stamped here at ingest
// from the caller's meta, never re-derived downstream. Keep every write to `messages` in this file.
// Keep the DEFAULTs on NOT NULL columns: they stop `INSERT OR IGNORE` writers discarding rows in silence.
// CACHE LAW: `content` is written once (except `rewriteSystemPromptRow`); token_count is estimated at write.

import { randomUUID } from 'node:crypto';
import {
  classifyMessageForDisplay, parseMoodMarker, stripMoodMarker, stripNoReplySentinel,
  parseWorkingNote, WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX,
  deriveOrigin, legacyOriginInputs,
  type BroadcastRow, type DisplayKind, type MessageLane, type VisibilityTier,
} from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { AGENT_BUS_INTENT, START_ACK_ORIGIN_INTENT } from './origin-intents.js';
import { withUnit } from '../db/unit.js';
import { openAsk, askIdForMessage } from '../work/store.js';
import { NOW_MS, createdAtText } from './store.js';
import { estimateStoredTokens } from './budget.js';
import { turnContext } from '../agent/turn-context.js';

export { NOW_MS, createdAtText };

/** Owned by `@dojo/shared` so the write side, the read side and the column's CHECK spell it one way. */
export type Lane = MessageLane;
export type Role = 'user' | 'assistant' | 'system' | 'tool';
export type DisplayTier = VisibilityTier;

export interface NewMessage {
  agentId: string;
  role: Role;
  content: string;
  /** Defaults to the owner lane: agent traffic must be declared, never assumed. */
  lane?: Lane;
  id?: string;
  conversationId?: string | null;
  /** Sub-classifies the events lane, and marks engine-composed owner-lane acks. */
  originIntent?: string | null;
  turnNumber?: number | null;
  groupId?: string | null;
  channel?: string | null;
  senderId?: string | null;
  /** The producer's OWN verdict, carried from the meta it already had. */
  authorized?: boolean;
  sourceAgentId?: string | null;
  a2aThreadId?: string | null;
  a2aIntent?: string | null;
  a2aRequiresResponse?: boolean | null;
  // No `tokenCount`: the column is always derived (a provider's output count would be billed as input).
  modelId?: string | null;
  cost?: number | null;
  latencyMs?: number | null;
  reasoningContent?: string | null;
  inboundMeta?: string | null;
  attachments?: string | null;
  externalMessageId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  rootKind?: string | null;
  rootId?: string | null;
  mood?: string | null;
  displayKind?: DisplayKind;
  displayTier?: DisplayTier;
  /** Resolved before the transaction (`work/ask-title.ts`); NEVER derived from `content` here. */
  askTitle?: string | null;
  /** What an OWN row belongs to; absent = derived at insert (`ownRowSubject`). */
  subjectKind?: SubjectKind | null;
}

/** Migration 188's CHECK is the authority. Only `conv` is excluded from ANOTHER conversation's scope;
 *  `delivered` reaches a conversation after the turn that asked, and `root_id` names the request. */
export type SubjectKind = 'conv' | 'a2a_thread' | 'engine_event' | 'background' | 'legacy' | 'delivered' | 'unknown';

export interface Persisted {
  seq: number;
  id: string;
  lane: Lane;
  displayKind: DisplayKind;
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
  lane: Lane; display_kind: DisplayKind; display_tier: DisplayTier; token_count: number;
  created_at: string; sent_at: number; turn_number: number | null; channel: string | null;
  origin_intent: string | null; source_agent_id: string | null; served_by_turn: number | null;
}

const SELECT_COLS = `seq, id, agent_id, role, content, lane, display_kind, display_tier,
  token_count, ${createdAtText()}, sent_at, turn_number, channel, origin_intent, source_agent_id,
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

// Rows are stored as they should be READ: the mood marker moves to `mood`, and `[no-reply]` is stripped, only from
// agent-authored text (assistant rows, working-note wrappers), never tool data, user words or a system prompt.
// Display kind uses `@dojo/shared`'s classifier, the same one the dashboard runs.

function displayReady(text: string): string {
  return stripNoReplySentinel(stripMoodMarker(text)).trim();
}

function prepareContent(role: Role, content: string): { content: string; mood: string | null } {
  if (role === 'assistant') {
    return { content: displayReady(content), mood: parseMoodMarker(content) };
  }
  if (role === 'system') {
    // Strip inside the engine's working-note prefix, then put the prefix back, so the spacing survives.
    const note = parseWorkingNote(content);
    if (!note) return { content, mood: null };
    const prefix = note.internal ? INTERNAL_WORKING_NOTE_PREFIX : WORKING_NOTE_PREFIX;
    return { content: `${prefix}${displayReady(note.text)}`, mood: parseMoodMarker(note.text) };
  }
  return { content, mood: null };
}

const INSERT_SQL = `
    INSERT INTO messages (
      id, agent_id, conversation_id, lane, origin_intent, role, content, mood,
      display_kind, display_tier, turn_number, group_id, channel, sender_id, authorized,
      source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, token_count,
      model_id, cost, latency_ms, reasoning_content, inbound_meta, attachments,
      external_message_id, task_id, run_id, root_kind, root_id,
      subject_kind, sent_at, created_at
    ) VALUES (
      @id, @agentId, @conversationId, @lane, @originIntent, @role, @content, @mood,
      @displayKind, @displayTier, @turnNumber, @groupId, @channel, @senderId, @authorized,
      @sourceAgentId, @a2aThreadId, @a2aIntent, @a2aRequiresResponse, @tokenCount,
      @modelId, @cost, @latencyMs, @reasoningContent, @inboundMeta, @attachments,
      @externalMessageId, @taskId, @runId, @rootKind, @rootId,
      @subjectKind, @sentAt, ${NOW_MS}
    )`;

// Every own row is labelled at birth from the turn record, the turn's bag or an earlier row of the turn; an
// unlabelled row would be kept by the scopers as the owner's own work.
interface OwnSubject { subjectKind: SubjectKind | null; conversationId: string | null; a2aThreadId: string | null }

function ownRowSubject(m: NewMessage, lane: Lane): OwnSubject {
  const conversationId = m.conversationId ?? null;
  const a2aThreadId = m.a2aThreadId ?? null;
  const given = { conversationId, a2aThreadId };
  if (m.role !== 'assistant' && m.role !== 'tool') return { subjectKind: m.subjectKind ?? null, ...given };
  if (m.subjectKind) return { subjectKind: m.subjectKind, ...given };
  if (conversationId && lane === 'owner') return { subjectKind: 'conv', ...given };
  if (m.turnNumber == null) return { subjectKind: 'unknown', ...given };
  const db = getDb();
  const turn = db.prepare('SELECT subject_kind, subject_id FROM turns WHERE agent_id = ? AND turn_number = ?')
    .get(m.agentId, m.turnNumber) as { subject_kind: string | null; subject_id: string | null } | undefined;
  if (lane === 'a2a' || turn?.subject_kind === 'a2a_thread') {
    const thread = a2aThreadId
      ?? (db.prepare(`SELECT a2a_thread_id FROM messages WHERE agent_id = ? AND turn_number = ?
                        AND role IN ('assistant','tool') AND a2a_thread_id IS NOT NULL
                      ORDER BY seq DESC LIMIT 1`).get(m.agentId, m.turnNumber) as
            { a2a_thread_id: string } | undefined)?.a2a_thread_id
      ?? (turn?.subject_kind === 'a2a_thread' ? turn.subject_id : null);
    return { subjectKind: 'a2a_thread', conversationId, a2aThreadId: thread ?? null };
  }
  switch (turn?.subject_kind) {
    case 'conv': case 'continuation': {
      const bag = turnContext(m.agentId);
      const conv = bag && bag.turnNumber === m.turnNumber ? (bag.conversationId ?? null) : null;
      return conv ? { subjectKind: 'conv', conversationId: conv, a2aThreadId } : { subjectKind: 'unknown', ...given };
    }
    case 'engine_event': return { subjectKind: 'engine_event', ...given };
    case 'none': return { subjectKind: 'background', ...given };
    default: return { subjectKind: 'unknown', ...given };
  }
}

/** A result reaching a conversation after the asking turn: its conversation and the request it answers. */
export function deliveredResult(conversationId: string | null | undefined, requestMessageId: string | null | undefined):
  Pick<NewMessage, 'conversationId' | 'subjectKind' | 'rootKind' | 'rootId'> {
  return { conversationId: conversationId ?? null, subjectKind: 'delivered', rootKind: requestMessageId ? 'ask' : null, rootId: requestMessageId ?? null };
}

export function subjectKindsBySeq(agentId: string, seqs: number[]): Map<number, SubjectKind | null> {
  const out = new Map<number, SubjectKind | null>();
  if (seqs.length === 0) return out;
  const rows = getDb().prepare(
    `SELECT seq, subject_kind FROM messages WHERE agent_id = ? AND seq IN (${seqs.map(() => '?').join(',')})`,
  ).all(agentId, ...seqs) as Array<{ seq: number; subject_kind: SubjectKind | null }>;
  for (const r of rows) out.set(r.seq, r.subject_kind);
  return out;
}

function bind(m: NewMessage): { lane: Lane; id: string; displayKind: DisplayKind; displayTier: DisplayTier;
  tokenCount: number; sentAt: number; params: Record<string, unknown> } {
  const lane: Lane = m.lane ?? 'owner';
  const subject = ownRowSubject(m, lane);
  const id = m.id ?? randomUUID();
  const prepared = prepareContent(m.role, m.content);
  // Classified from the display-ready content, so the kind describes what will actually be read.
  const display = classifyMessageForDisplay({
    role: m.role, content: prepared.content, lane, originIntent: m.originIntent ?? null,
  });
  const displayKind = m.displayKind ?? display.kind;
  const displayTier = m.displayTier ?? display.tier;
  // From the stored (post-strip) bytes, so the budget counts only what the model sees; never zero.
  const tokenCount = estimateStoredTokens(prepared.content);
  const sentAt = Date.now();
  const channel = m.channel ?? null;
  return {
    lane, id, displayKind, displayTier, tokenCount, sentAt,
    params: {
      id, agentId: m.agentId, conversationId: subject.conversationId, lane,
      originIntent: m.originIntent ?? null, role: m.role, content: prepared.content,
      mood: m.mood ?? prepared.mood, displayKind, displayTier,
      turnNumber: m.turnNumber ?? null, groupId: m.groupId ?? null,
      channel, senderId: m.senderId ?? null,
      authorized: (m.authorized ?? true) ? 1 : 0,
      sourceAgentId: m.sourceAgentId ?? null, a2aThreadId: subject.a2aThreadId,
      a2aIntent: m.a2aIntent ?? null,
      a2aRequiresResponse: m.a2aRequiresResponse == null ? null : (m.a2aRequiresResponse ? 1 : 0),
      tokenCount, modelId: m.modelId ?? null, cost: m.cost ?? null,
      latencyMs: m.latencyMs ?? null, reasoningContent: m.reasoningContent ?? null,
      inboundMeta: m.inboundMeta ?? null, attachments: m.attachments ?? null,
      externalMessageId: m.externalMessageId ?? null, taskId: m.taskId ?? null, runId: m.runId ?? null,
      rootKind: m.rootKind ?? null, rootId: m.rootId ?? null,
      subjectKind: subject.subjectKind,
      sentAt,
    },
  };
}

// An owner ask opens its ask record in the same transaction, so a person's question never lacks its obligation.

function isOwnerAsk(m: NewMessage, storedContent: string): boolean {
  if (m.role !== 'user') return false;
  const lane: Lane = m.lane ?? 'owner';
  if (lane !== 'owner') return false;
  if (m.sourceAgentId || m.a2aThreadId) return false;
  // An unauthorized sender is recorded but owes no ask. The producer's verdict goes first: `inbound_meta` lands
  // after this insert, so `deriveOrigin` alone would trust any channel-named row. An absent verdict narrows nothing.
  if (m.authorized === false) return false;
  // An owner-lane user row with no channel is the platform writing to itself, not an ingest path: an ask it
  // opened could never be served or closed.
  if (!m.channel) return false;
  const o = deriveOrigin({
    role: 'user', content: storedContent,
    ...legacyOriginInputs(lane, m.channel ?? null),
    sourceAgentId: m.sourceAgentId ?? null,
    a2aThreadId: m.a2aThreadId ?? null,
    a2aIntent: m.a2aIntent ?? null,
    a2aRequiresResponse: m.a2aRequiresResponse == null ? null : (m.a2aRequiresResponse ? 1 : 0),
    inboundMeta: m.inboundMeta ?? null,
    originIntent: m.originIntent ?? null,
  });
  return o.kind === 'user' && o.authorized;
}

/** The one ask gate, asked from outside so the ingest door can resolve a title before its transaction. */
export function wouldOpenAsk(m: NewMessage): boolean {
  return isOwnerAsk(m, prepareContent(m.role, m.content).content);
}

/** Runs inside the caller's transaction. */
function persistAndMaybeOpenAsk(m: NewMessage, b: ReturnType<typeof bind>, seq: number): string {
  const db = getDb();
  const row = db.prepare(`SELECT ${createdAtText()}, created_at AS created_ms FROM messages WHERE seq = ?`)
    .get(seq) as { created_at: string; created_ms: number };
  if (isOwnerAsk(m, b.params.content as string)) {
    openAsk({
      agentId: m.agentId,
      messageId: b.id,
      conversationId: m.conversationId ?? null,
      requesterId: m.senderId ?? null,
      openedAt: row.created_ms,
      // Never a slice of the content (it could carry a credential): a resolved title, else the ask's own id.
      title: m.askTitle ?? askIdForMessage(b.id),
    });
  }
  return row.created_at;
}

/** Throws on a duplicate id. The insert and its ask are ONE transaction: losing a message loudly is
 *  recoverable, storing one no agent can see is not. */
export function insertMessage(m: NewMessage): Persisted {
  const db = getDb();
  const b = bind(m);
  return withUnit((): Persisted => {
    const info = db.prepare(INSERT_SQL).run(b.params);
    const seq = info.lastInsertRowid as number;
    const createdAt = persistAndMaybeOpenAsk(m, b, seq);
    return {
      seq, id: b.id, lane: b.lane,
      displayKind: b.displayKind, displayTier: b.displayTier,
      tokenCount: b.tokenCount, createdAt, sentAt: b.sentAt,
    };
  });
}

/** `ON CONFLICT DO NOTHING` swallows only uniqueness (unlike `INSERT OR IGNORE`, NOT NULL and CHECK still
 *  throw). `lastInsertRowid` is stale on a no-op, so the outcome is read off `changes`. */
export function insertMessageIfAbsent(m: NewMessage): Persisted | null {
  const db = getDb();
  const b = bind(m);
  return withUnit((): Persisted | null => {
    const info = db.prepare(`${INSERT_SQL} ON CONFLICT DO NOTHING`).run(b.params);
    // A designed no-op writes NO ask record: a producer retrying an inbound must not mint a second ask.
    if (info.changes === 0) return null;
    const seq = info.lastInsertRowid as number;
    const createdAt = persistAndMaybeOpenAsk(m, b, seq);
    return {
      seq, id: b.id, lane: b.lane,
      displayKind: b.displayKind, displayTier: b.displayTier,
      tokenCount: b.tokenCount, createdAt, sentAt: b.sentAt,
    };
  });
}

/** REQUIRED so a new engine writer cannot forget its referent; `null` means the row is about no specific work.
 *  Real ids let a serve-boundary check retire the row when its referent is spent. */
export interface EngineEventWork {
  taskId: string | null;
  runId: string | null;
  rootKind: string | null;
  rootId: string | null;
}

type EngineEventInput =
  Omit<NewMessage, 'lane' | 'role' | 'taskId' | 'runId' | 'rootKind' | 'rootId'>
  & { role?: Role; work: EngineEventWork | null };

function engineRow(e: EngineEventInput): NewMessage {
  const { work, ...rest } = e;
  return {
    ...rest, lane: 'events', role: e.role ?? 'user',
    taskId: work?.taskId ?? null, runId: work?.runId ?? null,
    rootKind: work?.rootKind ?? null, rootId: work?.rootId ?? null,
  };
}

/** Platform coordination: never the agent speaking, never visible to a human. */
export function insertEngineEvent(e: EngineEventInput): Persisted {
  return insertMessage(engineRow(e));
}

export function insertEngineEventIfAbsent(e: EngineEventInput): Persisted | null {
  return insertMessageIfAbsent(engineRow(e));
}

// `chat_messages` stays the only human-facing accessor; anything rendered to a person reads the view.

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

export interface PersistedSnapshot extends BroadcastRow {
  content: string;
  /** The chat history route's own projection, so live and reloaded rows carry the same characters. */
  createdAtText: string;
}

/** The broadcast seam's row read (`gateway/ws.ts`). Not the `chat_messages` view: it returns nothing for
 *  a2a and events rows, which would read as no row at all. */
export function readPersistedRow(id: string): PersistedSnapshot | null {
  const db = getDb();
  const r = db.prepare(`
    SELECT seq, id, lane, display_kind, display_tier, mood, content,
           created_at AS created_at_ms, ${createdAtText('created_at', 'created_at_text')}
      FROM messages WHERE id = ?
  `).get(id) as
    | { seq: number; id: string; lane: Lane; display_kind: DisplayKind; display_tier: DisplayTier;
        mood: string | null; content: string; created_at_ms: number; created_at_text: string }
    | undefined;
  if (!r) return null;
  return {
    seq: r.seq, id: r.id, lane: r.lane,
    displayKind: r.display_kind, displayTier: r.display_tier,
    createdAt: r.created_at_ms, mood: r.mood ?? null,
    content: r.content, createdAtText: r.created_at_text,
  };
}

// UPDATEs and DELETEs against `messages`: this file's whole list.

/** Second chance at pickup for a row whose ingest left `conversation_id` NULL. Stamped apart from the serve
 *  claim, so the trigger row belongs to this conversation whether or not this turn won the serve race. */
export function stampConversationIdByRowid(
  p: { rowid: number; agentId?: string; conversationId: string | null },
): number {
  const db = getDb();
  const agent = p.agentId ? 'AND agent_id = @agentId' : '';
  return db.prepare(
    `UPDATE messages SET conversation_id = @value WHERE rowid = @rowid ${agent}`,
  ).run({ rowid: p.rowid, agentId: p.agentId ?? null, value: p.conversationId }).changes;
}

/** Writes only `served_by_turn`: a user row's conversation was resolved at ingest, and the may-I-take-it guard
 *  is the ask record's `transition(... expectedState:'open')`, checked before this. */
export function recordServingTurnByRowid(
  p: { agentId: string; rowid: number; servedByTurn?: number | null },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET served_by_turn = COALESCE(@servedByTurn, served_by_turn)
      WHERE agent_id = @agentId AND rowid = @rowid`,
  ).run({ ...p, servedByTurn: p.servedByTurn ?? null }).changes;
}

/** Retires assignment notices with no `task_id`, which `sweepByReferent` cannot reach; un-retired, one would
 *  be re-delivered as a fresh "begin working on this task" prompt. */
export function claimTrackerNoticeForTask(
  p: { agentId: string; contentLike: string },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET swept_at = ${NOW_MS}
       WHERE agent_id = @agentId AND lane = 'events' AND origin_intent = 'tracker'
         AND task_id IS NULL
         AND served_by_turn IS NULL AND swept_at IS NULL AND content LIKE @contentLike`,
  ).run(p).changes;
}

export function markServedByRowid(rowid: number, turnNumber: number): number {
  const db = getDb();
  return db.prepare(`UPDATE messages SET served_by_turn = ? WHERE rowid = ?`)
    .run(turnNumber, rowid).changes;
}

/** The engine event's atomic pickup. `.changes` 0 means another process took it and the caller MUST honour
 *  that, or one event drives two turns. Runs after `startTurn`; it guards a second process on one SQLite DB. */
export function claimEngineEventByRowid(
  p: { rowid: number; agentId: string; turnNumber: number },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET served_by_turn = @turnNumber
       WHERE rowid = @rowid AND agent_id = @agentId AND served_by_turn IS NULL`,
  ).run(p).changes;
}

/** Idempotent; the `served_by_turn = @turnNumber` guard means only the turn that took it may return it. */
export function releaseEngineEventByRowid(
  p: { rowid: number; agentId: string; turnNumber: number },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET served_by_turn = NULL
       WHERE rowid = @rowid AND agent_id = @agentId AND served_by_turn = @turnNumber`,
  ).run(p).changes;
}

/** A cheap pre-check only; the authoritative answer is `claimEngineEventByRowid`'s CAS. */
export function isRowUnserved(rowid: number, agentId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT served_by_turn FROM messages WHERE rowid = ? AND agent_id = ?')
    .get(rowid, agentId) as { served_by_turn: number | null } | undefined;
  return row != null && row.served_by_turn == null;
}

/** The delivery receipt the "did I actually reply" probes read; never overwrites an existing answer. */
export function setAnswerMessageId(
  p: { agentId: string; servedByTurn: number; answerMessageId: string },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET answer_message_id = @answerMessageId
       WHERE agent_id = @agentId AND served_by_turn = @servedByTurn AND answer_message_id IS NULL`,
  ).run(p).changes;
}

/** One-way `reasoning_aged_out` 0 -> 1; `content` and `reasoning_content` stay (the dashboard shows them), only
 *  replay to the provider stops. The policy lives in `memory/compaction.ts`. `activeTurn` is never stamped, and
 *  0 retires nothing. */
export function retireReplayedReasoningBeforeTurn(
  p: { agentId: string; activeTurn: number },
): number {
  return getDb().prepare(
    `UPDATE messages SET reasoning_aged_out = 1
      WHERE agent_id = @agentId
        AND reasoning_aged_out = 0
        AND reasoning_content IS NOT NULL AND reasoning_content <> ''
        AND turn_number IS NOT NULL AND turn_number < @activeTurn`,
  ).run(p).changes;
}

/** The turn-end half of the draft demotion in `post-call-classify/terminal-text.ts` (the answer is known only at
 *  turn end). Only `display_kind` moves, never `content` (replayed in the prefix). Returns the moved rows so the
 *  caller announces each one, else the live view and a reload come apart.
 *  The key is `turns.answer_message_id`, never prose; a caller with no recorded answer must not call. */
export function reclassifyDraftsAsWorkingNotes(
  p: { agentId: string; turnNumber: number; answerMessageId: string },
): Array<{ id: string; content: string }> {
  const db = getDb();
  const select = db.prepare(
    `SELECT id, content FROM messages
      WHERE agent_id = @agentId AND turn_number = @turnNumber AND lane = 'owner'
        AND role = 'assistant' AND display_kind = 'agent-text' AND id <> @answerMessageId
        AND retired_at IS NULL
      ORDER BY seq ASC`,
  );
  const update = db.prepare(
    `UPDATE messages SET display_kind = 'working-note'
      WHERE agent_id = @agentId AND turn_number = @turnNumber AND lane = 'owner'
        AND role = 'assistant' AND display_kind = 'agent-text' AND id <> @answerMessageId
        AND retired_at IS NULL`,
  );
  // One transaction, so the caller announces exactly the set that moved.
  return db.transaction((): Array<{ id: string; content: string }> => {
    const rows = select.all(p) as Array<{ id: string; content: string }>;
    if (rows.length === 0) return [];
    update.run(p);
    return rows;
  })();
}

/** `requireUnclaimed`: a row already claimed by a turn is not ours to sweep. */
export function sweepByRowid(
  p: { rowid: number; agentId?: string; requireUnclaimed?: boolean },
): number {
  const db = getDb();
  const agent = p.agentId ? 'AND agent_id = @agentId' : '';
  const unclaimed = p.requireUnclaimed ? 'AND served_by_turn IS NULL' : '';
  return db.prepare(
    `UPDATE messages SET swept_at = ${NOW_MS}
       WHERE rowid = @rowid ${agent} ${unclaimed} AND swept_at IS NULL`,
  ).run({ rowid: p.rowid, agentId: p.agentId ?? null }).changes;
}

/** Unclaimed engine events of a spent task or run; the referent column is a fixed enum, never caller SQL. */
export function sweepByReferent(
  p: { referent: 'task_id' | 'run_id'; id: string },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET swept_at = ${NOW_MS}
       WHERE ${p.referent} = ? AND served_by_turn IS NULL AND swept_at IS NULL`,
  ).run(p.id).changes;
}

export function sweepById(id: string): number {
  const db = getDb();
  return db.prepare(`UPDATE messages SET swept_at = ${NOW_MS} WHERE id = ?`)
    .run(id).changes;
}

/** Display suppression only (`retired_at`); the row stays. */
export function retireById(id: string): number {
  const db = getDb();
  return db.prepare(`UPDATE messages SET retired_at = ${NOW_MS} WHERE id = ? AND retired_at IS NULL`)
    .run(id).changes;
}

/** When a row may be served again (`notBefore`, epoch ms) and, when given, its failed-delivery count (else unchanged). */
export function recordDeliveryAttempt(p: { agentId: string; rowid: number; notBefore: number; attempts?: number }): number {
  return getDb().prepare('UPDATE messages SET next_attempt_at = ?, delivery_attempts = COALESCE(?, delivery_attempts) WHERE agent_id = ? AND rowid = ?')
    .run(p.notBefore, p.attempts ?? null, p.agentId, p.rowid).changes;
}

/** `eligibleWhere` is the constant `DELIVERABLE_ENGINE_EVENT_WHERE` (agent/v2/counterparty.ts), never user
 *  input, and the only caller SQL here: copying it would fork "deliverable". `newBoundary` is TEXT, wrapped
 *  because `created_at` is INTEGER under a typeof CHECK. The one place `created_at` is written after the
 *  insert. */
export function rehomeUndeliveredCreatedAt(
  p: { agentId: string; newBoundary: string; eligibleWhere: string; maxAttempts: number; expiryHours: number },
): number {
  const db = getDb();
  const boundary = '(unixepoch(@newBoundary) * 1000)';
  const horizon = `(CAST(strftime('%s','now', '-${p.expiryHours} hours') AS INTEGER) * 1000)`;
  return db.prepare(
    `UPDATE messages SET created_at = ${boundary}
       WHERE agent_id = @agentId AND ${p.eligibleWhere}
         AND created_at < ${boundary}
         AND delivery_attempts < ${p.maxAttempts}
         AND created_at >= ${horizon}`,
  ).run({ agentId: p.agentId, newBoundary: p.newBoundary }).changes;
}

/** The full meta blob for the resolver; `channel`, `authorized` and `sender_id` already went in the insert. */
export function stampInboundMeta(id: string, metaJson: string): number {
  const db = getDb();
  return db.prepare('UPDATE messages SET inbound_meta = ? WHERE id = ?').run(metaJson, id).changes;
}

/** Routing column only, so the cache prefix is untouched. */
export function markSpokenAloud(id: string): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET channel = 'voice'
       WHERE id = ? AND role = 'assistant' AND (channel IS NULL OR channel = '')`,
  ).run(id).changes;
}

/** CACHE LAW EXCEPTION: the system prompt IS the prefix, and editing instructions is meant to move it. Never
 *  generalise to history rows: one backfill invalidates every conversation prefix on every provider. */
export function rewriteSystemPromptRow(id: string, content: string): number {
  const db = getDb();
  return db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id).changes;
}

export function deleteAllForAgent(agentId: string): number {
  const db = getDb();
  return db.prepare(`DELETE FROM messages WHERE agent_id = ?`).run(agentId).changes;
}

export interface ThreadReply { id: string; from: string; content: string; at: number }

/** The replies on `threadId` in `askerId`'s store since `sinceMs` (epoch ms), oldest first: rows from anyone but
 *  the asker. */
export function repliesSince(askerId: string, threadId: string, sinceMs: number): ThreadReply[] {
  return getDb().prepare(`
    SELECT id, source_agent_id AS "from", content, created_at AS at
      FROM messages
     WHERE agent_id = ? AND a2a_thread_id = ? AND source_agent_id IS NOT NULL AND source_agent_id <> ?
       AND created_at >= ?
     ORDER BY rowid
  `).all(askerId, threadId, askerId, sinceMs) as ThreadReply[];
}

// Add no by-agent conversation wipe: `deleteAllForAgent` is for teardown only, where erasing everything is meant.

/** Scoped by `origin_intent`, so it can never reach ordinary peer A2A traffic. */
export function deleteAgentBusRowsFor(agentId: string): number {
  const db = getDb();
  return db.prepare(
    `DELETE FROM messages WHERE origin_intent = '${AGENT_BUS_INTENT}'
       AND (agent_id = @agentId OR source_agent_id = @agentId)`,
  ).run({ agentId }).changes;
}

/** Declared in the leaf `origin-intents.ts` (an ESM re-export is safe at module scope). Never move it here:
 *  `work/ask-settlement.ts` reads it at module scope through an import cycle. */
export { AGENT_BUS_INTENT, START_ACK_ORIGIN_INTENT };
