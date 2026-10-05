// ════════════════════════════════════════════════════════════════════════════
// COMPACTION HAS NO BOTTOM (OR-COMPACT-1)
//
// ── THE RULING THIS FILE IS ──
// The owner, 2026-10-02: *"there is never a reason for compaction to end… an agent's
// memory can always compress. This is the entire point of compaction. If compaction
// fails for a different reason, that is something that needs to be repaired."*
//
// So there is no terminal "this memory cannot compress" state anywhere in the engine any
// more. What used to be one is now one of two things: more condensation, or a
// repairable-defect report naming the stage that refused.
//
// ── WHAT WAS ACTUALLY BROKEN, in two numbers ──
// `runCondensation` was called with `DEFAULTS.incrementalMaxDepth` = 1 and skipped any level
// holding fewer than `condensedMinFanout` = 4 waiting summaries.
//
// ⚠ STATED PRECISELY, BECAUSE THE SHORT VERSION OF IT IS WRONG. The dispatch brief and BACKLOG
// line 120 both say "depth 2 is unreachable". Re-read at main `eef45913`: the loop was
// `for (depth = 0; depth <= maxDepth; depth++)` writing parents at `depth + 1`, so with maxDepth
// 1 it wrote depths 1 AND 2 — a depth-1 level holding ≥4 waiting summaries DID reach the depth-2
// prompt. What was true is worse: `newDepth` could never EXCEED 2, so the DAG had a hard ceiling
// and a depth-2 summary could never be condensed again by construction — two oversized depth-2
// summaries were a permanent dead end at any pressure. `deep condensation (depth ${depth})`
// could therefore only ever print 2, and everything that prompt says about depth 3 and beyond
// was unreachable prose. And two or three oversized summaries at ANY level never shrank at all,
// which is the incident's own shape.
// On the incident box ~86K of a 114K context was already summaries. Nothing in the tree could
// make that number go down, which is why the only honest thing the platform could say was
// "archive or reset". That card is gone; this file is what replaces it.
//
// ── WHAT "FITS" MEANS, AND WHY IT IS NOT THE GATE'S PERCENTAGE ──
// Measured, 2026-10-05: the compaction gate's own total CANNOT be moved by condensation,
// and reading `compaction.ts` is enough to see why —
//     summaryTokens = Math.min(rawSummaryTokens, summaryBudget)
// The gate already reports what the assembler will ADMIT, not what the agent holds. So an
// agent with 86K of summaries against a 30K summary budget is reported at 30K whether it
// has 86K or 31K, and a loop keyed on that number would condense for ever and never see
// its own progress. (The gate's total goes over threshold on the FRESH TAIL, which is a
// different lane's problem and not one condensation can fix.)
//
// The number condensation DOES own is the one that cap is hiding: **is the assembler going
// to throw summaries away?** `budgetSummaries` drops OLDEST-FIRST to fit, so every token
// of `rawSummaryTokens` above the budget is an oldest summary silently leaving the agent's
// context — the real harm, and exactly what merging fixes. So:
//
//     FITS  ⇔  raw summary tokens ≤ what the single estimate says will be admitted
//
// Both halves come from one place: the admitted figure is the estimate's own
// `summaryTokens` output (t87's single estimate, passed in by the caller as `measure`), and
// the raw figure is one indexed SUM over the same rows — not a second model of the
// assembly, and not the 340KB of summary TEXT the estimate reads.
//
// ── THE RULE ──
// While the assembler would trim this agent's summaries, condense the SHALLOWEST level that
// still has top-level summaries, and climb:
//   · fanout ≥ minFanout → batches of minFanout, exactly as before (unchanged behaviour for
//     the only case that already worked);
//   · fanout 2 … minFanout-1 → ONE parent (the case the old floor refused);
//   · fanout 1 → re-summarise that one summary to a STRICTLY SMALLER target, keeping the old
//     row unless the new one really is smaller.
// A trailing batch of ONE is left alone: it joins the parents this level just made and is
// condensed with them next level, which costs one model call instead of two.
//
// ── THE BOUND, AND WHY THE LOOP IS FINITE PER RUN ──
// Three independent bounds, any one of which ends the run:
//   1. `CONDENSE_MAX_LEVELS` levels — a `for` loop with a constant ceiling, so finiteness
//      does not rest on the summariser behaving.
//   2. `CONDENSE_MAX_CALLS_PER_RUN` model calls. Every level is model calls, and one turn
//      may not spend an unbounded number of them (t87's "emergency means FIRST, not
//      INFINITE", carried forward).
//   3. The caller's abort signal — the forced path's three-minute wall clock.
// Hitting a bound is NOT a dead end: a run that made real progress returns `fits:false`
// with no refusal, the brake is not armed, and the next pressure continues where this one
// stopped. That is what "compaction never ends" means operationally.
//
// ── ONE ESTIMATE PER LEVEL, AND WHY THAT IS NOT A REGRESSION OF t87 LAYER 2 ──
// t87 removed THREE estimates computed over IDENTICAL rows in one pass. This file asks for one
// per level, and a level only happens after a summary row has been written — so the facts the
// estimate is keyed on have genuinely moved and the answer is genuinely different. And because
// that read is synchronous SQLite, the loop yields to the event loop between levels: the
// dashboard and the stop button must survive a deep condensation (the v3.2.3 incident).
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { createCondensedSummary, getLeafSummariesNotCondensed, type Summary } from './dag.js';
import { generateSummary } from './summarize.js';
import { summaryWriterUnavailable, FORCED_YIELD_FLOOR_TOKENS } from './compaction-brakes.js';

