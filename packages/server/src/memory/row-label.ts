// ════════════════════════════════════════════════════════════════════════════════════════
// THE ROW LABEL (t141) — every row the model reads says WHEN, and WHICH conversation it is.
//
// The owner, on tracker #12: "Why can't it just recognize that the email is from a different
// conversation and not get it conflated with other conversations?" / "The agent just needs to
// be aware of what conversations are what and not confuse them." (OR-LABEL-NOT-HIDE.) So the
// fix is a LABEL on each row, never a narrower view: the stamp the fresh tail already prefixed
// (`[Jul 16, 2026, 11:41 AM]`) grows the row's subject — `[<instant> · <subject>]`.
//
// ── CACHE LAW (OR7 / G2): THE LABEL IS A PURE FUNCTION OF THE ROW ──
// It is derived from stored columns only — the row's own `conversation_id`, `a2a_thread_id`,
// `subject_kind` (written ONCE, at insert), `inbound_meta`, and the `conversations` row it
// points at — never from which turn is rendering it and never from the clock. The same row
// therefore renders the same bytes on every turn of every kind: an email wake and the owner's
// next turn share their prefix instead of each re-billing it. Nothing here is relative
// ("2 minutes ago" would move every turn), and nothing depends on the turn's subject.
//
// ── WHAT IS LABELLED ──
// Text rows (user and assistant) and the agent's tool CALLS. A tool RESULT is not: it is bound
// to its call by id and sits immediately after it, and putting text into a `tool_result`
// message is the shape some providers reject. The call carries the label for the pair.
// ════════════════════════════════════════════════════════════════════════════════════════
import type { Message } from '@dojo/shared';
import { getDb } from '../db/connection.js';
import { getOwnerName } from '../config/platform.js';
import { turnContext as liveTurnContext } from '../agent/turn-context.js';
import type { PromptTurnContext } from '../prompt/assembler.js';
import { renderMessageTimeStamp } from './message-stamp.js';
import { subjectKindsBySeq, type SubjectKind } from './message-store.js';

/** A tail row as the assembler holds it once its label column has been read beside it. */
export type LabelledMessage = Message & { subjectKind?: SubjectKind | null };

/**
 * What an OWN row belongs to. A row read without its label column (a hand-built fixture, a
 * writer that bypassed `message-store.ts`) is judged by its stamp — exactly the old reading of
 * a stamped row — so no shape of input changes which rows a scoper keeps.
 */
export function subjectOf(m: LabelledMessage): SubjectKind | null {
  return m.subjectKind ?? (m.conversationId ? 'conv' : null);
}

const CHANNEL_PHRASE: Record<string, string> = {
  dashboard: 'dashboard conversation', voice: 'voice conversation', imessage: 'iMessage conversation',
  email: 'email thread', teams: 'Teams chat', sms: 'SMS conversation', phone: 'phone call',
};

function emailSubjectOf(inboundMeta: string | null | undefined): string | null {
  if (!inboundMeta) return null;
  try {
    const s = (JSON.parse(inboundMeta) as { emailSubject?: unknown }).emailSubject;
    return typeof s === 'string' && s.trim() ? s.trim().slice(0, 120) : null;
  } catch { return null; }
}

/** Per-assembly lookups, cached: one PK read per conversation and per thread, not per row. */
export class LabelFacts {
  private readonly convs = new Map<string, string | null>();
  private readonly threads = new Map<string, string>();
  constructor(private readonly agentId: string, private readonly rows: Message[]) {}

