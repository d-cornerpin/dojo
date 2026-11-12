// Summary length, all arithmetic: target = min(input, input x lane room / leaf span + the cost of each fact once).
// Lane room is the summaries lane's `relevanceBudget` (`lanes.ts`); leaf span is `LEAF_CHUNK_TOKENS`.
// A fact is a word with a digit in it. A MERGE is smaller than its children (`mergeTargetTokens`), so notes
// cannot grow level over level; its facts are part of that ask. This sizes OUTPUT, in no prompt prefix.

import { CHARS_PER_TOKEN, SUMMARY_SHARE } from './budget.js';
import { tokensAt } from '../services/token-density.js';
import { laneLimit } from './lanes.js';
import { newestNoteRoomTokens } from './summaries-lane.js';

export const LEAF_CHUNK_TOKENS = 30_000;

export function summaryShare(): number {
  return laneLimit('lane.summaries', 'tokens', 'relevanceBudget') / LEAF_CHUNK_TOKENS;
}

export function fullSpanTargetTokens(): number {
  return Math.ceil(LEAF_CHUNK_TOKENS * summaryShare());
}

const ROW_TAG = /^\[(?:USER|ASSISTANT|TOOL|SYSTEM)\b[^\]\n]*\]/gm;
const NOTE_TAG = /<\/?summary\b[^>]*>/g;
const EDGE = /^[\s"'`()[\]{}<>,.;:!?*]+|[\s"'`()[\]{}<>,.;:!?*]+$/g;
// Dates, clock times and ranges of either are not counted as facts: a merge rewrites them into one range.
const DT = String.raw`(?:\d{4}-\d{2}-\d{2}(?:[t ][\d:.]+z?)?|\d{1,2}:\d{2}(?::\d{2})?(?:am|pm)?)`;
const DATE_OR_TIME = new RegExp(String.raw`^(?:${DT}(?:[–—-]${DT})?|\d{1,2}(?:st|nd|rd|th)?|(?:19|20)\d{2})$`, 'i');

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

/** The slack a target is given to land on a sentence; the same 1.5 `utilityOutputCap` sends as the cap. */
export const TARGET_SLACK = 1.5;

/** The most a LEAF's target may be on a view with `contentBudgetTokens`: what may be kept (TARGET_SLACK x target)
 *  fits the room the lane has for its newest note. Unbounded with no budget; else the lane's pointer shows it. */
export function leafKeepCap(contentBudgetTokens: number, label = 'conversation unknown', charsPerToken?: number): number {
  if (!(contentBudgetTokens > 0)) return Number.MAX_SAFE_INTEGER;
  // The lane counts in CHARS_PER_TOKEN; the target is in the writer's tokens (its own density).
  const roomChars = newestNoteRoomTokens(Math.floor(contentBudgetTokens * SUMMARY_SHARE), label) * CHARS_PER_TOKEN;
  return Math.max(1, Math.floor(tokensAt(roomChars, charsPerToken) / TARGET_SLACK));
}

export const textTokens = (text: string, charsPerToken?: number): number => tokensAt(text.length, charsPerToken);

export function mergeTargetTokens(content: string, peers: number, charsPerToken?: number): number {
  const input = textTokens(content, charsPerToken);
  return Math.max(1, Math.min(input - 1, Math.floor(((1 - summaryShare()) * (input / Math.max(1, peers))) / TARGET_SLACK)));
}

/** The facts `source` must keep within `budgetTokens`, newest mention first (input comes oldest first). */
export function carriedFacts(source: string, budgetTokens: number, charsPerToken?: number): string[] {
  const facts = summaryFacts(source).map((f) => ({ f, at: source.lastIndexOf(f) })).sort((a, b) => b.at - a.at);
  const out: string[] = [];
  let used = 0;
  for (const { f } of facts) {
    const cost = textTokens(`${f}, `, charsPerToken);
    if (used + cost > budgetTokens) break;
    out.push(f);
    used += cost;
  }
  return out;
}

export function factsDropped(source: string, summary: string, budgetTokens: number = Number.MAX_SAFE_INTEGER, charsPerToken?: number): string[] {
  return carriedFacts(source, budgetTokens, charsPerToken).filter((f) => !summary.includes(f));
}

export function summaryTargetTokens(content: string, charsPerToken?: number): number {
  const input = textTokens(content, charsPerToken);
  const facts = summaryFacts(content);
  const factRoom = facts.length > 0 ? textTokens(facts.join(' '), charsPerToken) : 0;
  return Math.max(1, Math.min(input, Math.ceil(input * summaryShare()) + factRoom));
}