const logger = createLogger('condense-until-fits');

/** Levels one run may climb. Seven takes the incident's 43 leaf summaries to a single
 *  floor-sized one (43→11→3→1, then four halvings); eight leaves a level of headroom. */
export const CONDENSE_MAX_LEVELS = 8;

/** Model calls one run may spend. The incident's first level is 11 batches of four, so
 *  twelve lets its worst level finish inside one turn and stops there. */
export const CONDENSE_MAX_CALLS_PER_RUN = 12;

/** A lone summary is re-asked for half of what it currently costs… */
export const CONDENSE_SHRINK_FACTOR = 0.5;
/** …down to this floor, below which a summary is not a summary any more. Reaching it is
 *  reported as a defect (D3) rather than as a terminal state: if the assembler would still
 *  trim with every summary at the floor, something else is wrong and the engine says so
 *  instead of telling the owner to archive their conversation. */
export const CONDENSE_MIN_TARGET_TOKENS = 500;

/** The stage that refused, when a run ends with nothing to show. The vocabulary of the D3
 *  defect line — a reader must be able to act on the name alone. */
export type RefusedStage =
  | 'nothing_left_to_condense'
  | 'single_summary_at_floor'
  | 'single_summary_did_not_shrink'
  | 'summary_writer_unavailable'
  | 'summariser_refused'
  | 'summariser_threw'
  | 'condensation_produced_no_parent'
  | 'bounded_without_progress';

export interface CondensationOutcome {
  condensedCreated: number;
  levels: number;
  modelCalls: number;
  /** True when the assembler will admit every summary this agent holds. */
  fits: boolean;
  /** Set ONLY when this run ends with nothing to show. */
  refusedStage: RefusedStage | null;
  refusedDetail: string | null;
  /** Raw tokens of the summaries in this agent's context, before and after this run. */
  summaryTokensBefore: number;
  summaryTokensAfter: number;
  /** What the single estimate says the assembler will admit of them. */
  admittedSummaryTokens: number;
  /** The gate's own assembled total at the end, for the defect line's numbers. */
  assembledTotalAfter: number;
  deepestDepth: number;
}

/** What the caller's single estimate answers. Structural, so this module needs no import
 *  from `compaction.ts` and cannot create a cycle with it. */
export interface AdmissionEstimate { total: number; summaryTokens: number }

