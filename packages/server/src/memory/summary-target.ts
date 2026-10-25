// ════════════════════════════════════════════════════════════════════════════════════════
// t269 — HOW LONG A SUMMARY SHOULD BE, AND WHICH OF ITS INPUT'S WORDS ARE FACTS.
//
// THE DEFECT (v35-summary-quality-investigation.md, H3.3 / cause 4): the target was fixed whatever the
// input — "approximately 5,000 tokens" for a leaf, 6,000 for a condensed note. 445 of 2,156 DeepSeek
// leaves on the dev box came out longer than their input (median 2.25×), and depth-1 notes a median
// 1.68× the size of their children. Padding is where invention starts.
//
// THE TARGET NOW, all arithmetic (no number is picked here):
//   target = min( input,  input × lane room / leaf span  +  the cost of each fact, once )
//   · `lane room / leaf span` — the summaries lane shows at most `LANE_LIMITS['lane.summaries']
//     .tokens.relevanceBudget` tokens (`lanes.ts`), and one leaf is written over at most
//     `LEAF_CHUNK_TOKENS`; so a full span folds into at most what the lane can show whole
//     (6,000 / 30,000 = 0.2 today). A smaller span gets a proportionally smaller target.
//   · `the cost of each fact, once` — the tokens it takes to write every distinct fact of the input
//     (an id, a code, an amount: a word with a digit in it) one time. A fact-dense input gets the
//     room to carry its facts, which is what the writer is asked to keep.
//   · never more than the input: a summary longer than what it summarises is not a summary
//     (`summarize.ts` refuses to keep one).
//
// A MERGE (fix round 1, ruling 1b) is STRICTLY SMALLER THAN ITS CHILDREN, so notes cannot grow level over
// level whatever the history's length or fact density:
//   ask = (1 − share) × (input / peers) / TARGET_SLACK,   kept ≤ TARGET_SLACK × ask = (1 − share) × average child
//   · each child in a merge's input also carries its `<summary …>` wrapper (w ≈ 45–50 tokens), so a parent is at
//     most 0.8 × (average child + w): a depth-d note is at most 0.8^d × L + 4w (L the largest leaf; Σ 0.8^k ≤ 4
//     for the wrapper term). A settled top-level set holds one note per depth (D depths, D ≈ log2 of the history)
//     besides the notes left whole on purpose (a pair no writer can write, a kept-whole row, a note queued for the
//     legacy rebuild), so its total is at most 5L + 4w·D: finite, growing only as the log of the history. This is a
//     bound on convergence, not on fit — what reaches the model is the summaries lane, which drops oldest-first;
//   · the facts a merge must carry are PART OF that ask: distinct, newest mention first, as many as fit
//     (`carriedFacts`). Older facts beyond the budget leave with their notes, which stay stored and recallable.
//
// Cache: this decides summariser OUTPUT size. It is in no prompt prefix.
// ════════════════════════════════════════════════════════════════════════════════════════

import { estimateTokens, SUMMARY_SHARE } from './budget.js';
import { laneLimit } from './lanes.js';
import { newestNoteRoomTokens } from './summaries-lane.js';

/** The largest span one leaf summary is written over, in tokens (the chunk size; was compaction.ts's
 *  `DEFAULTS.leafChunkTokens`, moved here so the target's arithmetic and the chunker read one number). */
export const LEAF_CHUNK_TOKENS = 30_000;

/** The share of its input a summary is given: the summaries lane's room over the largest leaf span. */
export function summaryShare(): number {
  return laneLimit('lane.summaries', 'tokens', 'relevanceBudget') / LEAF_CHUNK_TOKENS;
}

/** The target for the largest leaf job, a full span before its facts: the lane's room (for sizing a
 *  writer's job window, `dojo-working-memory.ts`, and the input room a chunk leaves for its output). */
export function fullSpanTargetTokens(): number {
  return Math.ceil(LEAF_CHUNK_TOKENS * summaryShare());
}

