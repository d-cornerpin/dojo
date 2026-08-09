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
import {
  classifyMessageForDisplay, parseMoodMarker, stripMoodMarker, stripNoReplySentinel,
  parseWorkingNote, WORKING_NOTE_PREFIX, INTERNAL_WORKING_NOTE_PREFIX,
  deriveOrigin, legacyOriginInputs,
  type BroadcastRow, type DisplayKind, type MessageLane, type VisibilityTier,
} from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { withUnit } from '../db/unit.js';
import { openAsk, askIdForMessage } from '../work/store.js';
import { NOW_MS, createdAtText } from './store.js';
import { estimateStoredTokens } from './budget.js';

export { NOW_MS, createdAtText };

/** The lane vocabulary is owned by `@dojo/shared` (T8) so the write side, the read side and
 *  the column's CHECK cannot spell it three ways. Kept exported under this name because
 *  ~30 call sites import it from here. */
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
  // `tokenCount` is DELIBERATELY NOT ACCEPTED (PHASE-3 T2 Step 3b): its only three callers
  // (loop.ts:5381/:5436/:7550) passed the provider's OUTPUT count for the whole turn into a
  // column the budget spends as INPUT cost — 3.24x on the assistant lane, +36.9% store-wide,
  // measured. The real numbers live in `cost_records`. This column is DERIVED, always.
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
  displayKind?: DisplayKind;
  displayTier?: DisplayTier;
  /** PHASE-5 T9 (decision D4) — the title for the ask ticket this row may open,
   *  RESOLVED BEFORE THE TRANSACTION by `insertInboundMessageIfAbsent`. Absent
   *  means the ticket is written with its own identifier as its title, which is
   *  content-free by construction. It is NEVER derived from `content` here:
   *  that mechanism (`content.slice(0, 120)`) is the one T9 removed. */
  askTitle?: string | null;
}

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

// ── Display classification (write-time, 17 §C1) — PHASE-1 T8 ──
//
// T3 left a five-line lane+role stub here with a note saying T8 would come and take it.
// This is that. The classifier is `@dojo/shared`'s `classifyMessageForDisplay`, the SAME
// function the dashboard calls, so the write side and the read side cannot answer
// differently — which is the defect this replaces, not a tidiness preference: a comma and an
// em-dash were enough to make one marker invisible to its own reader.
//
// The stub's vocabulary was a subset of the shared one, so no historical row changes meaning
// and nothing was reclassified: the six values already in the live table
// (`user-text`, `agent-text`, `tool-turn`, `engine-note`, `a2a`, `unclassified`) are all
// still legal under migration 132's CHECK.
//
// ── Display-ready content (17 §C3) ──
//
// A row is stored as it should be READ. The orb mood marker goes to `mood`; a `[no-reply]`
// sentinel that survived the engine's own handling is removed. The mood was previously kept
// in `content` "so the dashboard can still animate the orb" — measured at 2f54de3, that is
// no longer why: the orb emotes from the streaming `chat:chunk` text and from the broadcast
// payload, neither of which this module builds. Nothing reads the marker back out of a
// stored row.
//
// THE STRIP IS SCOPED, DELIBERATELY. It applies to text the AGENT authored — role='assistant'
// — and to the engine's `[working-note]` wrapper around that same text. It does NOT apply to:
//   * role='tool'   — verbatim external data. A file_read of this repository genuinely
//                     returns the literal `((mood: NAME))`; stripping it would make the
//                     platform lie about the file it was shown.
//   * role='user'   — the human's own words.
//   * role='system' without a working-note prefix — this is how an agent's SYSTEM PROMPT is
//                     stored (routes/agents.ts, agent/tools.ts), and those instructions
//                     legitimately document the marker.
// Both directions are asserted in `__tests__/message-store.test.ts`.
//
// CACHE LAW: this runs at INSERT only. No historical byte is rewritten, and nothing here
// touches a row that already exists.

function displayReady(text: string): string {
  return stripNoReplySentinel(stripMoodMarker(text));
}

function prepareContent(role: Role, content: string): { content: string; mood: string | null } {
  if (role === 'assistant') {
    return { content: displayReady(content), mood: parseMoodMarker(content) };
  }
  if (role === 'system') {
    // A working note is the engine's WRAPPER around the agent's own narration. The prefix
    // comes off, the narration is made display-ready, the prefix goes back — rather than
    // stripping through the prefix and hoping the spacing survives.
    const note = parseWorkingNote(content);
    if (!note) return { content, mood: null };
    const prefix = note.internal ? INTERNAL_WORKING_NOTE_PREFIX : WORKING_NOTE_PREFIX;
    return { content: `${prefix}${displayReady(note.text)}`, mood: parseMoodMarker(note.text) };
  }
  return { content, mood: null };
}