export interface CondenseArgs {
  agentId: string;
  /** The summary-WRITER model, already resolved by the caller. */
  modelId: string;
  minFanout: number;
  /** The ceiling for a condensed summary's size; a lone summary is asked for less. */
  targetTokens: number;
  /** THE SINGLE ESTIMATE. The caller passes its own, so this module adds no second opinion
   *  about what the assembler will produce. */
  measure: () => Promise<AdmissionEstimate>;
  /** `rebuildContextItems`, injected: a new parent is only in the assembly once the context
   *  items are rebuilt, and that function is the caller's. */
  rebuild: () => void;
  abortSignal?: AbortSignal;
}

interface TopLevelRow { depth: number; n: number; maxTok: number }

/** The top-level (not-yet-condensed) summaries, by depth, shallowest first. */
function topLevelByDepth(agentId: string): TopLevelRow[] {
  try {
    return getDb().prepare(
      `SELECT s.depth AS depth, COUNT(*) AS n, COALESCE(MAX(s.token_count), 0) AS maxTok
         FROM summaries s
        WHERE s.agent_id = ?
          AND s.id NOT IN (SELECT parent_id FROM summary_parents)
        GROUP BY s.depth
        ORDER BY s.depth ASC`,
    ).all(agentId) as TopLevelRow[];
  } catch {
    return [];
  }
}

/**
 * WHAT THIS AGENT'S SUMMARIES ACTUALLY COST, as one indexed aggregate over the rows the
 * assembler will read (`context_items`, the same join `getContextSummaries` uses). Deliberately
 * NOT `getContextSummaries().reduce(...)`: that pulls every summary's TEXT out of SQLite
 * synchronously — 340KB on the incident box — and re-reading it per level is precisely the
 * event-loop cost t87 layer 2 removed. A SUM of a column is sub-millisecond.
 */
export function rawContextSummaryTokens(agentId: string): number {
  try {
    const row = getDb().prepare(
      `SELECT COALESCE(SUM(s.token_count), 0) AS t
         FROM summaries s
         JOIN context_items ci ON ci.item_id = s.id
        WHERE ci.agent_id = ? AND ci.item_type = 'summary'`,
    ).get(agentId) as { t: number } | undefined;
    return row?.t ?? 0;
  } catch {
    return 0;
  }
}

/**
 * CAN THIS AGENT'S SUMMARIES STILL SHRINK? Asked by the entry point BEFORE it decides a pass
 * is pointless, which is the question the deleted terminal latch answered backwards: summaries
 * over budget is the CASE FOR condensation, not proof it cannot help.
 *
 * Two or more top-level summaries always can (they merge). A single one can while it is above
 * the floor. Zero cannot, and that is a defect to report, not a card to show.
 */
export function condensableSummaries(agentId: string): number {
  const rows = topLevelByDepth(agentId);
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  if (total >= 2) return total;
  if (total === 1 && rows[0].maxTok > CONDENSE_MIN_TARGET_TOKENS) return 1;
  return 0;
}

/** The target for a lone summary: strictly less than it costs now, never below the floor. */
export function shrinkTarget(currentTokens: number, ceilingTokens: number): number {
  const halved = Math.floor(currentTokens * CONDENSE_SHRINK_FACTOR);
  return Math.max(CONDENSE_MIN_TARGET_TOKENS, Math.min(ceilingTokens, halved));
}

function batchesOf<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

function summaryInput(batch: readonly Summary[]): string {
  return batch.map(s =>
    `<summary id="${s.id}" depth="${s.depth}" earliest="${s.earliestAt}" latest="${s.latestAt}">\n${s.content}\n</summary>`,
  ).join('\n\n');
}

/** Hand the event loop back. Each level does a synchronous all-summaries read; a deep
 *  condensation that never yields is the v3.2.3 freeze with a different cause. */
function yieldToLoop(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve); });
}

interface LevelResult { created: number; calls: number; stage: RefusedStage | null; detail: string | null }

/**
 * ONE LEVEL. Condenses the summaries handed to it into depth+1 parents and reports what
 * refused if nothing was written.
 *
 * The three fanout arms are the deliverable: ≥ minFanout is the pre-existing behaviour,
 * 2…minFanout-1 is the case the old floor silently refused, and 1 is the re-summarise.
 */
