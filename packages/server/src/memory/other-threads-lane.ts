// Names the agent's other live human threads (party, channel, recency) and live channels, so a waiting thread is
// seen even when its rows have left the view. No message content: the rows are in the history, labelled.
// A tail lane after `volatileFrom`: it moves whenever any thread moves, so it must never sit in the cached prefix.

import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { conversationLabel } from './party-label.js';
import { recordedInstant } from './message-stamp.js';
import { listChannelStatuses } from '../services/capability-registry.js';
import { toolCategoryGranted } from '../agent/access/read.js';
import { renderTokens, loopTailExtraTokens } from './lanes.js';
import { withChannel } from './thread-channel.js';
import { layOutInRoom, unlistedThreadsLine } from './other-threads-room.js';

const logger = createLogger('other-threads-lane');

export interface OtherThread {
  conversationId: string;
  label: string;
  channel: string;
  /** Epoch ms. */
  lastAtMs: number;
  theySpokeLast: boolean;
}

export interface OtherThreadsRead {
  rows: OtherThread[];
  hidden: number;
  channels: Array<{ displayName: string; inboundLive: boolean }>;
  route: string;
}

/** Waiting threads first, then those touched since the agent's last turn here, never the served one or a2a.
 *  Activity comes from `messages`: `conversations` has no last-activity column every door maintains.
 *  The unary plus keeps the per-conversation lookup on the (conversation_id, seq) index, not a scan of the agent's rows. */
export function readOtherThreads(agentId: string, currentConversationId: string | null): OtherThreadsRead {
  const db = getDb();
  let since: number | null = null;
  if (currentConversationId) {
    const anchor = db.prepare(
      `SELECT MAX(CASE WHEN role = 'assistant' THEN created_at END) AS last_reply, MIN(created_at) AS began
         FROM messages WHERE +agent_id = ? AND conversation_id = ?`,
    ).get(agentId, currentConversationId) as { last_reply: number | null; began: number | null } | undefined;
    since = anchor?.last_reply ?? anchor?.began ?? null;
  }
  const rows = db.prepare(
    `SELECT c.id AS conversation_id, c.channel AS channel, n.created_at AS last_at, n.role AS last_role
       FROM conversations c
       JOIN messages n ON n.seq = (SELECT MAX(m.seq) FROM messages m WHERE m.conversation_id = c.id AND +m.agent_id = ?)
      WHERE c.agent_id = ? AND c.channel <> 'a2a' AND c.id <> COALESCE(?, '')
      ORDER BY last_at DESC`,
  ).all(agentId, agentId, currentConversationId) as Array<{
    conversation_id: string; channel: string; last_at: number; last_role: string | null;
  }>;

  const named: OtherThread[] = [];
  let hidden = 0;
  const entry = (r: typeof rows[number], label: string): OtherThread => ({
    conversationId: r.conversation_id, label, channel: r.channel, lastAtMs: r.last_at, theySpokeLast: r.last_role === 'user',
  });
  const waiting: OtherThread[] = [], touched: OtherThread[] = [];
  for (const r of rows) {
    const isWaiting = r.last_role === 'user';
    const isTouched = since !== null && r.last_at > since;
    if (!isWaiting && !isTouched) { hidden++; continue; }
    const label = conversationLabel(r.conversation_id);
    // `conversationLabel` falls back to the bare channel; a row naming only a channel invites a guess at who waits.
    if (!label || label === r.channel) continue;
    (isWaiting ? waiting : touched).push(entry(r, withChannel(label, r.channel)));
  }
  named.push(...waiting, ...touched);

  const channels = listChannelStatuses()
    .filter((c) => c.configured)
    .map((c) => ({ displayName: c.displayName, inboundLive: c.inboundLive }));

  return { rows: named, hidden, channels, route: routeSentence(agentId) };
}

export const OTHER_THREADS_HEAD = '═══ YOUR OTHER LIVE THREADS — LIVE PLATFORM TRUTH ═══';
export const OTHER_THREADS_TAIL = '═══ END OTHER THREADS ═══';

export const OTHER_THREADS_HEADLINE =
  'The history above holds all of your conversations, each row labelled with the one it belongs to; this turn '
  + 'answers only its own. These other threads are live on this platform right now and older messages of theirs '
  + 'may have left the view, so "I have no way to see that" is FALSE and must never be said';

/** Names only tools this agent can call: default grants may omit Conversation Recall, and naming an
 *  ungranted tool would contradict platform truth. */
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

function threadLine(t: OtherThread, n: number): string {
  const who = t.theySpokeLast ? 'they messaged last' : 'you replied last';
  return `${n}. ${t.label} — last activity ${recordedInstant(t.lastAtMs)}, ${who} [other conversation]`;
}

/** Null when there is nothing true to say; a pure function of its read, testable without a database. */
export function renderOtherThreads(read: OtherThreadsRead, roomTokens?: number): string | null {
  if (read.rows.length === 0) return null;
  const tail = read.hidden > 0
    ? `\n… and ${read.hidden} more thread${read.hidden === 1 ? '' : 's'} with nothing waiting and nothing new since your last turn here, not listed`
    : '';
  const channels = read.channels.length > 0 ? `\n${CHANNELS_LINE(read.channels)}` : '';
  return layOutInRoom(read.rows.length, roomTokens, (shown) => `${OTHER_THREADS_HEAD}\n${OTHER_THREADS_HEADLINE}${read.route}`
    + (shown > 0 ? `\n${read.rows.slice(0, shown).map((t, i) => threadLine(t, i + 1)).join('\n')}` : '')
    + `${unlistedThreadsLine(read.rows.slice(shown))}${tail}${channels}\n${OTHER_THREADS_TAIL}`);
}

/** Never throws: a lane that cannot build must not cost the turn its other lanes. */
export function buildOtherThreadsInjection(agentId: string, currentConversationId: string | null, roomTokens?: number): string | null {
  try {
    return renderOtherThreads(readOtherThreads(agentId, currentConversationId), roomTokens);
  } catch (err) {
    logger.warn('OTHER THREADS lane FAILED — the agent is not told its other live threads exist', {
      agentId, error: err instanceof Error ? err.message : String(err),
    }, agentId);
    return null;
  }
}

/** Rendered size beyond the loop-tail reserve's literal; zero when the loop will not append the block. */
export function otherThreadsReserveExtra(agentId: string, currentConversationId: string | null, roomTokens?: number): number {
  if (!currentConversationId) return 0;
  const block = buildOtherThreadsInjection(agentId, currentConversationId, roomTokens);
  return block ? loopTailExtraTokens(renderTokens([{ role: 'user', content: block }])) : 0;
}
