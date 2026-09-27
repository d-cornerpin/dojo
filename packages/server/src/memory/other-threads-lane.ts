// ════════════════════════════════════════════════════════════════════════════════════════
// THE OTHER-THREADS LANE — the engine says out loud that it stripped something.
//
// ── THE INCIDENT (the owner, 2026-09-24; `conversation-identity-investigation.md` HEAD 2) ────
// An agent held two conversation silos for the SAME PERSON. Asked from one about the other, it
// replied that it had no way to see the other thread. It had every way: the inbound was live, the
// rows were in its own database, and `history_search` is agent-scoped and unscoped by conversation.
// It eventually ran `history_get` and answered correctly — so the recovery path existed, was
// reachable, and worked. THE DEFECT IS ENTIRELY THAT NOTHING PROMPTED IT.
//
// ── THE NAMED MECHANISM: SILENT CONVERSATION-SCOPED ELISION WITH NO CAPABILITY DECLARATION ───
// On a human turn every default-path surface is filtered to the one conversation being served —
// the fresh tail's inbound half and own-output half (`memory/assembler.ts`), the deliveries ledger
// (`memory/deliveries-lane.ts`), the active-directive lane (`memory/directive.ts`), and
// `recall_recent_thread`'s default scope (`memory/recall.ts`). Every one of those filters is
// CORRECT and each has a named incident behind it — a friend's iMessage bleeding into a dashboard
// turn, and a months-long re-answer ghost. They are not bugs. THEY ARE SILENT.
//
// So the model's only in-context evidence about its own reach is the ABSENCE OF ROWS, and absence
// reads as incapability. That is the W84 shape one surface over
// (`memory/integration-status-lane.ts`: *"The tool did not fail — it LIED, in a confident
// sentence… A false memory about a connection is self-sealing."*), and the lane built to cure W84
// did not cover channels at all. A headwind made it worse: the iMessage framing injects *"Respond
// to THIS topic only; do not pull in unrelated dashboard conversation context."* Correct for topic
// hygiene, and a direct push away from "go look at your other threads."
//
// ── WHAT THIS LANE IS, AND THE TWO PRECEDENTS IT IS BUILT ON ─────────────────────────────────
// It publishes the STRIP: the agent's other live human threads, by CHANNEL and PARTY and RECENCY,
// plus the channels inbound is live on, plus the one sentence naming the unscoped tool. Both
// precedents were already ruled on in this codebase:
//
//   · `work/obligations.ts` — current conversation first, then ≤3 from OTHER conversations, each
//     tagged `[other conversation]`, each party-labelled, and the elision NEVER SILENT
//     (*"… and N more open items not shown"*). This lane's row shape and its tail are that shape.
//   · `memory/integration-status-lane.ts` — a post-budget TAIL lane carrying LIVE PLATFORM TRUTH
//     under an explicit supersession preamble. This lane's framing is that framing.
//
// ⚠ NO MESSAGE CONTENT. NOT ONE BYTE. This is the line that keeps the lane from re-introducing the
// two incidents the filters exist to prevent: a party label, a channel, an instant, and whether the
// thread is waiting. If the model wants what was SAID it must call the tool, which is the whole
// point — the lane's job is to make the tool call occur to it, not to do the tool's job. A lane
// that quoted the other thread would be the friend-on-iMessage bleed with extra steps.
//
// ⚠ CACHE-PREFIX LAW. This is a POST-BUDGET TAIL lane, pushed after `volatileFrom` beside
// `engine.open-work` and `engine.report-state`. Its content moves whenever any other thread moves,
// so it may never sit in the cached prefix; `the-tail-holds-still.test.ts` and the cache-prefix
// golden are the instruments, and the assembled prefix must be byte-identical with this lane
// present and absent.
//
// ── EMPTY MEANS ABSENT ───────────────────────────────────────────────────────────────────────
// An agent with one thread and nothing else live emits NOTHING — no header, no "you have no other
// threads" line. A block that fires on every turn to say nothing is the tax that gets lanes deleted,
// and the negative claim is not even useful: "no other threads" is what the model already infers
// from absence. The lane exists to contradict that inference when it is WRONG.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { conversationLabel } from './party-label.js';
import { recordedInstant } from './message-stamp.js';
import { listChannelStatuses } from '../services/capability-registry.js';
import { toolCategoryGranted } from '../agent/access/read.js';

