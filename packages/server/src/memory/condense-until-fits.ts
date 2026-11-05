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
// ⚠ NOT "depth 2 is unreachable", which is what the brief and BACKLOG line 120 say; commit
// `1a894a61` carries the re-read of the removed lines. The truth is worse: `newDepth` could
// never EXCEED 2, so the DAG had a hard ceiling and a depth-2 summary could never be condensed
// again by construction. And two or three oversized summaries at ANY level never shrank at all.
// On the incident box ~86K of a 114K context was already summaries. Nothing in the tree could
// make that number go down, which is why the only honest thing the platform could say was
// "archive or reset". That card is gone; this file is what replaces it.
//
// ── WHAT "FITS" MEANS, AND WHY IT IS NOT THE GATE'S PERCENTAGE ──
// Measured, 2026-10-05: the compaction gate's total CANNOT be moved by condensation, and one
// line of `compaction.ts` is why — `summaryTokens = Math.min(rawSummaryTokens, summaryBudget)`.
// The gate already reports what the assembler will ADMIT, not what the agent HOLDS, so 86K of
// summaries against a 30K budget reports 30K whether the agent holds 86K or 31K: a loop keyed
// on it would condense for ever and never see its own progress. (That total crosses its
// threshold on the FRESH TAIL, which is another lane's problem and not one condensation can fix.)
//
// The number condensation owns is the one that cap hides: IS THE ASSEMBLER GOING TO THROW
// SUMMARIES AWAY? `budgetSummaries` drops OLDEST-FIRST to fit, so every raw token above the
// budget is an oldest summary silently leaving the agent's context. So:
//
//     FITS  ⇔  raw summary tokens ≤ what the single estimate says will be admitted
//
// Both halves come from one place: the admitted figure IS the estimate's own `summaryTokens`
// output (t87's single estimate, passed in as `measure`), and the raw figure is one indexed SUM
// over the same rows — no second model of the assembly, and not the 340KB of summary TEXT.
//
// ── THE RULE (t269): A NOTE IS MERGED INTO THE LEVEL ABOVE ONCE ──
// Until t269 a level was the whole top-level set at ANY mix of depths, each parent written at
// `max(child depth) + 1`, and a lone top note was re-summarised to half its size. So the oldest
// history went through the writer again on EVERY fold: one chain on the dev box reached depth 72
// in ~18 hours, a note claimed July 26 – October 18 and held three hours of October 18, and at
// depth 9+ about 3% of the leaves' ids, codes and amounts survived (v35-summary-quality-
// investigation.md, H5). Each single step was close to faithful; the wear was the repetition.
// Now, while the assembler would trim this agent's summaries:
//   · notes of ONE depth are batched by minFanout (per conversation, `subjectBatches`) and each
//     batch of two or more becomes ONE parent at that depth + 1, with its true min/max times;
//   · notes of different depths are never merged, and a lone note is never rewritten.
// A depth-d note written under this rule therefore stands for at least 2^d leaves (a note an older
// version left deep merges once, when a carry reaches its depth), so depth grows as log2 of the history
// and a fact passes through the writer at most that many times. A note with no peer of its depth
// stays as it is; when the view has no room for it, the summaries lane leaves the OLDEST notes out
// whole and says how many (`summaries-lane.ts`) — still stored, still reachable by recall — rather
// than squeezing them again. That is not a refusal and not a dead end: the next leaves make peers.
//
// ── THE BOUND, AND WHY THE LOOP IS FINITE PER RUN ──
// Two independent bounds, either of which ends the run:
//   1. `CONDENSE_MAX_LEVELS` levels — a `for` loop with a constant ceiling, so finiteness
//      does not rest on the summariser behaving. A backstop: a level lifts peers one depth, so
//      eight levels carry 2^8 = 256 waiting leaves to the top in one run; the next run goes on.
//   2. The caller's abort signal — the forced path's bound is the turn's patience (t140 round 6,
//      H3, which removed a 12-calls-per-run cap: a level needs as many calls as it has batches,
//      and the turn's patience, not a count, is what says the owner has waited long enough).
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
import { UNCONDENSED_KIND } from './uncondensed-head.js';
import { generateSummary, condensedSummaryInput } from './summarize.js';
import { mergeTargetTokens } from './summary-target.js';
import { modelCharsPerToken } from '../services/token-density.js';
import { recordRefusal, writersLeft, type SpanItem } from './unwritable-span.js';
import { KEPT_WHOLE_KIND } from './kept-row-view.js';
import { subjectBatches } from './summary-subject.js';
import { summaryWriterUnavailable, FORCED_YIELD_FLOOR_TOKENS } from './compaction-brakes.js';

