// ════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 4 T20 — A SUMMARY IS NOT A SECOND LEDGER.
//
// The summarizer is INSTRUCTED to record obligations, and its instruction states the law that
// nothing implemented (`memory/summarize.ts`):
//
//     "cite its work id as written … the id is the record, the summary is the context around it"
//
// `839eedc` deleted the fenced OPEN-LOOPS block and its prose parser — a summariser writing
// the obligation ledger — and ADDED that citation instruction in the same commit. Nothing was
// ever built to READ the citation. So a line the model wrote in good faith on 2026-08-06
// ("two quotes still parked, waiting on Bob's address") was still being served, present tense,
// on 2026-08-10, from two stored summaries, while the OPEN WORK block in the same assembled
// prompt correctly carried none of them. This module is the missing reader.
//
// ── THE PRINCIPLE, THIRD AND FINAL SURFACE ──
// SWEEP CORE-2 item 4: recall resolves hits against the authoritative record — NO PARALLEL
// MEMORY OF ANSWERS. UX-REPAIR T17 pointed it at the vault: no parallel memory of OBLIGATIONS.
// This points it at summaries. The spine is the only truth about what is owed, and there is
// exactly ONE resolver — `work/obligation-memory.ts` — which this file calls rather than
// reimplements. A second copy of "what does this token resolve to" is the thing all three
// tasks exist to prevent.
//
// ── WHY AT WRITE, AND WHY NOTHING IS EVER REWRITTEN AT RENDER ──
// Summaries ride `MessageSlot.Summaries = 300`, INSIDE `volatileFrom` — the cacheable prompt
// prefix. T17 could resolve at READ because the recall lane is TAIL (its own commit body: "no
// prompt-prefix edit — this task touches no cached surface"); slot 300 is the other side of
// that line. So the resolution happens where the summariser's own separate model call already
// is: at WRITE, once, into the stored text. Rendering reads the row exactly as stored, so a
// turn's prefix bytes are what they were on the turn before. The one static sentence that says
// which block is current lives in the lane header and is a registered re-blessing.
//
// ── IT ANNOTATES; IT NEVER REWRITES ──
// The agent's own sentence is left intact and the engine's finding is APPENDED, in brackets,
// on the same line. Same shape as the vault's `markObsolete` (a flag beside the words, never
// an edit of them) and the same reason: a memory the platform silently rewrote is a memory
// nobody can audit.
//
// ── AND IT NEVER GUESSES ──
// A line is only touched when it carries one of the two literal join tokens the model itself
// wrote — `cmt:<hex>` or `promise-<runid>`. A line that merely SOUNDS like an obligation is
// left exactly as written. That is the same refusal `839eedc` bought with 623 deleted lines,
// and it is why the one-time hygiene pass over stored rows is deterministic rather than a
// second prose parser wearing a different hat.
// ════════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { obligationTags, obligationVerdict } from '../work/obligation-memory.js';
import { updateSummaryContent } from './dag.js';
import { estimateTokens } from './budget.js';

const logger = createLogger('summary-obligations');

/** The opening of the engine's appended finding. One literal, so the writer, the idempotence
 *  check and the tests all read the same token and cannot drift. */
export const SUMMARY_OBLIGATION_MARK = '[work state as of ';

/** `YYYY-MM-DD`, the granularity every other dated marker in this tree uses. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** The finding for ONE line, or null when the line carries no join token at all. */
function findingFor(line: string): string | null {
  if (obligationTags(line).length === 0) return null;
  const verdict = obligationVerdict(line);
  switch (verdict.kind) {
    case 'closed':
      return `${SUMMARY_OBLIGATION_MARK}${today()}: ${verdict.states.join('/')}]`;
    case 'live':
      return `${SUMMARY_OBLIGATION_MARK}${today()}: open]`;
    case 'unresolvable':
      // NOT dead — unknown. The same distinction the recall lane draws, for the same reason:
      // declaring a record dead because we could not find it is how a memory becomes a lie in
      // the other direction.
      return `${SUMMARY_OBLIGATION_MARK}${today()}: no matching record on the work spine — `
        + 'verify before repeating as owed]';
    case 'not-an-obligation':
    default:
      return null;
  }
}

/**
 * Resolve every id-cited obligation line in a summary against the spine.
 *
 * Line-oriented on purpose: the summariser writes one item per line, the annotation belongs to
 * the item, and a whole-text transform could not say WHICH obligation it had resolved.
 * Idempotent by the mark, so the write path and the one-time hygiene pass can both run over
 * the same text without stacking.
 */
export function annotateSummaryObligations(text: string): string {
  if (!text || !text.includes('cmt:') && !text.includes('promise-')) return text;
  let changed = false;
  const out = text.split('\n').map((line) => {
    if (line.includes(SUMMARY_OBLIGATION_MARK)) return line;
    const finding = findingFor(line);
    if (!finding) return line;
    changed = true;
    return `${line.trimEnd()} ${finding}`;
  });
  return changed ? out.join('\n') : text;
}

export interface SummaryObligationSweep {
  scanned: number;
  affected: number;
  ids: string[];
}

/**
 * The one-time hygiene pass over ALREADY-STORED summaries.
 *
 * MEASURED BEFORE IT IS APPLIED — `dryRun` returns exactly what a run would touch and writes
 * nothing, because a bulk rewrite of the agent's memory is not something to discover the size
 * of afterwards. It is deterministic: id-cited lines only, no prose guessing, so a summary
 * carrying an obligation the model never gave an id is left exactly as written. On the worn-in
 * dev body that is every one of them — measured 2026-08-10: 158 summaries, ZERO citing a
 * `cmt:` or `promise-` token — which is the honest reason the pass is a no-op there and the
 * reason the summarizer contract, not this sweep, is the fix for the origin.
 *
 * Writes through `dag.ts:updateSummaryContent`, the ONE sanctioned in-place mutator of
 * `summaries.content` (`memory/summary-rebuild.ts`'s nightly rewrite is its other caller).
 */
export function sweepStoredSummaryObligations(
  opts: { dryRun: boolean; agentId?: string },
): SummaryObligationSweep {
  const db = getDb();
  const rows = (opts.agentId
    ? db.prepare('SELECT id, content FROM summaries WHERE agent_id = ?').all(opts.agentId)
    : db.prepare('SELECT id, content FROM summaries').all()) as Array<{ id: string; content: string }>;

  const ids: string[] = [];
  for (const r of rows) {
    const next = annotateSummaryObligations(r.content ?? '');
    if (next === r.content) continue;
    ids.push(r.id);
    if (!opts.dryRun) updateSummaryContent(r.id, next, estimateTokens(next));
  }
  logger.info('summary obligation hygiene pass', {
    scanned: rows.length, affected: ids.length, dryRun: opts.dryRun,
  });
  return { scanned: rows.length, affected: ids.length, ids };
}