const logger = createLogger('other-threads-lane');

/** How far back a thread counts as LIVE. Seven days, the same window the report-state lane uses
 *  for the same reason: a thread nobody has touched in a week is history, not a live silo. */
export const OTHER_THREADS_WINDOW_DAYS = 7;
/** Rows printed. `work/obligations.ts` chose 3 for its cross-conversation overflow; this is the
 *  same decision on the same surface, with the same non-silent tail when more exist. */
export const OTHER_THREADS_MAX_ROWS = 3;
/** Hard ceiling on the read, so a body with hundreds of threads cannot make this scan expensive. */
export const OTHER_THREADS_READ_CAP = 40;

export interface OtherThread {
  conversationId: string;
  /** `conversationLabel`'s output: "a contact (imessage)", the owner's name, "an agent thread". */
  label: string;
  channel: string;
  /** Epoch ms of the newest message either way in that thread. */
  lastAtMs: number;
  /** True when the newest row is INBOUND — they spoke last, so the thread may be waiting. */
  theySpokeLast: boolean;
}

export interface OtherThreadsRead {
  rows: OtherThread[];
  /** Threads inside the window beyond `OTHER_THREADS_MAX_ROWS`. Printed, never swallowed. */
  hidden: number;
  /** Channels the platform receives on right now, for the capability half. */
  channels: Array<{ displayName: string; inboundLive: boolean }>;
  /** The route sentence, composed from the tools this agent can actually call. */
  route: string;
}

/**
 * The agent's OTHER live human threads, newest first.
 *
 * Excludes: the conversation being served (that is the fresh tail's job), `a2a` peer threads (agent
 * coordination is not a person waiting, and `party-label.ts` deliberately refuses to name them),
 * and anything outside the window. Agent-scoped by `c.agent_id`, so no thread of another agent can
 * appear — the W3-4 rule the recall lane applies to its own hits.
 *
 * ⚠ THE WINDOW IS ON THE MESSAGE, NOT ON THE CONVERSATION ROW. `conversations` carries no
 * last-activity column that every door maintains, so "live" is derived from `messages` — which is
 * also what makes the instant printable. One grouped read, bounded by `OTHER_THREADS_READ_CAP`.
 */
