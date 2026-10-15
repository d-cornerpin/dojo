// ════════════════════════════════════════════════════════════════════════════════════════
// THE ROW LABEL (t141) — every row the model reads says WHEN, and WHICH conversation it is.
// The owner, tracker #12: "The agent just needs to be aware of what conversations are what and
// not confuse them." (OR-LABEL-NOT-HIDE) — a LABEL on each row, never a narrower view.
//
// CACHE LAW (OR7 / G2): a pure function of STORED columns — the row's own conversation, thread,
// insert-time `subject_kind`, `inbound_meta`, root, turn record — never of the turn rendering it
// or the clock, so an email wake and the owner's next turn render shared rows identically.
// Labelled: text rows and tool CALLS; a tool RESULT is bound to its call by id and stays bare.
// ════════════════════════════════════════════════════════════════════════════════════════
import type { Message } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { getOwnerName } from '../config/platform.js';
import { turnContext as liveTurnContext } from '../agent/turn-context.js';
import type { PromptTurnContext } from '../prompt/assembler.js';
import { renderInstant, renderMessageTimeStamp } from './message-stamp.js';
import { subjectKindsBySeq, type SubjectKind } from './message-store.js';

/** A tail row as the assembler holds it once its label column has been read beside it. */
export type LabelledMessage = Message & { subjectKind?: SubjectKind | null };

/** What an OWN row belongs to; a row read without its label (a fixture, a bypassing writer) is
 *  judged by its stamp — the old reading — so no input shape changes which rows a scoper keeps. */
export function subjectOf(m: LabelledMessage): SubjectKind | null {
  return m.subjectKind ?? (m.conversationId ? 'conv' : null);
}

const CHANNEL_PHRASE: Record<string, string> = {
  dashboard: 'dashboard conversation', voice: 'voice conversation', imessage: 'iMessage conversation',
  email: 'email thread', teams: 'Teams chat', sms: 'SMS conversation', phone: 'phone call',
};

/** Outside text inside a label is INERT: whatever a subject, a name or a request says, it can never
 *  end the label, open another, add a quote, or break the line (re-review N-1). The one neutraliser:
 *  every value from a message, a remote party or a setting passes it before a label carries it. */
