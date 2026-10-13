// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 3 (R-V333-10 items 3, 5, 6) — A ROW THE VIEW DROPPED IS NEVER UNREPRESENTED.
//
// When no summary writer answers in time (or a backlog is too large to fold inside one owner
// turn), the rows the view dropped get a PLACEHOLDER instead of a summary: a deterministic note,
// built from stored columns only — how many messages, from which kind of conversation, over what
// absolute time range — saying they are not yet condensed and that the originals are kept and
// searchable. No model writes it, and no outside text is copied into it: the conversation is named
// from a fixed vocabulary of channel words, never by a sender's name or a message's words.
//
// A placeholder is a leaf summary row whose content starts with `UNCONDENSED_PLACEHOLDER_HEAD`
// (`uncondensed-head.ts`), one per leaf chunk. Condensation never merges one. When a writer answers again the
// placeholder's own row is REWRITTEN in place with a real summary of exactly its rows — the links
// never move — in the background, and the 15-minute low-yield brake does not hold it back.
// ════════════════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { withLock } from '../db/with-lock.js';
import { createLogger } from '../logger.js';
import { getMessagesOutsideFreshTail } from './store.js';
import { createLeafSummary, deleteSummary, getCompactedMessageIds, getSummarySourceMessages, updateSummaryContent } from './dag.js';
import { UNCONDENSED_PLACEHOLDER_HEAD } from './uncondensed-head.js';
import {
  buildLeafSummaryInput, chunkMessages, getLeafChunkTokens, getLeafTargetTokens, rebuildContextItems,
  NO_CONVERSATION_PLACEHOLDER,
} from './compaction.js';
import { generateSummary } from './summarize.js';
import { estimateTokens } from './budget.js';
import { annotateSummaryObligations } from './summary-obligations.js';
import { eligibleSummaryWriters } from './summary-writer-health.js';
import { noteCompactionRecovered, reportCompactionDefect } from './compaction-defect.js';
import { backgroundDrains } from '../agent/shared-state.js';
import type { Message } from '@dojo/shared';

const logger = createLogger('memory-uncondensed-placeholder');

/** The background replacement's bounds: the routine condense's own (ten chunks, three minutes). */
const REPLACE_MAX_PER_RUN = 10;
const REPLACE_WALL_CLOCK_MS = 180_000;

/** The ONLY words a placeholder uses to say where its messages came from — channel and lane names
 *  mapped to a fixed vocabulary, so nothing a sender wrote or was called can reach the note. */
const CHANNEL_WORDS: Record<string, string> = {
  dashboard: 'the dashboard conversation', voice: 'a voice conversation', phone: 'a phone call',
  imessage: 'an iMessage conversation', sms: 'a text-message conversation', email: 'an email conversation',
  telegram: 'a Telegram conversation', slack: 'a Slack conversation', a2a: 'an agent thread',
};
const LANE_WORDS: Record<string, string> = {
  owner: "the owner's conversation", a2a: 'an agent thread', events: 'engine notices',
};