// PHASE-1 T6: the legacy-column projection is GONE with migration 129. T4 added
// `legacyOriginKind`/`legacySource` here so the single writer could keep `origin_kind` and
// `source` TRUE while ~120 reads still consulted them (R1: the box stays alive and
// OR8-verifiable after EVERY task). T5 and T6 emptied the reader side, 129 drops the
// columns, and the derivation goes with them. STRIP; requirement preserved: "engine
// coordination and peer traffic are structurally distinguishable from a person speaking,
// without parsing prose" — carried by `lane`, which is CHECK-constrained at the database
// where the two columns were nullable free text.

const INSERT_SQL = `
    INSERT INTO messages (
      id, agent_id, conversation_id, lane, origin_intent, role, content, mood,
      display_kind, display_tier, turn_number, group_id, channel, sender_id, authorized,
      source_agent_id, a2a_thread_id, a2a_intent, a2a_requires_response, token_count,
      model_id, cost, latency_ms, reasoning_content, inbound_meta, attachments,
      external_message_id, speaker, voice_session_id, task_id, run_id, root_kind, root_id,
      provenance, sent_at, created_at
    ) VALUES (
      @id, @agentId, @conversationId, @lane, @originIntent, @role, @content, @mood,
      @displayKind, @displayTier, @turnNumber, @groupId, @channel, @senderId, @authorized,
      @sourceAgentId, @a2aThreadId, @a2aIntent, @a2aRequiresResponse, @tokenCount,
      @modelId, @cost, @latencyMs, @reasoningContent, @inboundMeta, @attachments,
      @externalMessageId, @speaker, @voiceSessionId, @taskId, @runId, @rootKind, @rootId,
      'live', @sentAt, ${NOW_MS}
    )`;

function bind(m: NewMessage): { lane: Lane; id: string; displayKind: DisplayKind; displayTier: DisplayTier;
  tokenCount: number; sentAt: number; params: Record<string, unknown> } {
  const lane: Lane = m.lane ?? 'owner';
  const id = m.id ?? randomUUID();
  const prepared = prepareContent(m.role, m.content);
  // Classified from the row's OWN stamped facts — lane, role, origin_intent — plus the
  // display-ready content, so the kind describes what will actually be read.
  const display = classifyMessageForDisplay({
    role: m.role, content: prepared.content, lane, originIntent: m.originIntent ?? null,
  });
  const displayKind = m.displayKind ?? display.kind;
  const displayTier = m.displayTier ?? display.tier;
  // Estimated at WRITE, from the bytes actually stored — not the pre-strip ones, or every
  // budget arithmetic downstream would be counting characters the model never sees.
  // Never zero: a row that costs nothing to carry does not exist — that floor IS
  // `estimateStoredTokens`. No `m.tokenCount ??` escape any more (see the type above).
  const tokenCount = estimateStoredTokens(prepared.content);
  const sentAt = Date.now();
  const channel = m.channel ?? null;
  return {
    lane, id, displayKind, displayTier, tokenCount, sentAt,
    params: {
      id, agentId: m.agentId, conversationId: m.conversationId ?? null, lane,
      originIntent: m.originIntent ?? null, role: m.role, content: prepared.content,
      mood: m.mood ?? prepared.mood, displayKind, displayTier,
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
      rootKind: m.rootKind ?? null, rootId: m.rootId ?? null,
      sentAt,
    },
  };
}

// ── PHASE-2 T3: an inbound ask opens its TICKET in this same transaction ──
//
// The waiting set used to be "role='user' rows whose conv_key is still NULL"; it is now
// "open asks", and the row that makes an ask open is written HERE, beside the message, so
// there is no instant in which a person's question exists without its obligation.
//
// The gate below is the SAME gate the waiting set applied, on the same inputs — the four
// structural columns, then `deriveOrigin`'s authorized-human verdict — which is the whole
// safety argument for the cutover: the set of rows that opens a ticket is by construction
// the set the old predicate surfaced, so no ask starts appearing and none stops.
//
// It read `messages.authorized` NOWHERE, on purpose: that column and `deriveOrigin` were
// two mechanisms for one job (recorded at PHASE-1's exit, owned by SWEEP A), and switching
// to it there would have changed WHICH rows count inside a task with no mandate to.
// ⚠ THAT MANDATE ARRIVED — see the block below. SWEEP CORE-2 item 5 is the task, and the
// two mechanisms are now ONE: the producer's ingest stamp decides trust, and `deriveOrigin`
// decides everything else.