// The builder's own framing is not the conversation's facts: each row's [ROLE · PARTY · TIME] tag and
// each note's <summary …> wrapper carry recorded times the writer turns into its range line.
const ROW_TAG = /^\[(?:USER|ASSISTANT|TOOL|SYSTEM)\b[^\]\n]*\]/gm;
const NOTE_TAG = /<\/?summary\b[^>]*>/g;
const EDGE = /^[\s"'`()[\]{}<>,.;:!?*]+|[\s"'`()[\]{}<>,.;:!?*]+$/g;
// Dates and clock times are kept by the prompt's time rules (a merge rewrites them into one range), so
// they are not counted as facts a merge must copy word for word.
// Fix round 1 (review M3): a RANGE of either ("09:00–11:30", "2026-10-14–2026-10-18") is the same kind of word —
// the depth-0 prompt writes one at the head of every leaf and a merge rewrites them into one combined range.
const DT = String.raw`(?:\d{4}-\d{2}-\d{2}(?:[t ][\d:.]+z?)?|\d{1,2}:\d{2}(?::\d{2})?(?:am|pm)?)`;
const DATE_OR_TIME = new RegExp(String.raw`^(?:${DT}(?:[–—-]${DT})?|\d{1,2}(?:st|nd|rd|th)?|(?:19|20)\d{2})$`, 'i');

/** The distinct facts of a text, in order: every word holding a digit (an id, a code, an amount, a
 *  reference), outside the builder's own framing, that is not a bare date or time. */
export function summaryFacts(text: string): string[] {
  const body = text.replace(ROW_TAG, ' ').replace(NOTE_TAG, ' ');
  const out = new Set<string>();
  for (const raw of body.split(/\s+/)) {
    const t = raw.replace(EDGE, '');
    if (t.length < 2 || !/\d/.test(t) || DATE_OR_TIME.test(t)) continue;
    out.add(t);
  }
  return [...out];
}

/** The slack a target is given to land on a sentence — the same 1.5 `utilityOutputCap` sends as the cap. */
export const TARGET_SLACK = 1.5;

/**
 * t269 round 2 — THE NEWEST NOTE IS WHOLE IN VIEW. The most a LEAF's target may be on a view whose content budget is
 * `contentBudgetTokens`: what may be kept of it (TARGET_SLACK × target) fits the room the summaries lane has for its
 * newest note — the lane's room (its `maxTokens`: content budget × SUMMARY_SHARE, `assembler.ts`) less the block's
 * frame (`newestNoteRoomTokens`, measured with the note's own conversation label). Unbounded when there is no
 * budget to measure. A note that still cannot fit shows as the lane's kept-row pointer, never cut.
 */
export function leafKeepCap(contentBudgetTokens: number, label = 'conversation unknown'): number {
  if (!(contentBudgetTokens > 0)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(newestNoteRoomTokens(Math.floor(contentBudgetTokens * SUMMARY_SHARE), label) / TARGET_SLACK));
}

/** The ask for a MERGE of `peers` notes (header): what may be kept of it, TARGET_SLACK × ask, is (1 − share)
 *  of its average child — strictly smaller than its input. */
export function mergeTargetTokens(content: string, peers: number): number {
  const input = estimateTokens(content);
  return Math.max(1, Math.min(input - 1, Math.floor(((1 - summaryShare()) * (input / Math.max(1, peers))) / TARGET_SLACK)));
}

/** The facts a summary of `source` must carry within `budgetTokens`: distinct, newest mention first (a later
 *  mention in the input is newer: notes and rows are given oldest first), as many as the budget holds. */
export function carriedFacts(source: string, budgetTokens: number): string[] {
  const facts = summaryFacts(source).map((f) => ({ f, at: source.lastIndexOf(f) })).sort((a, b) => b.at - a.at);
  const out: string[] = [];
  let used = 0;
  for (const { f } of facts) {
    const cost = estimateTokens(`${f}, `);
    if (used + cost > budgetTokens) break;
    out.push(f);
    used += cost;
  }
  return out;
}

/** The facts of `source` that a summary must carry within `budgetTokens` and does not (exact text: an id
 *  copied is an id kept). */
export function factsDropped(source: string, summary: string, budgetTokens: number = Number.MAX_SAFE_INTEGER): string[] {
  return carriedFacts(source, budgetTokens).filter((f) => !summary.includes(f));
}

/** The target for a summary of `content` (header): proportional, room for its facts, never past the input. */
export function summaryTargetTokens(content: string): number {
  const input = estimateTokens(content);
  const facts = summaryFacts(content);
  const factRoom = facts.length > 0 ? estimateTokens(facts.join(' ')) : 0;
  return Math.max(1, Math.min(input, Math.ceil(input * summaryShare()) + factRoom));
}
