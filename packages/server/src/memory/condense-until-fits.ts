// ════════════════════════════════════════════════════════════════════════════
// COMPACTION HAS NO BOTTOM: a pass either condenses further or reports the repairable defect naming the stage
// that refused (`RefusedStage`); there is no terminal "cannot compress" state.
//
// FITS means raw summary tokens (one indexed SUM) <= the estimate's own admitted `summaryTokens`, never a
// second model of the assembly; every raw token above that is an oldest summary silently leaving the context.
//
// A note is merged into the level above ONCE: notes of ONE depth are batched by minFanout (per conversation) and
// each batch of two or more becomes one parent at depth + 1; different depths never merge and a lone note is never
// rewritten, so a fact passes through the writer at most log2(history) times. A note with no peer stays, and the
// summaries lane leaves the OLDEST out whole (`summaries-lane.ts`), still stored and recallable.
//
// The loop is finite per run (`CONDENSE_MAX_LEVELS`, the caller's abort signal); hitting a bound is not a
// refusal, the next pressure continues. It yields to the event loop between levels (the reads are synchronous).
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { createCondensedSummary, getLeafSummariesNotCondensed, type Summary } from './dag.js';
import { UNCONDENSED_KIND } from './uncondensed-head.js';
import { generateSummary, condensedSummaryInput } from './summarize.js';
import { mergeTargetTokens } from './summary-target.js';
import { modelCharsPerToken } from '../services/token-density.js';
import { eligibleSummaryWriters, markWaiting, ownModel, spanKeyOf } from './writer.js';
import { KEPT_WHOLE_KIND } from './kept-row-view.js';
import { subjectBatches } from './summary-subject.js';
import { summaryWriterUnavailable, FORCED_YIELD_FLOOR_TOKENS } from './compaction-brakes.js';

const logger = createLogger('condense-until-fits');

/** Levels one run may climb: eight carry 2^8 = 256 waiting leaves to the top; the next run goes on. */
export const CONDENSE_MAX_LEVELS = 8;

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
  fits: boolean;
  /** Set ONLY when this run ends with nothing to show; the caller's pass outcome (`passFacts`) reports it. */
  refusedStage: RefusedStage | null;
  refusedDetail: string | null;
  /** RAW tokens of the summaries in the agent's context (not the admitted figure), before and after. */
  summaryTokensBefore: number;
  summaryTokensAfter: number;
  admittedSummaryTokens: number;
  assembledTotalAfter: number;
  deepestDepth: number;
}

/** What the caller's single estimate answers; structural, so this module needs no import from `compaction.ts`. */
export interface AdmissionEstimate { total: number; summaryTokens: number }

export interface CondenseArgs {
  agentId: string;
  modelId: string;
  minFanout: number;
  /** THE SINGLE ESTIMATE, the caller's own, so this module adds no second opinion. */
  measure: () => Promise<AdmissionEstimate>;
  /** `rebuildContextItems`, injected: a new parent is only in the assembly once the context items are rebuilt. */
  rebuild: () => void;
  abortSignal?: AbortSignal;
}

interface TopLevelRow { depth: number; n: number; maxTok: number }

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

/** What this agent's summaries cost: one indexed SUM over the rows the assembler reads (`context_items`), not
 *  `getContextSummaries()`, which pulls every summary's TEXT synchronously on each level. */
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

/** Every top-level summary, shallowest first: the set a level operates on (one implementation in `dag.ts`). */
function topLevelRows(agentId: string): Summary[] {
  const rows: Summary[] = [];
  for (const d of topLevelByDepth(agentId)) rows.push(...getLeafSummariesNotCondensed(agentId, d.depth).filter((r) => r.kind !== UNCONDENSED_KIND && r.kind !== KEPT_WHOLE_KIND));
  return rows;
}

/**
 * How many top-level summaries can be merged now: batches of peers of one depth that some writer is still left for.
 * MUST agree with `condenseLevel`: it walks the same batches and halves one with no writer left as the loop does,
 * so `condensableSummaries(a) >= 2` means a pass dials a writer.
 */
export function condensableSummaries(agentId: string, opts: { modelId?: string; minFanout?: number } = {}): number {
  if (!topLevelByDepth(agentId).some((r) => r.n >= 2)) return 0;
  const byDepth = new Map<number, Summary[]>();
  for (const r of topLevelRows(agentId)) byDepth.set(r.depth, [...(byDepth.get(r.depth) ?? []), r]);
  const dialable = (batch: Summary[]): number => {
    if (batch.length < 2) return 0;
    if (eligibleSummaryWriters(ownModel(agentId), agentId, batch, opts.modelId).length > 0) return batch.length;
    return batch.length > 2 ? halves(batch).reduce((n, h) => n + dialable(h), 0) : 0;
  };
  return [...byDepth.values()].filter((peers) => peers.length >= 2)
    .flatMap((peers) => subjectBatches(peers, opts.minFanout ?? peers.length)).reduce((n, b) => n + dialable(b), 0);
}