const logger = createLogger('condense-until-fits');

/** Levels one run may climb. Three take the incident's 43 leaf summaries to one note
 *  (43→11→3→1); eight leave headroom (see THE BOUND above). */
export const CONDENSE_MAX_LEVELS = 8;

/** The stage that refused, when a run ends with nothing to show. The vocabulary of the D3
 *  defect line — a reader must be able to act on the name alone. */
export type RefusedStage =
  | 'nothing_left_to_condense'
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
        WHERE s.agent_id = @agentId
          AND s.id NOT IN (SELECT parent_id FROM summary_parents) AND s.kind NOT IN (@noteKind, @keptKind)
        GROUP BY s.depth
        ORDER BY s.depth ASC`,
    ).all({ agentId, noteKind: UNCONDENSED_KIND, keptKind: KEPT_WHOLE_KIND }) as TopLevelRow[];
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
 * EVERY TOP-LEVEL SUMMARY, SHALLOWEST FIRST — the set a level operates on (review C1).
 *
 * Built from `topLevelByDepth` + the existing per-depth reader rather than new SQL, so there is
 * still ONE implementation of "which summaries are not yet condensed" and this module cannot
 * drift from `dag.ts`. One indexed read per distinct depth, and there are at most a handful.
 */
function topLevelRows(agentId: string): Summary[] {
  const rows: Summary[] = [];
  for (const d of topLevelByDepth(agentId)) rows.push(...getLeafSummariesNotCondensed(agentId, d.depth).filter((r) => r.kind !== UNCONDENSED_KIND && r.kind !== KEPT_WHOLE_KIND));
  return rows;
}

/**
 * HOW MANY TOP-LEVEL SUMMARIES CAN BE MERGED NOW — in a batch of peers of one depth that some writer is still
 * left for (t269 fix round 2, N2: a pair every writer refused is not mergeable, so the condense-only pass
 * returns before any activity or brake). Asked by the entry point before it spends a pass.
 *
 * ⚠ THIS FUNCTION AND THE LOOP MUST AGREE (review C1): it walks the batches `condenseLevel` forms, halving a
 * batch with no writer left as the loop does, so `condensableSummaries(a) >= 2` ⇒ a pass dials a writer.
 */
export function condensableSummaries(agentId: string, opts: { modelId?: string; minFanout?: number } = {}): number {
  if (!topLevelByDepth(agentId).some((r) => r.n >= 2)) return 0;
  const byDepth = new Map<number, Summary[]>();
  for (const r of topLevelRows(agentId)) byDepth.set(r.depth, [...(byDepth.get(r.depth) ?? []), r]);
  const dialable = (batch: Summary[]): number => {
    if (batch.length < 2) return 0;
    const span: SpanItem[] = batch.map((x) => ({ id: x.id, content: x.content }));
    if (writersLeft(agentId, span, opts.modelId).length > 0) return batch.length;
    return batch.length > 2 ? halves(batch).reduce((n, h) => n + dialable(h), 0) : 0;
  };
  // A batch is at most `minFanout` notes; with none given, one batch per conversation (halved as the loop halves).
  return [...byDepth.values()].filter((peers) => peers.length >= 2)
    .flatMap((peers) => subjectBatches(peers, opts.minFanout ?? peers.length)).reduce((n, b) => n + dialable(b), 0);
}

// t144: batches are per conversation (`subjectBatches`), and the input is the one builder
// (`condensedSummaryInput`), which names each note's conversation.

/** Hand the event loop back. Each level does a synchronous all-summaries read; a deep
 *  condensation that never yields is the v3.2.3 freeze with a different cause. */
function yieldToLoop(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve); });
}

interface LevelResult { created: number; calls: number; stage: RefusedStage | null; detail: string | null; settled?: true; deepest?: number }

const halves = <T>(batch: readonly T[]): T[][] => [batch.slice(0, Math.ceil(batch.length / 2)), batch.slice(Math.ceil(batch.length / 2))];

/** A parent sits one depth above its peers, over the TRUE span of its children. */
function parentShape(batch: readonly Summary[]): { depth: number; earliestAt: string; latestAt: string } {
  return {
    depth: batch[0].depth + 1,
    earliestAt: batch.reduce((a, s) => (s.earliestAt < a ? s.earliestAt : a), batch[0].earliestAt),
    latestAt: batch.reduce((a, s) => (s.latestAt > a ? s.latestAt : a), batch[0].latestAt),
  };
}

/**
 * ONE LEVEL — every depth that holds peers lifts them one depth (t269). Reports what refused if
 * nothing was written, and `settled` when no depth held two notes (nothing to merge, nothing wrong).
 */
async function condenseLevel(
  rows: Summary[], args: CondenseArgs,
): Promise<LevelResult> {
  const { agentId, modelId, minFanout, abortSignal } = args;
  let created = 0;
  let calls = 0;
  let stage: RefusedStage | null = null;
  let detail: string | null = null;
  let deepest = 0;

  const byDepth = new Map<number, Summary[]>();
  for (const r of rows) byDepth.set(r.depth, [...(byDepth.get(r.depth) ?? []), r]);
  const batches = [...byDepth.values()].filter((peers) => peers.length >= 2).flatMap((peers) => subjectBatches(peers, minFanout));
  if (!batches.some((b) => b.length >= 2)) return { created: 0, calls: 0, stage: null, detail: null, settled: true };
  while (batches.length > 0) {
    const batch = batches.shift()!;
    if (abortSignal?.aborted) { stage ??= 'bounded_without_progress'; detail ??= 'aborted mid-level'; break; }
    // A trailing single waits for a peer of its own depth (the next leaves, or the next fold).
    if (batch.length === 1) continue;
    // t269 fix rounds 1–2 (I1, N1): a writer is not dialled over a span it could not write whole; with no
    // writer left for it the span waits (a larger one is split, so its halves are tried in turn).
    const span = batch.map((x) => ({ id: x.id, content: x.content }));
    const writers = writersLeft(agentId, span, modelId);
    if (writers.length === 0) { if (batch.length > 2) batches.unshift(...halves(batch)); continue; }
    if (summaryWriterUnavailable(agentId, modelId)) { stage = 'summary_writer_unavailable'; detail = modelId; break; }
    const shape = parentShape(batch);
    try {
      const content = condensedSummaryInput(batch);
      const args = { content, depth: shape.depth, agentId, modelId, abortSignal, spanIds: batch.map((x) => `summary:${x.id}`) };
      // A batch the writer cannot hold is halved first; a pair goes to each writer left until one holds it.
      let summary: Awaited<ReturnType<typeof generateSummary>> = { ok: false, reason: 'no writer left' };
      // v3.5 field fix 3 (owner box): every writer's own answer, so a refusal names what EACH writer said. The record
      // kept only the last one, and a small writer's "no memory free" stood for a cloud writer's verdict.
      const answers: string[] = [];
      for (const writer of batch.length > 2 ? writers.slice(0, 1) : writers) {
        summary = await generateSummary({ ...args, modelId: writer, targetTokens: mergeTargetTokens(content, batch.length, modelCharsPerToken(writer)) });
        calls += 1;
        if (!summary.ok) answers.push(`${writer}: ${summary.reason}`);
        if (summary.ok || !summary.tooBig) break;
        if (summary.noRoom) continue;   // t268: that writer cannot run now (no memory free), not its verdict on this span
        recordRefusal(agentId, writer, span);
      }
      if (!summary.ok && summary.stopped) { stage ??= 'bounded_without_progress'; detail ??= 'stopped by the owner'; break; }   // a Stop is a stop
      if (!summary.ok && summary.tooBig && !summary.noRoom) {   // t149: more than every writer tried holds (or cut twice): recorded, and a batch is halved
        if (batch.length > 2) batches.unshift(...halves(batch));
        continue;
      }
      if (!summary.ok) {
        logger.warn('SUMMARY_REFUSED condensation batch left uncondensed', {
          depth: shape.depth, parentCount: batch.length, reason: summary.reason,
        }, agentId);
        stage ??= 'summariser_refused'; detail ??= answers.length > 1 ? answers.join('; ') : summary.reason;
        continue;
      }
      createCondensedSummary(
        agentId, summary.text, summary.tokenCount, batch.map(s => s.id), shape.depth,
        shape.earliestAt, shape.latestAt,
      );
      created += 1;
      deepest = Math.max(deepest, shape.depth);
    } catch (err) {
      calls += 1;
      logger.error('Failed to create condensed summary', {
        depth: shape.depth, parentCount: batch.length, error: err instanceof Error ? err.message : String(err),
      }, agentId);
      stage ??= 'summariser_threw'; detail ??= err instanceof Error ? err.message : String(err);
    }
  }
  if (created > 0) return { created, calls, stage: null, detail: null, deepest };
  if (stage === null) return { created, calls, stage: null, detail: null, settled: true };   // every span was left whole: nothing refused
  return { created, calls, stage: stage ?? 'condensation_produced_no_parent', detail: detail ?? `${rows.length} top-level row(s)` };
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
  // ⚠ REBUILD BEFORE THE FIRST MEASUREMENT (review I1). `createLeafSummary` writes `summaries`
  // only, and both halves of the admission test read the `context_items` join — so a pass that
  // had just written ten fresh leaves measured a snapshot WITHOUT them, could declare "fits" and
  // skip the very summaries it created. The old loop read `getLeafSummariesNotCondensed` (no
  // join) and condensed them in the same pass, so that was a regression. Idempotent: one indexed
  // read and one transaction, and every caller already rebuilds after this returns.
  rebuild();
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
  let settled = false;

  for (let level = 0; level < CONDENSE_MAX_LEVELS; level += 1) {
    if (abortSignal?.aborted) break;

    const rows = topLevelRows(agentId);
    if (rows.length === 0) {
      out.refusedStage = 'nothing_left_to_condense';
      out.refusedDetail = 'this agent has no top-level summaries at all';
      break;
    }

    const res = await condenseLevel(rows, args);
    out.modelCalls += res.calls;
    if (res.settled) { settled = true; break; }
    out.condensedCreated += res.created;
    if (res.created > 0) {
      out.levels += 1;
      out.deepestDepth = Math.max(out.deepestDepth, res.deepest ?? 0);
      rebuild();
    }
    if (res.stage) { out.refusedStage = res.stage; out.refusedDetail = res.detail; break; }

    await yieldToLoop();
    const now = await args.measure();
    out.summaryTokensAfter = rawContextSummaryTokens(agentId);
    out.admittedSummaryTokens = now.summaryTokens;
    out.assembledTotalAfter = now.total;
    logger.info('Condensation level complete', {
      topLevelRows: rows.length, depths: [...new Set(rows.map(r => r.depth))],
      condensedAtLevel: res.created, modelCalls: out.modelCalls,
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
  if (out.fits || settled) { out.refusedStage = null; out.refusedDetail = null; return out; }   // settled: no depth holds two notes (header)
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