  /** "dashboard conversation with <owner>", "email thread with x@y, subject "…"" — or null. */
  conversation(conversationId: string): string | null {
    if (this.convs.has(conversationId)) return this.convs.get(conversationId) ?? null;
    let label: string | null = null;
    try {
      const db = getDb();
      const c = db.prepare('SELECT channel, counterparty_id, counterparty_name FROM conversations WHERE id = ?')
        .get(conversationId) as { channel: string; counterparty_id: string | null; counterparty_name: string | null } | undefined;
      if (c) {
        const who = c.counterparty_id === 'owner' ? getOwnerName() : (c.counterparty_name ?? c.counterparty_id ?? 'someone');
        label = `${CHANNEL_PHRASE[c.channel] ?? `${c.channel} conversation`} with ${who}`;
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

  /** "agent thread 1a2b3c4d with <peer>". The peer is read off the thread's inbound row. */
  thread(threadId: string | null | undefined): string {
    if (!threadId) return 'agent-to-agent work (thread not recorded)';
    const hit = this.threads.get(threadId);
    if (hit) return hit;
    let peer = this.rows.find((r) => r.a2aThreadId === threadId && r.origin?.kind === 'agent')?.origin?.senderName ?? null;
    if (!peer) {
      try {
        peer = (getDb().prepare(`SELECT a.name FROM messages m JOIN agents a ON a.id = m.source_agent_id
                                   WHERE m.agent_id = ? AND m.a2a_thread_id = ? ORDER BY m.seq DESC LIMIT 1`)
          .get(this.agentId, threadId) as { name: string } | undefined)?.name ?? null;
      } catch { /* best-effort */ }
    }
    const label = `agent thread ${threadId.slice(0, 8)} with ${peer ?? 'another agent'}`;
    this.threads.set(threadId, label);
    return label;
  }
}

/** The subject half of a row's label. Never null: a row with nothing on record says so. */
export function rowSubject(m: LabelledMessage, facts: LabelFacts): string {
  const o = m.origin;
  if (m.role === 'user') {
    if (o?.kind === 'agent') return facts.thread(m.a2aThreadId ?? o.threadId);
    if (o?.kind === 'engine') return `engine event${o.intent ? `: ${o.intent}` : ''}`;
    const subj = emailSubjectOf(m.inboundMeta);
    if (o?.kind === 'user' && o.authorized === false) {
      // A notice addressed to the owner's inbox: never a conversation the agent is in.
      return `${o.channel ?? 'channel'} notice from ${o.senderName ?? 'an unknown sender'} (not addressed to you)`
        + (subj ? `, subject "${subj}"` : '');
    }
    const conv = m.conversationId ? facts.conversation(m.conversationId) : null;
    if (conv) return conv;
    if (o?.relation === 'owner') return `dashboard conversation with ${getOwnerName()}`;
    return `${o?.channel ?? 'a'} conversation with ${o?.senderName ?? 'someone'}${subj ? `, subject "${subj}"` : ''}`;
  }
  switch (subjectOf(m)) {
    case 'conv': return (m.conversationId && facts.conversation(m.conversationId)) || 'a person\'s conversation (record missing)';
    case 'legacy': return `${(m.conversationId && facts.conversation(m.conversationId)) || 'a person\'s conversation'} (earlier work, labelled after the fact)`;
    case 'a2a_thread': return facts.thread(m.a2aThreadId);
    case 'engine_event': return 'engine event (a scheduled task, reminder or system notice)';
    case 'background': return 'background wake — not part of any conversation';
    default: return 'earlier work, subject not recorded';
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

/**
 * Every renderable row's label, in render order — ONE HEADER PER CONVERSATION BLOCK. The first
 * row of a run with one subject carries `[<instant> · <subject>]`; the rows after it carry the
 * instant alone (the stamp they always had), so a subject change is read wherever one happens
 * and paid for once per block. A tool CALL carries a header only when it opens a block; a tool
 * RESULT never does. Append-only: a row's label reads only rows BEFORE it.
 */
export function labelRows(agentId: string, rows: Message[]): Map<string, string> {
  const labelled: LabelledMessage[] = rows.some((m) => (m as LabelledMessage).subjectKind === undefined)
    ? withSubjectKinds(agentId, rows) : rows;
  const facts = new LabelFacts(agentId, labelled);
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

/**
 * The conversation a turn's tail is scoped to: the one a person's turn serves. An EMAIL WAKE
 * serves none and used to hand `null` to the scoper, which kept the owner's asks and dropped
 * every answer already given him (the identity audit's RC2). Its counterparty IS the owner on
 * the dashboard, so its view is that conversation WHOLE, asks and answers, each row labelled.
 */
export function servedConversationId(agentId: string, turnContext: PromptTurnContext | undefined): string | null {
  const live = liveTurnContext(agentId)?.conversationId ?? null;
  if (live || !turnContext?.isNotificationTurn) return live;
  try {
    return (getDb().prepare(`SELECT id FROM conversations WHERE agent_id = ? AND channel = 'dashboard'
                               AND provider IS NULL AND counterparty_id = 'owner' AND thread_root IS NULL LIMIT 1`)
      .get(agentId) as { id: string } | undefined)?.id ?? null;
  } catch { return null; }
}

/**
 * EVENTS' HANDLED status: the first row the agent's last FINISHED notice-viewing turn (a
 * person's or a background wake; engine/agent-thread turns never show EVENTS) wrote. A notice
 * before it was in that turn's view, so it has been dealt with. Ordered on the INSERTION
 * SEQUENCE, never the clock — a notice and the wake it causes share a second. A turn that wrote
 * nothing cannot be placed and leaves its notices NEW (the safe direction). No new column.
 */
export function lastFinishedViewingTurnFirstSeq(agentId: string): number | null {
  try {
    const row = getDb().prepare(
      `SELECT MIN(m.seq) AS seq FROM messages m
        WHERE m.agent_id = @a AND m.role IN ('assistant','tool') AND m.turn_number = (
          SELECT t.turn_number FROM turns t
           WHERE t.agent_id = @a AND t.ended_at IS NOT NULL AND (t.kind IS NULL OR t.kind = 'user')
             AND EXISTS (SELECT 1 FROM messages x WHERE x.agent_id = @a AND x.turn_number = t.turn_number
                           AND x.role IN ('assistant','tool'))
           ORDER BY t.turn_number DESC LIMIT 1)`,
    ).get({ a: agentId }) as { seq: number | null } | undefined;
    return row?.seq ?? null;
  } catch { return null; }
}

/**
 * Who an EVENTS item is addressed to, and from whom — read off its stored fields only. A notice
 * about the owner's mail/channels is TO THE OWNER (the agent is not in that conversation); an
 * engine-lane item is TO the agent itself, from another agent when the row names one (a PM
 * review, say) or from the platform. So a notice for the owner is never read as one for the
 * agent, or the reverse. Bounded: channel 24, sender 64, intent 32 chars.
 */
export function eventAddressee(m: Message): string {
  const o = m.origin;
  if (o?.kind === 'user') {
    return `${(o.channel ?? 'channel').slice(0, 24)} notice TO THE OWNER, from ${(o.senderName ?? 'an unknown sender').slice(0, 64)}`;
  }
  let from = 'the platform';
  if (m.sourceAgentId) {
    try {
      from = (getDb().prepare('SELECT name FROM agents WHERE id = ?').get(m.sourceAgentId) as { name: string } | undefined)?.name
        ?? 'another agent';
    } catch { from = 'another agent'; }
  }
  return `TO YOU, from ${from.slice(0, 64)}${o?.intent ? `: ${o.intent.slice(0, 32)}` : ''}`;
}