export function labelText(raw: unknown, cap: number): string {
  const s = String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\[/g, '(').replace(/\]/g, ')').replace(/"/g, "'");
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

function emailSubjectOf(inboundMeta: string | null | undefined): string | null {
  if (!inboundMeta) return null;
  try {
    const s = (JSON.parse(inboundMeta) as { emailSubject?: unknown }).emailSubject;
    return typeof s === 'string' && s.trim() ? labelText(s, 120) : null;
  } catch { return null; }
}

/** A thread's FIRST other-agent sender. `+m.agent_id` keeps the planner on ix_msg_a2a_thread_seq (188)
 *  — a key lookup — instead of an agent-wide scan (re-review m-c; EXPLAIN pinned in a test). */
export const THREAD_PEER_SQL = `SELECT a.name FROM messages m JOIN agents a ON a.id = m.source_agent_id
  WHERE m.a2a_thread_id = ? AND +m.agent_id = ? AND m.source_agent_id <> m.agent_id ORDER BY m.seq ASC LIMIT 1`;

/** Per-assembly lookups, cached: one keyed read per conversation / thread / turn / request.
 *  Every one reads the STORE, never the tail in hand, so a label is a function of the row. */
export class LabelFacts {
  private readonly convs = new Map<string, string | null>();
  private readonly threads = new Map<string, string>();
  private readonly wakes = new Map<number, string | null>();
  constructor(private readonly agentId: string) {}

  /** "dashboard conversation with <owner>", "email thread with x@y, subject "…"" — or null. */
  conversation(conversationId: string): string | null {
    if (this.convs.has(conversationId)) return this.convs.get(conversationId) ?? null;
    let label: string | null = null;
    try {
      const db = getDb();
      const c = db.prepare('SELECT channel, counterparty_id, counterparty_name FROM conversations WHERE id = ?')
        .get(conversationId) as { channel: string; counterparty_id: string | null; counterparty_name: string | null } | undefined;
      if (c) {
        const who = labelText(c.counterparty_id === 'owner' ? getOwnerName() : (c.counterparty_name ?? c.counterparty_id ?? 'someone'), 64);
        label = `${CHANNEL_PHRASE[c.channel] ?? `${labelText(c.channel, 24)} conversation`} with ${who}`;
        if (c.channel === 'email') {
          // A mail thread is named by its subject — the one thing that tells two threads from
          // one sender apart. Read off the thread's FIRST inbound row, which never changes.
          const first = db.prepare(`SELECT inbound_meta FROM messages WHERE conversation_id = ? AND role = 'user'
                                      AND inbound_meta IS NOT NULL ORDER BY seq ASC LIMIT 1`).get(conversationId) as
            { inbound_meta: string } | undefined;
          const subj = emailSubjectOf(first?.inbound_meta);
          if (subj) label += `, subject "${subj}"`;
        }
      }
    } catch { /* a label is best-effort; the row still renders with its instant */ }
    this.convs.set(conversationId, label);
    return label;
  }

  /** "agent thread 1a2b3c4d with <peer>". The peer is the thread's FIRST other-agent sender —
   *  its stable identity: a later poster never renames the rows before it (review m-3). */
  thread(threadId: string | null | undefined): string {
    if (!threadId) return 'agent-to-agent work (thread not recorded)';
    const hit = this.threads.get(threadId);
    if (hit) return hit;
    let peer: string | null = null;
    try {
      peer = (getDb().prepare(THREAD_PEER_SQL).get(threadId, this.agentId) as { name: string } | undefined)?.name ?? null;
    } catch { /* best-effort */ }
    const label = `agent thread ${labelText(threadId.slice(0, 8), 8)} with ${labelText(peer ?? 'another agent', 64)}`;
    this.threads.set(threadId, label);
    return label;
  }

  /** The notice a wake turn was woken by (its turn record's trigger, written at turn start), as
   *  "the email notice from x, subject "…"" — or null when the turn recorded none. */
  wakeNotice(turnNumber: number | null | undefined): string | null {
    if (turnNumber == null) return null;
    if (this.wakes.has(turnNumber)) return this.wakes.get(turnNumber) ?? null;
    let label: string | null = null;
    try {
      const n = getDb().prepare(`SELECT n.channel, n.sender_id, n.inbound_meta FROM turns t JOIN messages n ON n.id = t.source_message_id
                                   WHERE t.agent_id = ? AND t.turn_number = ?`).get(this.agentId, turnNumber) as
        { channel: string | null; sender_id: string | null; inbound_meta: string | null } | undefined;
      if (n) {
        const subj = emailSubjectOf(n.inbound_meta);
        label = `the ${labelText(n.channel ?? 'channel', 24)} notice from ${labelText(n.sender_id ?? 'an unknown sender', 64)}${subj ? `, subject "${subj}"` : ''}`;
      }
    } catch { /* best-effort */ }
    this.wakes.set(turnNumber, label);
    return label;
  }

  /** The request a delivered result answers, by instant + first words (two in a minute differ). */
  requestInstant(resultMessageId: string): string | null {
    try {
      const r = getDb().prepare(`SELECT r.created_at, r.content FROM messages m JOIN messages r ON r.id = m.root_id
                                   WHERE m.id = ?`).get(resultMessageId) as { created_at: number; content: string } | undefined;
      if (!r) return null;
      return `${renderInstant(r.created_at)}: "${labelText(r.content, 60)}"`;
    } catch { return null; }
  }
}

/** The subject half of a row's label. Never null: a row with nothing on record says so. */
export function rowSubject(m: LabelledMessage, facts: LabelFacts): string {
  const o = m.origin;
  if (m.role === 'user') {
    if (o?.kind === 'agent') return facts.thread(m.a2aThreadId ?? o.threadId);
    if (o?.kind === 'engine') return `engine event${o.intent ? `: ${labelText(o.intent, 32)}` : ''}`;
    const subj = emailSubjectOf(m.inboundMeta);
    if (o?.kind === 'user' && o.authorized === false) {
      // A notice addressed to the owner's inbox: never a conversation the agent is in.
      return `${labelText(o.channel ?? 'channel', 24)} notice from ${labelText(o.senderName ?? 'an unknown sender', 64)} (not addressed to you)`
        + (subj ? `, subject "${subj}"` : '');
    }
    const conv = m.conversationId ? facts.conversation(m.conversationId) : null;
    if (conv) return conv;
    if (o?.relation === 'owner') return `dashboard conversation with ${labelText(getOwnerName(), 64)}`;
    return `${labelText(o?.channel ?? 'a', 24)} conversation with ${labelText(o?.senderName ?? 'someone', 64)}${subj ? `, subject "${subj}"` : ''}`;
  }
  switch (subjectOf(m)) {
    case 'conv': return (m.conversationId && facts.conversation(m.conversationId)) || 'a person\'s conversation (record missing)';
    case 'legacy': return `${(m.conversationId && facts.conversation(m.conversationId)) || 'a person\'s conversation'} (earlier work, labelled after the fact)`;
    case 'a2a_thread': return facts.thread(m.a2aThreadId);
    case 'engine_event': return 'engine event (a scheduled task, reminder or system notice)';
    case 'background': {
      const notice = facts.wakeNotice(m.turnNumber);
      return notice ? `work on ${notice} — not part of any conversation` : 'background wake — not part of any conversation';
    }
    case 'delivered': {
      const where = (m.conversationId && facts.conversation(m.conversationId)) || 'no conversation recorded';
      const asked = facts.requestInstant(m.id);
      return `${where} — result delivered later${asked ? `, for the request of ${asked}` : ''}`;
    }
    default: return 'subject not recorded';
  }
}

/** `[<instant> · <subject>]` — the one stamp every labelled row carries. */
export function renderRowLabel(m: LabelledMessage, facts: LabelFacts): string {
  const at = renderMessageTimeStamp(m.createdAt);
  const subject = rowSubject(m, facts);
  return at ? `${at.slice(0, -1)} · ${subject}]` : `[${subject}]`;
}

/** The tail's rows with their insert-time label read beside them (one indexed query). */
export function withSubjectKinds(agentId: string, rows: Message[]): LabelledMessage[] {
  const kinds = subjectKindsBySeq(agentId, rows.map((m) => m.rowid).filter((n): n is number => typeof n === 'number'));
  return rows.map((m) => (m.rowid != null && kinds.has(m.rowid) ? { ...m, subjectKind: kinds.get(m.rowid) ?? null } : m));
}

/** Labels in render order — ONE HEADER PER CONVERSATION BLOCK: a block's first row carries
 *  `[<instant> · <subject>]`, the rest `[<instant>]`; a tool CALL only when it opens a block.
 *  Append-only: a row's label reads only rows BEFORE it. */
export function labelRows(agentId: string, rows: Message[]): Map<string, string> {
  const labelled: LabelledMessage[] = rows.some((m) => (m as LabelledMessage).subjectKind === undefined)
    ? withSubjectKinds(agentId, rows) : rows;
  const facts = new LabelFacts(agentId);
  const out = new Map<string, string>();
  let current: string | null = null;
  for (const m of labelled) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const subject = rowSubject(m, facts);
    const isToolCall = m.role === 'assistant' && typeof m.content === 'string' && m.content.trimStart().startsWith('[{');
    if (subject !== current) {
      out.set(m.id, renderRowLabel(m, facts));
      current = subject;
    } else if (!isToolCall) {
      const at = renderMessageTimeStamp(m.createdAt);
      if (at) out.set(m.id, at);
    }
  }
  return out;
}