export function readOtherThreads(agentId: string, currentConversationId: string | null): OtherThreadsRead {
  const since = Date.now() - OTHER_THREADS_WINDOW_DAYS * 86_400_000;
  const rows = getDb().prepare(
    `SELECT c.id AS conversation_id, c.channel AS channel,
            MAX(m.created_at) AS last_at,
            (SELECT m2.role FROM messages m2
              WHERE m2.conversation_id = c.id AND m2.agent_id = ?
              ORDER BY m2.created_at DESC, m2.seq DESC LIMIT 1) AS last_role
       FROM conversations c JOIN messages m ON m.conversation_id = c.id
      WHERE c.agent_id = ? AND m.agent_id = ? AND c.channel <> 'a2a'
        AND m.created_at >= ? AND c.id <> COALESCE(?, '')
      GROUP BY c.id
      ORDER BY last_at DESC
      LIMIT ?`,
  ).all(agentId, agentId, agentId, since, currentConversationId, OTHER_THREADS_READ_CAP) as Array<{
    conversation_id: string; channel: string; last_at: number; last_role: string | null;
  }>;

  const all: OtherThread[] = [];
  for (const r of rows) {
    const label = conversationLabel(r.conversation_id);
    // A thread whose party cannot be named is not printed.
    //
    // ⚠ AND THE CHECK IS NOT `!label`, WHICH IS WHAT IT WAS FIRST AND WHAT THIS LANE'S OWN CLAUSE
    // CAUGHT: `conversationLabel` falls back to THE CHANNEL NAME when a conversation carries no
    // counterparty id and no counterparty name, so the guard let through a row reading
    // "imessage — last activity …". That tells the model a thread exists and nothing whatsoever
    // about whose, which is worse than silence because it invites a guess — and a guess about who
    // is waiting on the other end is the failure this whole lane is repairing.
    if (!label || label === r.channel) continue;
    all.push({
      conversationId: r.conversation_id,
      label,
      channel: r.channel,
      lastAtMs: r.last_at,
      theySpokeLast: r.last_role === 'user',
    });
  }

  const channels = listChannelStatuses()
    .filter((c) => c.configured)
    .map((c) => ({ displayName: c.displayName, inboundLive: c.inboundLive }));

  return {
    rows: all.slice(0, OTHER_THREADS_MAX_ROWS),
    hidden: Math.max(0, all.length - OTHER_THREADS_MAX_ROWS),
    channels,
    route: routeSentence(agentId),
  };
}

export const OTHER_THREADS_HEAD = '═══ YOUR OTHER LIVE THREADS — LIVE PLATFORM TRUTH ═══';
export const OTHER_THREADS_TAIL = '═══ END OTHER THREADS ═══';

/**
 * THE SUPERSESSION SENTENCE, in the voice `integration-status-lane.ts` established.
 *
 * It has to do three things, and the third is the one the incident turned on: state that these
 * threads EXIST, state that the conversation above was filtered (so absence stops being evidence),
 * and NAME THE TOOL that reaches them. W84's lesson is that publishing live truth without naming
 * the action leaves the model with a fact it cannot use.
 */
export const OTHER_THREADS_HEADLINE =
  'The conversation above is ONE thread, filtered to it on purpose. These other threads are live on '
  + 'this platform right now, and their messages are in your own history even though they are not '
  + 'shown above — so "I have no way to see that" is FALSE and must never be said. No content is '
  + 'listed here by design';

/**
 * The route sentence, and it names ONLY tools this agent can actually call.
 *
 * ⚠ THIS IS A BUILD-TIME LIVE PROBE FINDING, not a design instinct. The first cut named
 * `history_search`, `history_get` and `recall_recent_thread(scope:"all")` unconditionally. Driven on
 * a scratch agent through the real dashboard door, the lane fired at 769 chars and WORKED — the agent
 * answered correctly out of the other silo instead of denying it — but the receipt showed those three
 * tools were NOT on the call at all (a dashboard-created agent's default grants do not include the
 * Conversation Recall category), and the model reached the rows through nine `exec` calls instead.
 *
 * Naming a tool the agent cannot call is the SAME FAILURE THIS LANE EXISTS TO CURE, pointed the other
 * way: a confident engine sentence that does not match platform truth. W84's whole lesson is that the
 * model then has to decide which of two authorities to believe. So the sentence is composed from what
 * `toolCategoryGranted` says is actually reachable, and when NOTHING in that family is granted it says
 * so plainly rather than instructing toward a locked door — the thread still exists, and that fact is
 * the part the owner's incident turned on.
 */
export function routeSentence(agentId: string): string {
  let granted: string[] = [];
  try {
    granted = ['history_search', 'history_get', 'recall_recent_thread']
      .filter((t) => toolCategoryGranted(agentId, t));
  } catch { granted = []; }
  if (granted.length === 0) {
    return ': you have no conversation-recall tool granted, so you cannot read them from here — say '
      + 'that the thread exists and offer to look it up, and never say you have no way to see it.';
  }
  const named = granted
    .map((t) => (t === 'recall_recent_thread' ? '`recall_recent_thread(scope:"all")`' : `\`${t}\``))
    .join(' or ');
  return `: to read any of these, call ${named} — searching ALL of your threads, not just this one. `
    + 'Do that BEFORE telling anyone you cannot see another conversation.';
}