/** Is this row an authorized person asking this agent for something? */
function isOwnerAsk(m: NewMessage, storedContent: string): boolean {
  if (m.role !== 'user') return false;
  const lane: Lane = m.lane ?? 'owner';
  if (lane !== 'owner') return false;
  if (m.sourceAgentId || m.a2aThreadId) return false;
  // ── SWEEP CORE-2 item 5 (owner, ✅ DECIDED 2026-08-05, sharpened at the Phase-6 exit) ──
  //
  //   "Don't make the automatic ticket rule apply to unknown/ignored senders. That's
  //    literally what 'ignored' means."
  //
  // A message from a sender the platform is required to ignore is RECORDED and stamped (the
  // insert above already did both — audit visibility, nothing vanishes without a trace) and
  // files NO ticket. A row shaped as future-work-owed, where no work will ever be done, is a
  // lie in the work record.
  //
  // ── WHY THIS LINE AND NOT A SECOND CLASSIFIER (OR4: one authority) ──
  // `m.authorized` is the ingest stamp the PRODUCER decided and wrote in the SAME insert —
  // the iMessage bridge's `!!senderRecord`, Teams' `isDm && isSenderAuthorized(...)`, Gmail's
  // and Outlook's `isDirectToAgent`, SMS's `knownSender`, the Twilio voice route's literal
  // `false`. Nothing is re-derived here and nothing new is invented; the gate simply reads
  // the verdict that was already taken.
  //
  // ── THE CAUSE THIS CLOSES, MEASURED AT `e1108c7` ──
  // `deriveOrigin`'s structured trust input is `inbound_meta`, and every one of those five
  // producers writes `inbound_meta` with `recordInboundMeta()` — AFTER this insert. So at the
  // instant this gate runs the meta is ALWAYS absent, `deriveOrigin` falls through to its
  // legacy prose shim (branch 4, the `[SOURCE: IMESSAGE FROM …]` marker), and that branch
  // returns `authorized: true` unconditionally for anything that names a channel. On the
  // owner's own body that had filed 30 open stranger tickets, every one of which stood the
  // agent's self-wakes down for ever (TB2 §8.3's recorded confound, `ask:69f636ec`).
  //
  // REFUSAL: this is a NARROWING, never a new opinion. A row whose producer stamped nothing
  // (`authorized` absent) behaves exactly as before — `?? true` in `bind()` is the same
  // default the column has always taken — so the only rows that stop opening tickets are the
  // ones a producer has already declared unauthorized.
  if (m.authorized === false) return false;
  // ── PHASE-2 T6 (C7) — A PERSON'S MESSAGE NAMES THE DOOR IT CAME THROUGH. ──
  //
  // OR4 is the ruling this reads: "channel, sender, trust and lane are stamped at INGEST,
  // recorded on the message". A `role='user'` row on the owner lane with NO CHANNEL was
  // not written by an ingest path — it is the platform writing to itself in the second
  // person, and there are three such producers in this tree today:
  //     tracker/pm-agent.ts:1398   the PM's own "Tracker review -- N active tasks" report
  //     agent/v2/loop.ts (~:700)   the [ENGINE RENAME REQUEST] posted to the PM
  //     agent/spawner.ts:381       a spawned agent's kickoff instruction
  // Each opened an owner ask ticket that NOBODY CAN EVER SERVE OR CLOSE: no conversation
  // identity, so no delivery can match it, and the settlement authority cannot fire.
  //
  // MEASURED on this box before the change (READONLY), and this is the whole evidence:
  //     SELECT channel, sender_id IS NOT NULL, inbound_meta IS NOT NULL,
  //            conversation_id IS NOT NULL, state, count(*)
  //       FROM work w JOIN messages m ON m.id = w.root_id WHERE w.kind='ask' GROUP BY 1,2,3,4,5
  //   -> every genuine ask (dashboard 66, imessage 14, email 1) carries ALL FOUR;
  //      every stuck one (7 rows here, 55 tickets in total) carries NONE OF THEM.
  // The separation is total, and it is a STRUCTURAL column stamped at ingest, not a reading
  // of what the text says — which is the whole difference between this and the prose
  // classifiers T6 deleted.
  //
  // requirement preserved: the set of rows that opens a ticket is still exactly the set the
  // waiting set surfaces (T3's equivalence argument), because the waiting set JOINS the
  // ticket — narrowing here narrows both, in lockstep, by construction.
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

/** Would this row open an ask ticket? The ONE gate, asked from outside so the ingest door
 *  can resolve a title BEFORE it opens a transaction (T9). There is no second predicate:
 *  `persistAndMaybeOpenAsk` asks this same function inside the unit. */
export function wouldOpenAsk(m: NewMessage): boolean {
  return isOwnerAsk(m, prepareContent(m.role, m.content).content);
}

/** The stored row's own facts, then the ticket. Runs inside the caller's transaction. */
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
      // ── PHASE-5 T9 (decision D4) — THE TITLE IS NOT A COPY OF WHAT WAS TYPED ──
      //
      // It was `content.slice(0, 120)`: a cross-store copy of the owner's own words
      // onto board and broadcast surfaces with their own readers and their own
      // lifetime. Whatever he typed rode along, including a credential, and at this
      // seam no tool has been called so no `input_schema` has declared any field as
      // secret — there is nothing here to key on. So nothing is derived here at all.
      //
      // The title arrives already resolved (the system model, asked BEFORE this
      // transaction opened — `work/ask-title.ts`), and when it did not arrive the
      // ticket takes ITS OWN IDENTIFIER, which is derived from the message id and
      // carries nothing a person typed. `askIdForMessage` is the same function
      // `openAsk` mints the row's id with, so the id exists before the transaction
      // by construction and the two can never disagree.
      //
      // REFUSAL: this fallback is NEVER the 120-character slice. Re-introducing it
      // on the timeout path would re-open the hole on exactly the messages where the
      // model was too slow to help.
      title: m.askTitle ?? askIdForMessage(b.id),
    });
  }
  return row.created_at;
}