async function condenseLevel(
  rows: Summary[], depth: number, args: CondenseArgs, callBudget: number,
): Promise<LevelResult> {
  const { agentId, modelId, minFanout, targetTokens, abortSignal } = args;
  let created = 0;
  let calls = 0;
  let stage: RefusedStage | null = null;
  let detail: string | null = null;

  // THE LONE SUMMARY. Nothing to merge it with, so the compression asked for is its own size
  // halved — and the old row is kept unless the new one is genuinely smaller, because swapping
  // a summary for an equally large one is the zero-yield pass this file exists to report.
  if (rows.length === 1) {
    const only = rows[0];
    if (only.tokenCount <= CONDENSE_MIN_TARGET_TOKENS) {
      return { created: 0, calls: 0, stage: 'single_summary_at_floor', detail: `${only.tokenCount} tokens` };
    }
    const target = shrinkTarget(only.tokenCount, targetTokens);
    if (summaryWriterUnavailable(agentId, modelId)) {
      return { created: 0, calls: 0, stage: 'summary_writer_unavailable', detail: modelId };
    }
    try {
      const summary = await generateSummary({
        content: summaryInput([only]), depth: depth + 1, targetTokens: target, agentId, modelId, abortSignal,
      });
      calls += 1;
      if (!summary.ok) return { created: 0, calls, stage: 'summariser_refused', detail: summary.reason };
      if (summary.tokenCount >= only.tokenCount) {
        return { created: 0, calls, stage: 'single_summary_did_not_shrink', detail: `${only.tokenCount} → ${summary.tokenCount}` };
      }
      createCondensedSummary(agentId, summary.text, summary.tokenCount, [only.id], depth + 1, only.earliestAt, only.latestAt);
      return { created: 1, calls, stage: null, detail: null };
    } catch (err) {
      return { created: 0, calls: calls + 1, stage: 'summariser_threw', detail: err instanceof Error ? err.message : String(err) };
    }
  }

  for (const batch of batchesOf(rows, minFanout)) {
    if (calls >= callBudget) break;
    if (abortSignal?.aborted) { stage ??= 'bounded_without_progress'; detail ??= 'aborted mid-level'; break; }
    // A trailing single waits for the next level rather than paying a call to become itself.
    if (batch.length === 1) continue;
    if (summaryWriterUnavailable(agentId, modelId)) { stage = 'summary_writer_unavailable'; detail = modelId; break; }
    try {
      const summary = await generateSummary({
        content: summaryInput(batch), depth: depth + 1, targetTokens, agentId, modelId, abortSignal,
      });
      calls += 1;
      if (!summary.ok) {
        logger.warn('SUMMARY_REFUSED condensation batch left uncondensed', {
          depth: depth + 1, parentCount: batch.length, reason: summary.reason,
        }, agentId);
        stage ??= 'summariser_refused'; detail ??= summary.reason;
        continue;
      }
      createCondensedSummary(
        agentId, summary.text, summary.tokenCount, batch.map(s => s.id), depth + 1,
        batch[0].earliestAt, batch[batch.length - 1].latestAt,
      );
      created += 1;
    } catch (err) {
      calls += 1;
      logger.error('Failed to create condensed summary', {
        depth: depth + 1, parentCount: batch.length, error: err instanceof Error ? err.message : String(err),
      }, agentId);
      stage ??= 'summariser_threw'; detail ??= err instanceof Error ? err.message : String(err);
    }
  }
  if (created > 0) return { created, calls, stage: null, detail: null };
  return { created, calls, stage: stage ?? 'condensation_produced_no_parent', detail: detail ?? `depth ${depth}` };
}

/**
 * CONDENSE UNTIL THE ASSEMBLER WILL ADMIT EVERY SUMMARY — the replacement for
 * `runCondensation(…, maxDepth)`.
 *
 * Returns what it did and, when it ends with nothing to show, WHICH STAGE refused. The caller
 * turns that into the defect line; this module shows no card and never declares a memory
 * incompressible, because no such state exists any more.
 */
