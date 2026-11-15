// The one brake between compaction passes, and the one record per agent of how its passes went.
// Compaction never ends: a memory that will not shrink is a defect to report (`compaction-defect.ts`), never a
// state to live in. A pass that wins nothing backs off for a while and always lets go: on the clock, a session
// reset, a model change, a shrunken history, or the summary writer's provider answering again. A forced pass is
// bounded by the turn's patience, records its outcome on every return path, and a throw is told once.

import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { withLock } from '../db/with-lock.js';
import { isStopFenced } from '../agent/shared-state.js';
import { spanWaitsForAWriter, writerBreaker } from './writer.js';
import {
  reportCompactionDefect, noteCompactionRecovered, clearCompactionFailure, __resetCompactionFailuresForTests,
  compactionFailureReason, type CompactionFailure, type CompactionPassFacts,
} from './compaction-defect.js';

const logger = createLogger('compaction-brakes');

export const LOW_YIELD_BACKOFF_MS = 15 * 60_000;
/** Fewer rows than this outside the fresh tail cannot reclaim meaningfully. */
export const MIN_COMPACTABLE_ROWS = 6;
/** A pass reclaiming less than this counts as reclaiming nothing. */
export const FORCED_YIELD_FLOOR_TOKENS = 1_000;

interface PassResult { leafCreated: number; condensedCreated: number; tokensReclaimed: number }
/** What the door answers: the pass's counts, and when the lock was busy, which way that was settled. */
export type DoorResult = PassResult & { lockBusy?: true; byRunningPass?: boolean };

/** One record per agent. `brake`: armed by a pass that won nothing, with the facts it was armed against (any of
 *  them moving lets it go); `threw` / `braked`: what the last forced pass did; `finished`: passes under the lock. */
interface PassRecord {
  brake?: { until: number; bindsUnderForce: boolean; writerModelId: string | null; seq: number; session: string | null; model: string | null };
  threw?: boolean;
  braked?: boolean;
  finished: number;
  last?: PassResult;
}
const records = new Map<string, PassRecord>();
const recordOf = (agentId: string): PassRecord => {
  let r = records.get(agentId);
  if (!r) records.set(agentId, r = { finished: 0 });
  return r;
};

export const progressed = (r: PassResult): boolean => r.leafCreated + r.condensedCreated > 0 || r.tokensReclaimed >= FORCED_YIELD_FLOOR_TOKENS;

function brakeFacts(agentId: string): { seq: number; session: string | null; model: string | null } {
  try {
    const row = getDb().prepare('SELECT (SELECT MAX(seq) FROM messages WHERE agent_id = a.id) AS seq, a.session_started_at AS session, a.model_id AS model FROM agents a WHERE a.id = ?')
      .get(agentId) as { seq: number | null; session: string | null; model: string | null } | undefined;
    return { seq: row?.seq ?? 0, session: row?.session ?? null, model: row?.model ?? null };
  } catch { return { seq: 0, session: null, model: null }; }
}

/** The brake still on, after every way it lets go has been asked. */
function liveBrake(agentId: string): NonNullable<PassRecord['brake']> | null {
  const r = records.get(agentId);
  const b = r?.brake;
  if (!r || !b) return null;
  const now = brakeFacts(agentId);
  const why = b.until <= Date.now() ? 'backoff_expired'
    : b.writerModelId && !writerBreaker(b.writerModelId) ? 'summary_writer_is_back'
      : now.session !== b.session ? 'session_reset' : now.model !== b.model ? 'model_changed' : now.seq < b.seq ? 'history_shrank' : null;
  if (!why) return b;
  delete r.brake;
  logger.info('Compaction backoff released: this agent may compact again', { why }, agentId);
  return null;
}

/** Is the brake on? A brake a forced pass armed binds the next forced pass too; a routine one yields to force. */
export function compactionIsBraked(agentId: string, force: boolean): boolean {
  const b = liveBrake(agentId);
  if (!b || (force && !b.bindsUnderForce)) return false;
  logger.info('Compaction skipped: backing off after a pass that reclaimed nothing', {
    force, bindsUnderForce: b.bindsUnderForce, msLeft: b.until - Date.now(), failingStage: compactionFailureReason(agentId),
  }, agentId);
  return true;
}

/** Ms until a forced pass can run again (the brake that binds an emergency), else null. */
export function compactionBrakeMsLeft(agentId: string): number | null {
  const b = liveBrake(agentId);
  return b && b.bindsUnderForce ? Math.max(1, b.until - Date.now()) : null;
}

function armBackoff(agentId: string, bindsUnderForce: boolean, writerModelId: string | null): void {
  const r = recordOf(agentId);
  r.brake = {
    until: Date.now() + LOW_YIELD_BACKOFF_MS,
    bindsUnderForce: bindsUnderForce || !!r.brake?.bindsUnderForce,
    writerModelId: writerModelId ?? r.brake?.writerModelId ?? null,
    ...brakeFacts(agentId),
  };
}

/**
 * What a pass achieved, called after every pass. Progress lets the brake go (unless `facts.lowYield`: the pass ran
 * and bought almost nothing, so the routine brake arms); winning nothing arms it, against the next forced pass too
 * when this one was forced. A pass waiting for a writer is told, never braked; a cancelled pass is no outcome. A
 * named refusal, or a pass still over budget, is reported as a defect. Returns the failure note this call created.
 */