function yieldToLoop(): Promise<void> {
  return new Promise<void>(resolve => { setImmediate(resolve); });
}

interface LevelResult { created: number; calls: number; stage: RefusedStage | null; detail: string | null; settled?: true; deepest?: number }

const halves = <T>(batch: readonly T[]): T[][] => [batch.slice(0, Math.ceil(batch.length / 2)), batch.slice(Math.ceil(batch.length / 2))];

function parentShape(batch: readonly Summary[]): { depth: number; earliestAt: string; latestAt: string } {
  return {
    depth: batch[0].depth + 1,
    earliestAt: batch.reduce((a, s) => (s.earliestAt < a ? s.earliestAt : a), batch[0].earliestAt),
    latestAt: batch.reduce((a, s) => (s.latestAt > a ? s.latestAt : a), batch[0].latestAt),
  };
}

/** One level: every depth that holds peers lifts them one depth. Reports what refused if nothing was written,
 *  and `settled` when no depth held two notes. */
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
    if (batch.length === 1) continue;
    // A writer is not dialled over a span it could not write whole; with no writer left the span waits (a larger
    // one is split, so its halves are tried in turn).
    const writers = eligibleSummaryWriters(ownModel(agentId), agentId, batch, modelId);
    if (writers.length === 0) { if (batch.length > 2) batches.unshift(...halves(batch)); continue; }
    if (summaryWriterUnavailable(agentId, modelId)) { stage = 'summary_writer_unavailable'; detail = modelId; break; }
    const shape = parentShape(batch);
    try {
      const content = condensedSummaryInput(batch);
      const args = { content, depth: shape.depth, agentId, modelId, abortSignal, spanIds: batch.map((x) => `summary:${x.id}`) };
      let summary: Awaited<ReturnType<typeof generateSummary>> = { ok: false, reason: 'no writer left' };
      // Every writer's own answer, so a refusal names what EACH writer said, not just the last.
      const answers: string[] = [];
      for (const writer of batch.length > 2 ? writers.slice(0, 1) : writers) {
        summary = await generateSummary({ ...args, modelId: writer, targetTokens: mergeTargetTokens(content, batch.length, modelCharsPerToken(writer)) });
        calls += 1;
        if (!summary.ok) answers.push(`${writer}: ${summary.reason}`);
        if (summary.ok || !summary.tooBig) break;
        if (summary.noRoom) continue;   // that writer cannot run now (no memory free), not its verdict on this span
        markWaiting(agentId, writer, spanKeyOf(batch), 'cannot-hold');
      }
      if (!summary.ok && summary.stopped) { stage ??= 'bounded_without_progress'; detail ??= 'stopped by the owner'; break; }   // a Stop is a stop
      if (!summary.ok && summary.tooBig && !summary.noRoom) {   // more than every writer tried holds: recorded, and a batch is halved
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

/** Condense until the assembler will admit every summary; when nothing is shown, report WHICH STAGE refused. */
export async function condenseUntilFits(args: CondenseArgs): Promise<CondensationOutcome> {
  const { agentId, rebuild, abortSignal } = args;
  // REBUILD BEFORE THE FIRST MEASUREMENT: `createLeafSummary` writes `summaries` only and both halves of the
  // admission test read the `context_items` join, so without it a pass that just wrote fresh leaves could declare
  // "fits" and skip them. Idempotent.
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

  if (out.condensedCreated > 0) {
    const last = await args.measure();
    out.summaryTokensAfter = rawContextSummaryTokens(agentId);
    out.admittedSummaryTokens = last.summaryTokens;
    out.assembledTotalAfter = last.total;
    out.fits = out.summaryTokensAfter <= last.summaryTokens;
  }
  if (out.fits || settled) { out.refusedStage = null; out.refusedDetail = null; return out; }   // settled: no depth holds two notes
  // A run that reclaimed real tokens before running out of levels or patience refuses nothing; the floor is the
  // brake's own (`FORCED_YIELD_FLOOR_TOKENS`), so the two cannot disagree about what "gained nothing" means.
  const reclaimed = out.summaryTokensBefore - out.summaryTokensAfter;
  if (reclaimed >= FORCED_YIELD_FLOOR_TOKENS) { out.refusedStage = null; out.refusedDetail = null; return out; }
  out.refusedStage ??= 'bounded_without_progress';
  out.refusedDetail ??= `${out.levels} level(s), ${out.modelCalls} model call(s), ${reclaimed} tokens reclaimed`;
  return out;
}