/** The conversation a turn's tail is scoped to. An EMAIL WAKE serves none and used to hand `null`,
 *  keeping the owner's asks and dropping his answers (audit RC2); its counterparty IS the owner on
 *  the dashboard, so it sees that conversation WHOLE, each row labelled. */
export function servedConversationId(agentId: string, turnContext: PromptTurnContext | undefined): string | null {
  const live = liveTurnContext(agentId)?.conversationId ?? null;
  if (live || !turnContext?.isNotificationTurn) return live;
  try {
    return (getDb().prepare(`SELECT id FROM conversations WHERE agent_id = ? AND channel = 'dashboard'
                               AND provider IS NULL AND counterparty_id = 'owner' AND thread_root IS NULL LIMIT 1`)
      .get(agentId) as { id: string } | undefined)?.id ?? null;
  } catch { return null; }
}

/** EVENTS' HANDLED line: the trigger (`seq`) of the last finished turn that SHOWS EVENTS and whose
 *  model actually RAN on that view — it answered, declined, or wrote its own rows; a turn that died
 *  before assembly or whose calls all failed saw nothing (re-review N-2). A notice at or before the
 *  trigger was in that view; one landing mid-turn stays NEW. Sequence, never the clock. */
export function lastViewedTriggerSeq(agentId: string): number | null {
  try {
    const row = getDb().prepare(
      `SELECT m.seq FROM turns t JOIN messages m ON m.id = t.source_message_id
        WHERE t.agent_id = ? AND t.ended_at IS NOT NULL AND (t.kind IS NULL OR t.kind = 'user')
          AND (t.exit_reason IN ('answered', 'no_reply_intended') OR EXISTS (SELECT 1 FROM messages o
                 WHERE o.agent_id = t.agent_id AND o.turn_number = t.turn_number AND o.role IN ('assistant', 'tool')))
        ORDER BY t.turn_number DESC LIMIT 1`,
    ).get(agentId) as { seq: number } | undefined;
    return row?.seq ?? null;
  } catch { return null; }
}

/** Who an EVENTS item is addressed to and from whom, off stored fields: a mail/channel notice is
 *  TO THE OWNER; an engine-lane item is TO the agent, from the agent the row names (a PM review)
 *  or the platform. Bounded: channel 24, sender 64, intent 32 chars. */
export function eventAddressee(m: Message): string {
  const o = m.origin;
  if (o?.kind === 'user') {
    return `${labelText(o.channel ?? 'channel', 24)} notice TO THE OWNER, from ${labelText(o.senderName ?? 'an unknown sender', 64)}`;
  }
  let from = 'the platform';
  if (m.sourceAgentId) {
    try {
      from = (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(m.sourceAgentId) as { name: string } | undefined)?.name
        ?? 'another agent';
    } catch { from = 'another agent'; }
  }
  return `TO YOU, from ${labelText(from, 64)}${o?.intent ? `: ${labelText(o.intent, 32)}` : ''}`;
}