function whereFrom(rows: readonly Message[]): string {
  const channelOf = getDb().prepare('SELECT channel FROM conversations WHERE id = ?');
  const words = new Set<string>();
  for (const m of rows) {
    const conv = (m as { conversationId?: string | null }).conversationId;
    const channel = conv ? (channelOf.get(conv) as { channel?: string } | undefined)?.channel : undefined;
    const lane = (m as { lane?: string | null }).lane ?? undefined;
    words.add((channel && CHANNEL_WORDS[channel]) ?? (lane && LANE_WORDS[lane]) ?? "this agent's own work");
  }
  const list = [...words];
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.length} conversations`;
}

function stamp(at: unknown): string {
  const d = new Date(typeof at === 'number' ? at : String(at));
  return Number.isNaN(d.getTime()) ? 'an unrecorded time' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** The note, from stored columns only. Exported so a clause can read the sentence. */
export function placeholderText(rows: readonly Message[]): string {
  const n = rows.length;
  const first = stamp(rows[0]?.createdAt);
  const last = stamp(rows[n - 1]?.createdAt);
  return `${UNCONDENSED_PLACEHOLDER_HEAD} ${n} message${n === 1 ? '' : 's'} from ${whereFrom(rows)}, `
    + `${first}${last !== first ? ` – ${last}` : ''}, not yet condensed — the originals are kept and searchable.`;
}

/** Unsummarised rows of this session at or below `throughSeq` (the fold's own reader). */
export function owedThrough(agentId: string, throughSeq: number): Message[] {
  const compacted = getCompactedMessageIds(agentId);
  return getMessagesOutsideFreshTail(agentId, 1)
    .filter((m) => !compacted.has(m.id) && (m.rowid ?? Number.POSITIVE_INFINITY) <= throughSeq);
}

/** Cover every still-unsummarised row at or below `throughSeq` with placeholders, one per leaf
 *  chunk. Synchronous and model-free, so it can run at any instant; re-reads what is owed, so a
 *  second call (or a fold that landed meanwhile) covers nothing twice. Returns rows covered. */
export function writeUncondensedPlaceholders(agentId: string, throughSeq: number): number {
  const owed = owedThrough(agentId, throughSeq);
  if (owed.length === 0) return 0;
  for (const chunk of chunkMessages(owed, getLeafChunkTokens())) {
    if (chunk.length === 0) continue;
    const text = placeholderText(chunk);
    createLeafSummary(agentId, text, estimateTokens(text), chunk.map((m) => m.id), chunk[0].createdAt, chunk[chunk.length - 1].createdAt);
  }
  rebuildContextItems(agentId);
  logger.warn('Rows left the live view with no summary written in time; placeholders stand in until one is', {
    rows: owed.length, throughSeq,
  }, agentId);
  return owed.length;
}

export function hasUncondensedPlaceholders(agentId: string): boolean {
  return !!getDb().prepare('SELECT 1 FROM summaries WHERE agent_id = ? AND substr(content, 1, length(?)) = ? LIMIT 1')
    .get(agentId, UNCONDENSED_PLACEHOLDER_HEAD, UNCONDENSED_PLACEHOLDER_HEAD);
}

function configuredModel(agentId: string): string | undefined {
  return (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? undefined;
}

/** Is this row also covered by a REAL summary (a fold that landed beside a placeholder)? */
function coveredElsewhere(messageId: string, placeholderId: string): boolean {
  return !!getDb().prepare(
    `SELECT 1 FROM summary_messages sm JOIN summaries s ON s.id = sm.summary_id
      WHERE sm.message_id = ? AND sm.summary_id != ? AND substr(s.content, 1, length(?)) != ? LIMIT 1`,
  ).get(messageId, placeholderId, UNCONDENSED_PLACEHOLDER_HEAD, UNCONDENSED_PLACEHOLDER_HEAD);
}

/**
 * Replace placeholders with real summaries of exactly their rows, oldest first, trying the next
 * eligible writer when one fails. Under the per-agent compaction lock (waiting for one running);
 * never consults the low-yield brake. When none remain, the compaction-failing incident is over.
 * Returns how many placeholders were replaced (or dropped because a real fold already covered them).
 */
export async function replaceUncondensedPlaceholders(
  agentId: string, opts: { abortSignal?: AbortSignal; maxChunks?: number } = {},
): Promise<number> {
  return (await withLock(`compact:${agentId}`, () => replaceUnderLock(agentId, opts), { ifBusy: 'wait' })) ?? 0;
}

async function replaceUnderLock(agentId: string, opts: { abortSignal?: AbortSignal; maxChunks?: number }): Promise<number> {
  const ids = (getDb().prepare(
    'SELECT id FROM summaries WHERE agent_id = ? AND substr(content, 1, length(?)) = ? ORDER BY earliest_at ASC, id ASC',
  ).all(agentId, UNCONDENSED_PLACEHOLDER_HEAD, UNCONDENSED_PLACEHOLDER_HEAD) as Array<{ id: string }>)
    .slice(0, opts.maxChunks ?? Number.POSITIVE_INFINITY);
  const preferred = configuredModel(agentId);
  let replaced = 0;
  let failedWriter: string | null = null;
  for (const { id } of ids) {
    if (opts.abortSignal?.aborted) break;
    const source = getSummarySourceMessages(id);
    if (source.length === 0 || source.every((m) => coveredElsewhere(m.id, id))) {
      deleteSummary(id);
      replaced++;
      continue;
    }
    const content = buildLeafSummaryInput(source);
    let done = content.trim().length === 0;
    if (done) updateSummaryContent(id, NO_CONVERSATION_PLACEHOLDER, estimateTokens(NO_CONVERSATION_PLACEHOLDER));
    for (let attempt = 0; attempt < 3 && !done && !opts.abortSignal?.aborted; attempt++) {
      const writer = eligibleSummaryWriters(preferred)[0];
      if (!writer) break;
      const summary = await generateSummary({ content, depth: 0, targetTokens: getLeafTargetTokens(), agentId, modelId: writer, abortSignal: opts.abortSignal });
      if (!summary.ok) { failedWriter = writer; continue; }
      const text = annotateSummaryObligations(summary.text, agentId);
      updateSummaryContent(id, text, text === summary.text ? summary.tokenCount : estimateTokens(text));
      done = true;
    }
    if (!done) break;
    replaced++;
  }
  if (replaced > 0) rebuildContextItems(agentId);
  if (!hasUncondensedPlaceholders(agentId)) {
    noteCompactionRecovered(agentId, 0);
  } else if (failedWriter) {
    reportCompactionDefect(agentId, 'summary_writer_unavailable',
      { modelId: failedWriter, detail: 'placeholder notes could not yet be replaced by summaries' },
      { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 });
  }
  logger.info('Placeholder replacement pass', { replaced, remaining: hasUncondensedPlaceholders(agentId) }, agentId);
  return replaced;
}

/** THE GATE'S LAUNCHER: one background replacement per agent (sharing the routine condense's
 *  one-in-flight slot), only when a placeholder exists and some writer is eligible. */
export function replacePlaceholdersInBackground(agentId: string): boolean {
  try {
    if (backgroundDrains.has(agentId) || !hasUncondensedPlaceholders(agentId)) return false;
    if (eligibleSummaryWriters(configuredModel(agentId)).length === 0) return false;
  } catch {
    return false;   // a read that failed starts nothing; the gate never fails a turn over this
  }
  backgroundDrains.add(agentId);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort('deadline'), REPLACE_WALL_CLOCK_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
  replaceUncondensedPlaceholders(agentId, { abortSignal: ctl.signal, maxChunks: REPLACE_MAX_PER_RUN })
    .catch((err) => logger.warn('Placeholder replacement failed', { error: err instanceof Error ? err.message : String(err) }, agentId))
    .finally(() => { clearTimeout(timer); backgroundDrains.delete(agentId); });
  return true;
}