/** The ONE INSERT into `messages`. Every column the row needs is decided here.
 *  Throws on a duplicate id — use `insertMessageIfAbsent` where a colliding id is a
 *  legitimate, designed no-op (inbound de-duplication).
 *
 *  T3: the insert and the ask it may open are ONE transaction. If the ticket cannot be
 *  written the message does not land either, and the producer sees the failure — loudly
 *  losing a message is recoverable, storing one no agent can ever see is not. */
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
  return withUnit((): Persisted | null => {
    const info = db.prepare(`${INSERT_SQL} ON CONFLICT DO NOTHING`).run(b.params);
    // T3: a designed no-op writes NO ticket. One message, one obligation — a producer
    // retrying an inbound must not mint a second ask for the same question.
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

/** The WORK an engine row is about, as COLUMNS the serve boundary can read — until the P1
 *  lineage spine (migration 112) the task/run reference lived only as prose inside `content`.
 *
 *  It is REQUIRED, and `null` is a legal, deliberate answer: pass `null` for rows about no
 *  specific work (steers, awareness notices, floors), real ids for scheduler fires, assignment
 *  notices, and anything else whose premise a serve-boundary check must be able to retire when
 *  the referent is spent. Inherited verbatim from `memory/interagent.ts`, the shim T10 deleted:
 *  of everything that file carried, this was the one requirement the writer module did not
 *  already encode, and a shim's parameter is not where a requirement should live. Making it
 *  optional here would let a new engine writer forget its referent in silence, which is the
 *  state migration 112 exists to have ended. */
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

/** Idempotent twin of `insertEngineEvent`. */
export function insertEngineEventIfAbsent(e: EngineEventInput): Persisted | null {
  return insertMessageIfAbsent(engineRow(e));
}

// ── Turn boundary ──

/** Hand every unclaimed row for this agent to `turnNumber`, oldest first, and report what
 *  was claimed. Routing columns only — `content` is untouched (cache law). */
export function claimForTurn(agentId: string, turnNumber: number): StoredMessage[] {
  const db = getDb();
  const claim = (aid: string, turn: number): StoredMessage[] => withUnit((): StoredMessage[] => {
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
  withUnit(() => { for (const id of ids) stmt.run(turnNumber, id); });
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

/** What the broadcast seam needs off a row, plus the two fields it uses to make the
 *  emission agree with the row (`content`, and the time in the reload route's own text
 *  form). PHASE-1 T9. */
export interface PersistedSnapshot extends BroadcastRow {
  content: string;
  /** The identical projection the chat history route serves (`datetime(created_at/1000,
   *  'unixepoch')`), so live and reloaded rows carry the same characters. */
  createdAtText: string;
}

/**
 * Read one row as the broadcast seam sees it (PHASE-1 T9, research 17 §C4).
 *
 * This is the reader that makes "the broadcast carries the persisted row" true at ~70
 * emission sites without editing ~70 sites: `gateway/ws.ts` calls it for every
 * `chat:message` and stamps the answer onto the event. It lives HERE because this module
 * owns reads of `messages` that the platform vouches for, and because a null answer is
 * meaningful — it means an emission with no row, which is the defect the kit's
 * BROADCAST_EQUALS_ROW fails on.
 *
 * Deliberately NOT the `chat_messages` view: the seam must be able to report an a2a or
 * events row honestly (that is how the rekey is verifiable), and the view would return
 * nothing for them, which reads identically to "no row at all". Fail-closed belongs on the
 * SERVE path, not on the diagnostic that says what was stored.
 */
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
// THE TWO-TABLE DISPATCH IS GONE (T10, migration 133). Every statement below named its table
// through `home(src)`, where `src: LegacySrc` chose between `messages` and
// `inter_agent_messages` — the second store, which T3 could not rename (R5: renaming it killed
// every assembled turn, measured) and which T4/T5/T6 emptied of writers and readers. This file
// was the last place in the tree that knew two tables existed. The table is dropped, so the
// dispatch is dropped with it and the statements name `messages` directly.
//
// requirement preserved: a pre-T4 row's lifecycle columns stay reachable. There are none left
// to reach — migration 133 dropped the table they lived in, and before it did, all 34 call
// sites of the twelve functions below were enumerated and every one passes ONE argument, so
// the `'ia'` branch was unreachable from every caller in the tree.
//
// CACHE LAW (OR7): none of these touch `content` except `rewriteSystemPromptRow`, which
// is annotated at its own definition and predates this phase.
// ════════════════════════════════════════════════════════════════════════════════

// ── conversation IDENTITY (`conversation_id`) and the turn-serve edge ──
// PHASE-2 T10I: the identity writers below moved off `messages.conv_key` onto the FK. The
// claim machine that shared the column is already gone (T3/T4/T9 moved every claim onto the
// column that means it) and the sentinel writers went with the CLAIM half at T10H.
//
// PHASE-2 T3 SPLIT THIS COLUMN'S TWO JOBS. It carried the conversation's identity AND the
// owner ask's claim token, and the "is it NULL" test WAS the work queue. The OWNER-ASK
// claim is `work.state` now (work/store.ts). What is left here is the identity half —
// first-class per requirement 3l, read by conversation-scoped recall and the turn's own
// output tagging — plus the ENGINE-EVENT and PARK claims, which are different queues with
// their own owners this phase (T6/T9 for the engine retry lifecycle and its one reaper,
// T4 for the park machine).

/** Stamp a row's conversation IDENTITY by rowid — `conversations.id`, not a key string.
 *
 *  ── REKEY (PHASE-2 T10I). This was `setConvKeyByRowid`, and the value it wrote was a
 *  composite string built by `conversationKey()`. It writes the FK now, and the FK is
 *  resolved through `conversations`' own unique key by the ONE writer that owns that table.
 *  requirement preserved: THE TRIGGER ROW BELONGS TO THIS CONVERSATION whether or not this
 *  turn won the race to serve it — identity is stamped unconditionally, separately from the
 *  claim, which is exactly the separation requirement 3l asked for and the park machine
 *  violated.
 *
 *  Why it survives rather than dying with the column: a producer resolves the conversation at
 *  ingest and is best-effort by contract — a failure inserts NULL rather than blocking an
 *  inbound. This is the second chance, at pickup. Measured first: 66 owner-lane user rows on
 *  the dev box carry no `conversation_id`, all of them non-door inserts. */
export function stampConversationIdByRowid(
  p: { rowid: number; agentId?: string; conversationId: string | null },
): number {
  const db = getDb();
  const agent = p.agentId ? 'AND agent_id = @agentId' : '';
  return db.prepare(
    `UPDATE messages SET conversation_id = @value WHERE rowid = @rowid ${agent}`,
  ).run({ rowid: p.rowid, agentId: p.agentId ?? null, value: p.conversationId }).changes;
}

/** Tag this turn's OWN output rows with the conversation they served, so one
 *  counterparty's work cannot bleed into another's turn (content isolation, mig 076;
 *  rekeyed off `conv_key` onto `conversation_id` at PHASE-2 T10I).
 *
 *  ⚠ THE TWO PREDICATES BELOW ARE THE MECHANISM, NOT DECORATION, AND BOTH SURVIVED THE
 *  REKEY UNCHANGED IN MEANING:
 *
 *  `conversation_id IS NULL` — do not re-tag. An own-output row already carrying an id belongs
 *  to an EARLIER turn. It is also why this stamp is LATE rather than at insert: all three
 *  assembler scopers read NULL as "this turn's own work, keep it", so stamping at insert would
 *  make the live turn's own context look like a prior conversation's and be dropped.
 *
 *  `lane` — before T4 this UPDATE could only ever reach owner-lane rows, because the agent's
 *  a2a own output physically lived in `inter_agent_messages` and had its own tagger. T4 folded
 *  that output into `messages` as `lane='a2a'`, so without the predicate the human
 *  conversation's identity would start landing on coordination rows. The lane filter keeps it
 *  byte-identical. */
export function tagTurnOutputConversationId(
  p: { agentId: string; turnNumber: number; conversationId: string; lane?: Lane },
): number {
  const db = getDb();
  const laneClause = `AND lane = @lane`;
  return db.prepare(
    `UPDATE messages SET conversation_id = @conversationId
       WHERE agent_id = @agentId AND turn_number = @turnNumber
         AND role IN ('assistant','tool') AND conversation_id IS NULL ${laneClause}`,
  ).run({ agentId: p.agentId, turnNumber: p.turnNumber, conversationId: p.conversationId, lane: p.lane ?? 'owner' }).changes;
}

/** Record the TURN that served a row.
 *
 *  ── SHRINK (PHASE-2 T10I). This used to stamp the conversation identity here too
 *  (`SET conv_key = @convKey, served_by_turn = …`). It does not any more, and the reason is
 *  positive rather than tidy-up: its ONE caller is the settlement authority (SWEEP-A TB1;
 *  it was `claimAssembledSiblings` before), whose rows are
 *  sibling USER rows in the conversation being served — and a user row's `conversation_id` was
 *  already resolved by its own producer at ingest. Writing it again from the turn's side was a
 *  second writer for a fact that already had one, and on a lived-in body the two could
 *  disagree (the producer knows the mail THREAD; the turn only knows the sender).
 *  requirement preserved: the serve edge. `served_by_turn` is what the drain, the reaper and
 *  the answered edge read, and it is untouched.
 *
 *  T3's note, still true: there is no `conv_key IS NULL` guard here because the "may I take
 *  this?" question is asked and answered on the TICKET (`transition(… expectedState:'open')`)
 *  before this is reached. */
export function recordServingTurnByRowid(
  p: { agentId: string; rowid: number; servedByTurn?: number | null },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET served_by_turn = COALESCE(@servedByTurn, served_by_turn)
      WHERE agent_id = @agentId AND rowid = @rowid`,
  ).run({ ...p, servedByTurn: p.servedByTurn ?? null }).changes;
}

/**
 * Claim the assignment notice(s) for a task that has gone terminal — the LEGACY arm.
 *
 * ── PHASE-2 T8c item 1: DISPOSED, AND IT STAYS. This is the "assignment-notice retirement"
 * the conv-key inventory map named as T8's, and the honest verdict is KEEP-AND-SCOPE, not
 * remove. Evidence, measured this turn on two bodies rather than reasoned about:
 *
 *   this dev box   `SELECT count(*) FROM messages WHERE lane='events'
 *                    AND origin_intent='tracker' AND task_id IS NULL`      ->  0
 *   the owner's real backup (`~/.dojo-backup-20260726-135808/dojo.db`)
 *                  notices matching the assignment banner                  -> 185
 *                  ...of those with task_id IS NULL                        -> 185
 *                  ...of those STILL UNCLAIMED (conv_key IS NULL)          ->  14
 *
 * The dev box's zero is exactly the absence roadmap #15 forbids reading as death: on a
 * lived-in body every one of these rows predates migration 112, carries NO task_id, and
 * FOURTEEN are still pending. Deleting this arm would leave those fourteen un-retirable, and
 * an un-retired assignment notice is re-delivered as a fresh "begin working on this task"
 * prompt — the exact incident `claimAssignmentNoticeForTerminalTask` exists to prevent.
 *
 * What DID change: the arm is now scoped to `task_id IS NULL`, i.e. to the only rows the
 * KEYED retirement (`retireEngineEventsForTask` -> `sweepByReferent{referent:'task_id'}`)
 * structurally cannot reach. For a post-112 row the two arms were both claiming the same row
 * by different columns, which is one job with two owners; now the boundary is stated. The
 * effect on post-112 rows is nil — they are already excluded from
 * `DELIVERABLE_ENGINE_EVENT_WHERE` by the `swept_at` the keyed arm stamps.
 *
 * requirement preserved: a task that has gone terminal never re-delivers its assignment
 * notice, on either vintage of row. This arm retires when the Bridge's lived-in pre-112 rows
 * are gone — a T12/Bridge fact, not a Phase-2 one.
 */
export function claimTrackerNoticeForTask(
  p: { agentId: string; contentLike: string },
): number {
  const db = getDb();
  // ⚠ PHASE-2 T9 — THIS ARM HAD TO MOVE WITH THE PREDICATE, OR THE 14 WOULD COME BACK.
  // It retired a notice by writing the sentinel `conv_key='engine'`, which worked only
  // because eligibility asked `conv_key IS NULL`. T9 moved eligibility onto
  // `served_by_turn IS NULL`, so the sentinel would have stopped excluding anything and the
  // fourteen still-unclaimed pre-112 notices on the owner's real body would have become
  // re-deliverable "begin working on this task" prompts — the exact incident this function
  // exists to prevent, re-opened by a change three files away.
  // It now writes `swept_at`, which is what the KEYED arm (`sweepByReferent`) has always
  // written and what the eligibility predicate has always excluded: one retirement mechanism
  // instead of two, and no sentinel on the identity column.
  // requirement preserved: a task that has gone terminal never re-delivers its assignment
  // notice, on either vintage of row.
  return db.prepare(
    `UPDATE messages SET swept_at = ${NOW_MS}
       WHERE agent_id = @agentId AND lane = 'events' AND origin_intent = 'tracker'
         AND task_id IS NULL
         AND served_by_turn IS NULL AND swept_at IS NULL AND content LIKE @contentLike`,
  ).run(p).changes;
}

// ── Turn boundary ──

/** Mark one row served by a turn, addressed by rowid (the shape the claim path holds). */
export function markServedByRowid(rowid: number, turnNumber: number): number {
  const db = getDb();
  return db.prepare(`UPDATE messages SET served_by_turn = ? WHERE rowid = ?`)
    .run(turnNumber, rowid).changes;
}

/**
 * PHASE-2 T9 — the ENGINE EVENT's atomic pickup claim, on the serve edge.
 *
 * The compare-and-swap that used to be `setConvKeyByRowid({value:'engine', expect:null})`.
 * A `.changes` of 0 means another process already took this event, and the caller MUST read
 * it: running a second engine turn on one event delivers a reminder twice.
 *
 * ── WHY IT FIRES LATER THAN THE OLD ONE DID, SAID PLAINLY ──
 * The old CAS ran at engine-turn detection, ~155 lines before the turn number exists, because
 * it could write a constant. This one writes the turn's identity, so it can only run after
 * `startTurn`. Between the two points the loop does context assembly and no `await` on
 * another agent's behalf, and `activeRuns` already forbids a second turn for the same agent
 * IN THIS PROCESS — so the window this narrows is exactly the one the old code documented as
 * "single-process production never hits this (changes is always 1); guards stray dev
 * `tsx watch` processes on the one SQLite DB". The detection site keeps a cheap READ of the
 * same edge so the common stray-process case still bails before doing any work.
 */
export function claimEngineEventByRowid(
  p: { rowid: number; agentId: string; turnNumber: number },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET served_by_turn = @turnNumber
       WHERE rowid = @rowid AND agent_id = @agentId AND served_by_turn IS NULL`,
  ).run(p).changes;
}

/** Hand a claimed engine event back, idempotently. The `served_by_turn = @turnNumber` guard
 *  is what keeps it safe against a concurrent re-claim: only the turn that took it may
 *  return it. */
export function releaseEngineEventByRowid(
  p: { rowid: number; agentId: string; turnNumber: number },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET served_by_turn = NULL
       WHERE rowid = @rowid AND agent_id = @agentId AND served_by_turn = @turnNumber`,
  ).run(p).changes;
}

/** Is this row still unclaimed? The cheap pre-check the engine-turn detection uses before
 *  committing to a turn; the authoritative answer is `claimEngineEventByRowid`'s CAS. */
export function isRowUnserved(rowid: number, agentId: string): boolean {
  const db = getDb();
  const row = db.prepare('SELECT served_by_turn FROM messages WHERE rowid = ? AND agent_id = ?')
    .get(rowid, agentId) as { served_by_turn: number | null } | undefined;
  return row != null && row.served_by_turn == null;
}

/** Record which message answered the rows a turn served (the delivery receipt the
 *  "did I actually reply" probes read). Never overwrites an existing answer. */
export function setAnswerMessageId(
  p: { agentId: string; servedByTurn: number; answerMessageId: string },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET answer_message_id = @answerMessageId
       WHERE agent_id = @agentId AND served_by_turn = @servedByTurn AND answer_message_id IS NULL`,
  ).run(p).changes;
}

// ── Engine-event lifecycle (serve boundary, mig 099/112) ──

/** "Now", offset — `param` is a SQLite modifier this module's own callers supply
 *  ('+5 minutes'); it is never user input.
 *
 *  T10: this and its sibling `nowExpr` used to branch on the TARGET TABLE, because `messages`
 *  became epoch-ms INTEGER at migration 131 while `inter_agent_messages` stayed TEXT. One
 *  table, one representation — `nowExpr` collapsed into the `NOW_MS` constant it already
 *  delegated to. */
function nowPlusExpr(param: string): string {
  return `(CAST(strftime('%s','now', ${param}) AS INTEGER) * 1000)`;
}

/** Retire a queued engine event without serving it. `requireUnclaimed` is the serve
 *  boundary's guard: a row already claimed by a turn is not ours to sweep.
 *
 *  PHASE-2 T9: "claimed by a turn" is `served_by_turn`, not the `conv_key='engine'` sentinel.
 *  Same edge, same rows, one fewer job on the identity column — see
 *  `DELIVERABLE_ENGINE_EVENT_WHERE` in `agent/v2/counterparty.ts` for the full reasoning. */
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

/** Retire every unclaimed engine event pointing at one referent (a task or a run whose
 *  premise is spent). The referent column is a fixed enum, never caller SQL. */
export function sweepByReferent(
  p: { referent: 'task_id' | 'run_id'; id: string },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET swept_at = ${NOW_MS}
       WHERE ${p.referent} = ? AND served_by_turn IS NULL AND swept_at IS NULL`,
  ).run(p.id).changes;
}

/** Retire one row by its message id. */
export function sweepById(id: string): number {
  const db = getDb();
  return db.prepare(`UPDATE messages SET swept_at = ${NOW_MS} WHERE id = ?`)
    .run(id).changes;
}

/** Bookkeep a failed delivery: attempt counter + backoff window (mig 084). */
export function recordDeliveryAttempt(
  p: { agentId: string; rowid: number; attempts: number; backoffMinutes: number },
): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET delivery_attempts = @attempts,
        next_attempt_at = ${nowPlusExpr('@offset')}
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
 *  onto `lane` along with the rest of the eligibility predicates.
 *
 *  T6b: `newBoundary` is still the TEXT session boundary its five callers already compute
 *  and already write to `agents.session_started_at` — that column is not on the spine and
 *  does not convert, so the parameter's type is unchanged and no caller was touched. Both
 *  uses of it here cross into the converted column, so BOTH are wrapped. This is the one
 *  place in the module that WRITES `created_at` after the insert; the wrap is what stops it
 *  putting a datetime string into an INTEGER column, which the column's typeof CHECK would
 *  now reject outright — loudly, which is the point. */
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

// ── Row fields stamped after the insert ──

/** Stamp structured routing metadata onto an inbound row (OR4). Channel producers hold
 *  the id from their own insert. T4 also passes `channel`/`authorized`/`sender_id` INTO
 *  the insert, so this now records the full meta blob for the resolver rather than being
 *  the only carrier of the routing facts. */
export function stampInboundMeta(id: string, metaJson: string): number {
  const db = getDb();
  return db.prepare('UPDATE messages SET inbound_meta = ? WHERE id = ?').run(metaJson, id).changes;
}

/** Name the human who spoke a voice-session row. */
export function stampVoiceSpeaker(id: string, speaker: string, voiceSessionId: string | null): number {
  const db = getDb();
  return db.prepare(
    'UPDATE messages SET speaker = ?, voice_session_id = COALESCE(?, voice_session_id) WHERE id = ?',
  ).run(speaker, voiceSessionId, id).changes;
}

/** "This assistant row was spoken aloud." Was `source='voice'`; `channel` is where that fact
 *  lives now (T3-0b §3), and as of migration 129 it is the only place it lives. Routing
 *  columns only, so no historical prompt byte moves and the cache prefix is untouched. */
export function markSpokenAloud(id: string): number {
  const db = getDb();
  return db.prepare(
    `UPDATE messages SET channel = 'voice'
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
export function deleteAllForAgent(agentId: string): number {
  const db = getDb();
  return db.prepare(`DELETE FROM messages WHERE agent_id = ?`).run(agentId).changes;
}

/** Everything older than a cutoff row, for the PM's bounded scratch history. Deletes the
 *  dependent summary rows first, in one transaction, exactly as the call site did.
 *
 *  PHASE-1 T7: migration 130 gave `summary_messages.message_id` its foreign key back with
 *  ON DELETE CASCADE, so the database now guarantees this ordering for every delete path,
 *  not just the two that remembered to. The explicit delete STAYS anyway, and not as
 *  belt-and-braces duplication: FK enforcement is a per-connection PRAGMA, and it is OFF
 *  for the whole migration chain (see runSqlMigrations) — a delete performed from a
 *  migration would otherwise leave the links behind. Same statement, two conditions
 *  covered. */
export function deleteForAgentBefore(agentId: string, cutoffId: string): number {
  const db = getDb();
  const txn = (aid: string, cid: string): number => withUnit((): number => {
    db.prepare(`
      DELETE FROM summary_messages
      WHERE message_id IN (
        SELECT id FROM messages WHERE agent_id = ? AND seq < (SELECT seq FROM messages WHERE id = ?)
      )
    `).run(aid, cid);
    return db.prepare(
      'DELETE FROM messages WHERE agent_id = ? AND seq < (SELECT seq FROM messages WHERE id = ?)',
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