export function notePassOutcome(
  agentId: string, force: boolean, result: PassResult, facts?: CompactionPassFacts & { lowYield?: boolean }, abortSignal?: AbortSignal,
): CompactionFailure | null {
  const created = result.leafCreated + result.condensedCreated;
  const wonNothing = created === 0 && result.tokensReclaimed < FORCED_YIELD_FLOOR_TOKENS;
  const cancelled = abortSignal?.aborted === true;
  const stage = cancelled ? null : facts?.stage ?? null;
  // A summariser that compresses nothing writes one parent per level: rows created, tokens not won.
  const gainedNothing = result.tokensReclaimed < FORCED_YIELD_FLOOR_TOKENS && (created === 0 || stage !== null);
  const overBudget = facts?.assembledTokens != null && facts.budgetTokens != null && facts.assembledTokens > facts.budgetTokens;
  if (!wonNothing && !stage) {
    delete recordOf(agentId).brake;
    noteCompactionRecovered(agentId, result.tokensReclaimed);
    if (facts?.lowYield && !cancelled && !facts.waiting) armBackoff(agentId, false, null);
    return null;
  }
  if (cancelled) return null;
  if (!facts?.waiting) armBackoff(agentId, force && gainedNothing, stage === 'summary_writer_unavailable' ? facts?.modelId ?? null : null);
  if (!stage && !overBudget) return null;
  return reportCompactionDefect(agentId, stage ?? 'no_yield', facts, result);
}

/** A door that gave the agent room (an archive, a reset) clears the brake and the failure note at once. */
export function clearCompactionBackoff(agentId: string): boolean {
  const r = records.get(agentId);
  const hadBrake = !!r?.brake;
  if (r) delete r.brake;
  const hadNote = clearCompactionFailure(agentId);
  if (hadBrake || hadNote) logger.info('Compaction backoff cleared: this agent has room again', {}, agentId);
  return hadBrake || hadNote;
}

/** Is the writer's provider known dead (its breaker open)? Asked before building a chunk that cannot be sent. */
export function summaryWriterUnavailable(agentId: string, modelId: string | undefined): boolean {
  const open = writerBreaker(modelId);
  if (open) logger.warn('Summary writer unavailable: its provider is circuit-broken, no chunk will be built', { modelId, providerId: open.providerId, reason: open.reason }, agentId);
  return !!open;
}

/** A forced pass's options: aborted when the turn has waited as long as it lets the dialed model take to answer. */
export function forcedCompactionOptions(turnPatienceMs: number): { force: true; abortSignal: AbortSignal } {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), turnPatienceMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  return { force: true, abortSignal: ctl.signal };
}

export const lastForcedPass = (agentId: string): { threw: boolean; braked?: boolean } =>
  ({ threw: records.get(agentId)?.threw === true, braked: records.get(agentId)?.braked });

/** Run one forced pass and record its outcome on every return path; a throw is recorded and still reaches the caller. */
async function recordingForcedPass<T extends PassResult>(agentId: string, run: () => Promise<T>, opts: ForcedOpts): Promise<T> {
  const r = recordOf(agentId);
  const brakedBefore = compactionBrakeMsLeft(agentId) !== null;
  r.braked = brakedBefore;
  try {
    const result = await run();
    if (!brakedBefore) r.threw = false;
    if (progressed(result)) return result;
    if (!brakedBefore && compactionBrakeMsLeft(agentId) === null && !opts.abortSignal?.aborted && !isStopFenced(agentId) && !spanWaitsForAWriter(agentId)) {
      const facts = await opts.measure().catch(() => undefined);
      const stalled = facts !== undefined && facts.assembledTokens > facts.budgetTokens;
      logger.warn('a forced pass returned without recording what it bought; recorded now', { ...facts, stalled }, agentId);
      notePassOutcome(agentId, true, result, { ...facts, stage: stalled ? 'nothing_left_to_shrink' : null });
    }
    return result;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('a forced compaction pass threw', { error: detail }, agentId);
    const again = r.threw === true;
    r.threw = true;
    notePassOutcome(agentId, true, { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0 }, again ? { stage: 'summariser_threw', detail } : undefined);
    throw err;
  }
}

type ForcedOpts = { abortSignal?: AbortSignal; inTurn?: boolean; measure: () => Promise<{ assembledTokens: number; budgetTokens: number }> };

/**
 * The one door every compaction pass runs through, under the agent's lock. An unforced pass skips a busy lock. A
 * forced pass inside a turn never waits on it: it answers `lockBusy` and its caller parks until that pass lands. The
 * owner's forced pass waits, then runs its own unless the running pass made progress and the view now fits.
 */
export async function compactionDoor<T extends PassResult>(agentId: string, run: () => Promise<T>, opts?: ForcedOpts): Promise<(T & DoorResult) | undefined> {
  const lock = `compact:${agentId}`;
  const finish = async (pass: () => Promise<T>): Promise<T> => {
    const result = await pass();
    const r = recordOf(agentId);
    r.finished += 1;
    r.last = result;
    return result;
  };
  if (!opts) return withLock(lock, () => finish(run), { ifBusy: 'skip' });
  const own = (): Promise<T> => finish(() => recordingForcedPass(agentId, run, opts));
  if (opts.inTurn) return (await withLock(lock, own, { ifBusy: 'skip' })) ?? { leafCreated: 0, condensedCreated: 0, tokensReclaimed: 0, lockBusy: true } as T & DoorResult;
  const queuedAfter = recordOf(agentId).finished;
  return withLock(lock, async (): Promise<T & DoorResult> => {
    const r = recordOf(agentId);
    const borrowed = r.finished > queuedAfter && r.last && progressed(r.last) ? r.last as T : null;
    if (!borrowed) return own();
    const facts = await opts.measure().catch(() => undefined);
    if (facts && facts.assembledTokens <= facts.budgetTokens) return { ...borrowed, byRunningPass: true };
    return { ...(await own()), byRunningPass: false };
  }, { ifBusy: 'wait' });
}

export function __resetBrakesForTests(): void {
  records.clear();
  __resetCompactionFailuresForTests();
}