export async function condenseUntilFits(args: CondenseArgs): Promise<CondensationOutcome> {
  const { agentId, rebuild, abortSignal } = args;
  const first = await args.measure();
  const rawBefore = rawContextSummaryTokens(agentId);
  const out: CondensationOutcome = {
    condensedCreated: 0, levels: 0, modelCalls: 0,
    fits: rawBefore <= first.summaryTokens,
    refusedStage: null, refusedDetail: null,
    summaryTokensBefore: rawBefore, summaryTokensAfter: rawBefore,
    admittedSummaryTokens: first.summaryTokens, assembledTotalAfter: first.total, deepestDepth: 0,
  };
  if (out.fits) return out;

  for (let level = 0; level < CONDENSE_MAX_LEVELS; level += 1) {
    if (abortSignal?.aborted) break;
    if (out.modelCalls >= CONDENSE_MAX_CALLS_PER_RUN) break;

    const byDepth = topLevelByDepth(agentId);
    if (byDepth.length === 0) {
      out.refusedStage = 'nothing_left_to_condense';
      out.refusedDetail = 'this agent has no summaries at all';
      break;
    }
    const depth = byDepth[0].depth;
    const rows = getLeafSummariesNotCondensed(agentId, depth);
    if (rows.length === 0) {
      out.refusedStage = 'nothing_left_to_condense';
      out.refusedDetail = `depth ${depth} census and read disagree`;
      break;
    }

    const res = await condenseLevel(rows, depth, args, CONDENSE_MAX_CALLS_PER_RUN - out.modelCalls);
    out.modelCalls += res.calls;
    out.condensedCreated += res.created;
    if (res.created > 0) {
      out.levels += 1;
      out.deepestDepth = Math.max(out.deepestDepth, depth + 1);
      rebuild();
    }
    if (res.stage) { out.refusedStage = res.stage; out.refusedDetail = res.detail; break; }

    await yieldToLoop();
    const now = await args.measure();
    out.summaryTokensAfter = rawContextSummaryTokens(agentId);
    out.admittedSummaryTokens = now.summaryTokens;
    out.assembledTotalAfter = now.total;
    logger.info('Condensation level complete', {
      depth, newDepth: depth + 1, condensedAtLevel: res.created, modelCalls: out.modelCalls,
      summaryTokens: out.summaryTokensAfter, admittedSummaryTokens: now.summaryTokens,
    }, agentId);
    if (out.summaryTokensAfter <= now.summaryTokens) { out.fits = true; out.refusedStage = null; return out; }
  }

  // The last word on this run: re-read if a level wrote anything after the most recent
  // measurement, then decide whether this run has anything to show.
  if (out.condensedCreated > 0) {
    const last = await args.measure();
    out.summaryTokensAfter = rawContextSummaryTokens(agentId);
    out.admittedSummaryTokens = last.summaryTokens;
    out.assembledTotalAfter = last.total;
    out.fits = out.summaryTokensAfter <= last.summaryTokens;
  }
  if (out.fits) { out.refusedStage = null; out.refusedDetail = null; return out; }
  // ⚠ A BOUND IS NOT A REFUSAL. A run that reclaimed real tokens and then ran out of levels,
  // calls or wall clock has nothing to report: the brake stays off and the next pressure
  // continues from where this one stopped. Only a run with nothing to show is the D3 defect,
  // and the floor is the brake's own (`FORCED_YIELD_FLOOR_TOKENS`) so the two mechanisms
  // cannot disagree about what "gained nothing" means.
  const reclaimed = out.summaryTokensBefore - out.summaryTokensAfter;
  if (reclaimed >= FORCED_YIELD_FLOOR_TOKENS) { out.refusedStage = null; out.refusedDetail = null; return out; }
  out.refusedStage ??= 'bounded_without_progress';
  out.refusedDetail ??= `${out.levels} level(s), ${out.modelCalls} model call(s), ${reclaimed} tokens reclaimed`;
  return out;
}