const CHANNELS_LINE = (channels: OtherThreadsRead['channels']): string =>
  'Channels you receive on right now: '
  + channels.map((c) => `${c.displayName}${c.inboundLive ? '' : ' (configured, inbound NOT live)'}`).join(' · ');

/** One row: party, channel, when, and who spoke last. No content, ever. */
function threadLine(t: OtherThread, n: number): string {
  const who = t.theySpokeLast ? 'they messaged last' : 'you replied last';
  return `${n}. ${t.label} — last activity ${recordedInstant(t.lastAtMs)}, ${who} [other conversation]`;
}

/**
 * The block, or `null` when there is nothing true to say.
 *
 * A pure function of its read, so the injection site can be tested without a database and so the
 * bytes are derivable by the reserve derivation at maximal caps.
 *
 * The CHANNEL half rides along only when there IS at least one other thread: a channel list on a
 * turn with no other thread is capability trivia, and this lane's licence to spend tail tokens on
 * every human turn comes from contradicting a false inference, not from being informative.
 */
export function renderOtherThreads(read: OtherThreadsRead): string | null {
  if (read.rows.length === 0) return null;
  const lines = read.rows.map((t, i) => threadLine(t, i + 1));
  const tail = read.hidden > 0
    ? `\n… and ${read.hidden} more thread${read.hidden === 1 ? '' : 's'} active in the last `
      + `${OTHER_THREADS_WINDOW_DAYS} days, not listed (the ${read.rows.length} most recent are shown)`
    : '';
  const channels = read.channels.length > 0 ? `\n${CHANNELS_LINE(read.channels)}` : '';
  return `${OTHER_THREADS_HEAD}\n${OTHER_THREADS_HEADLINE}${read.route}\n${lines.join('\n')}${tail}${channels}\n${OTHER_THREADS_TAIL}`;
}

/** The injection, read + render, never throwing: a lane that cannot build must not cost the turn
 *  its other lanes (`engine.open-work`'s rule, and `engine.report-state` follows it too). */
export function buildOtherThreadsInjection(agentId: string, currentConversationId: string | null): string | null {
  try {
    return renderOtherThreads(readOtherThreads(agentId, currentConversationId));
  } catch (err) {
    logger.warn('OTHER THREADS lane FAILED — the agent is not told its other live threads exist', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

/**
 * The worst case in bytes, DERIVED BY CALLING THE RENDERER at maximal caps.
 *
 * The `integration-status-lane.ts:449` discipline: a reserve that is typed in by hand is a guess,
 * and a lane whose reserve is a guess either steals budget it never uses or overruns the one turn
 * that fills it. Labels are sized at a realistic ceiling rather than an imagined one — a
 * `counterparty_name` is a person's name, not prose.
 */
export function otherThreadsWorstCaseChars(): number {
  const label = 'x'.repeat(48);
  const read: OtherThreadsRead = {
    rows: Array.from({ length: OTHER_THREADS_MAX_ROWS }, (_, i) => ({
      conversationId: `c${i}`, label: `${label} (imessage)`, channel: 'imessage',
      lastAtMs: Date.now(), theySpokeLast: i % 2 === 0,
    })),
    hidden: OTHER_THREADS_READ_CAP - OTHER_THREADS_MAX_ROWS,
    channels: listChannelStatuses().map((c) => ({ displayName: c.displayName, inboundLive: false })),
    route: ': to read any of these, call `history_search` or `history_get` or '
      + '`recall_recent_thread(scope:"all")` — searching ALL of your threads, not just this one. '
      + 'Do that BEFORE telling anyone you cannot see another conversation.',
  };
  return (renderOtherThreads(read) ?? '').length;
}
