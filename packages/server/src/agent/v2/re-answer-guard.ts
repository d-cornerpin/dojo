// ════════════════════════════════════════
// Cross-conversation re-answer guard
//
// The disease (three production specimens by 2026-07-09, reproduced live on dev
// 2026-07-10): a turn serving conversation X, or a background wake, emits a
// substantive answer that re-does the most recent answer from a DIFFERENT,
// already-settled conversation. The engine's claim bookkeeping prevents
// re-serving, and routing is correct (the text lands in X), so the only
// detectable signal is the CONTENT: the outbound near-duplicates an assistant
// answer the user already received elsewhere. An [Engine hint] alone did not
// stop the weakest supported model (verified on dev), so the loop escalates to
// the steer machinery when this detector fires; the detector itself never
// blocks or edits anything.
//
// Deterministic, local, and cheap by design (same doctrine as the model
// router): content-word containment plus a shared-number boost against a
// handful of recent assistant rows. No model call, no network.
// ════════════════════════════════════════

import type { getDb } from '../../db/connection.js';

// Both sides must be substantive before they can match: short acks, one-line
// confirmations, and engine notices can never trip the guard.
const MIN_COMPARABLE_CHARS = 160;
// Content-word containment (plus shared-number boost) at or above this counts
// as a re-answer. Calibrated against the dev reproductions: independent
// rewordings of the same answer land well above; unrelated prose lands near 0
// (see re-answer-guard.test.ts fixtures, which are those real texts).
const SIMILARITY_THRESHOLD = 0.5;
// How far back and how many rows to compare against.
const LOOKBACK_HOURS = 24;
const MAX_CANDIDATES = 8;

// Function words carry no re-answer signal; strip them so the comparison sees
// only content words and numbers.
const STOPWORDS = new Set(('the a an is are was were be been being to of in on at it its you your yours his her hers ' +
  'he she they them their this that these those and or but so if not no yes with for as by from up down out off over ' +
  'under would could should can will shall may might must just about than then there here what which who whom how ' +
  'when where why do does did done have has had having i we my our ours me him us am pm oh okay ok well really very ' +
  'also too more most less least much many some any all both each other another only even still again once ' +
  'get got gets need needs needed want wants let lets going gonna basically actually depending option options').split(' '));

export function normalizeForSimilarity(text: string): string[] {
  return text
    .toLowerCase()
    // Strip markdown adornments and punctuation but KEEP digits: numeric
    // results (the 35.4-inch class) are exactly what re-answers share.
    .replace(/[`*_#>|[\]()"'’′″”“]/g, ' ')
    .replace(/[^a-z0-9.\s]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// Rewordings share their SUBSTANCE, not their phrasing: exact word sequences
// rarely survive a model rephrase (measured 0.03 trigram Jaccard between two
// genuine rewordings of the same answer), while distinctive content words and
// above all NUMBERS survive every time. Score = containment of the smaller
// content-word set in the larger, with a boost when several exact numbers are
// shared (numbers are the fingerprint of a redone factual answer).
export function contentOverlap(aWords: string[], bWords: string[]): number {
  const a = new Set(aWords);
  const b = new Set(bWords);
  if (a.size < 10 || b.size < 10) return 0;
  let inter = 0;
  const sharedNumbers = new Set<string>();
  for (const w of a) {
    if (b.has(w)) {
      inter++;
      if (/^\d/.test(w)) sharedNumbers.add(w);
    }
  }
  const containment = inter / Math.min(a.size, b.size);
  const numberBoost = sharedNumbers.size >= 3 ? 0.15 : 0;
  return Math.min(1, containment + numberBoost);
}

export interface ReAnswerMatch {
  conversationId: string;
  similarity: number;
  snippet: string;
}

/**
 * Does `candidate` (an about-to-be-delivered reply for `excludeConversationId`)
 * near-duplicate a recent assistant answer from a DIFFERENT conversation?
 *
 * Only settled history can match: rows compared against are claimed,
 * natural-language assistant rows in other conversations. A user re-asking the
 * same question in its own conversation never trips this, that turn's trigger
 * conversation is excluded from comparison.
 *
 * ── REKEY (PHASE-2 T10I), and the sentinel exclusion is the part worth reading. This used
 * to say `conv_key NOT IN ('engine','engine-steer')`, i.e. it excluded engine chatter by
 * naming two of the three fake conversation keys the engine wrote (`engine-notice` was never
 * in the list — a third value the guard would have compared against a human reply). What it
 * was reaching for is `lane <> 'events'`, which is stamped at ingest, cannot be forgotten by
 * a new writer, and covers all three. Same shape as T10H's rider fix on the other half of
 * this column: the requirement stops depending on a fake key.
 * requirement preserved: engine chatter is never compared against a human reply, and a row
 * with no conversation at all is never a "different conversation".
 */
export function findCrossConvReAnswer(
  db: ReturnType<typeof getDb>,
  agentId: string,
  candidate: string,
  excludeConversationId: string | null,
): ReAnswerMatch | null {
  if (!candidate || candidate.length < MIN_COMPARABLE_CHARS) return null;
  const candWords = normalizeForSimilarity(candidate);
  if (candWords.length < 12) return null;

  const rows = db.prepare(
    `SELECT conversation_id, content FROM messages
      WHERE agent_id = ? AND role = 'assistant'
        AND conversation_id IS NOT NULL
        AND (? IS NULL OR conversation_id != ?)
        AND lane <> 'events'
        AND content NOT LIKE '[{%'
        AND length(content) >= ${MIN_COMPARABLE_CHARS}
        AND created_at >= (unixepoch('now', '-${LOOKBACK_HOURS} hours') * 1000)
      ORDER BY created_at DESC LIMIT ${MAX_CANDIDATES}`,
  ).all(agentId, excludeConversationId, excludeConversationId) as Array<{ conversation_id: string; content: string }>;

  for (const r of rows) {
    const sim = contentOverlap(candWords, normalizeForSimilarity(r.content));
    if (sim >= SIMILARITY_THRESHOLD) {
      return {
        conversationId: r.conversation_id,
        similarity: Math.round(sim * 100) / 100,
        snippet: r.content.replace(/\s+/g, ' ').slice(0, 100),
      };
    }
  }
  return null;
}
