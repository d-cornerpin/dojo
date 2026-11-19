// Which model writes an agent's summaries, and which writers wait until something changes.
// The order is the agent's own model, then the Dojo's small writer when the memory free holds it; nothing after.
// A writer that cannot write now is marked waiting (agent, writer, span key) with the reason, and is not asked
// again until one of the signals in `clearOn` fires. "Not answering" is a fact about the writer, so it is kept once
// for every agent (agent `*`). A span whose rows change has a new key, so it is asked again.

import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from '../db/connection.js';
import { createLogger } from '../logger.js';
import { contextWindowPolicy, estimateRequestTokens } from './budget.js';
import { measuredDivisorsFor } from '../costs/estimator-divisors.js';
import { isStopFenced } from '../agent/shared-state.js';
import { standardModelRowId } from '../services/local-standard.js';
import { writerAssignedSummaries } from '../services/dojo-working-memory.js';
import { MEASURED_CHARS_PER_TOKEN } from '../services/token-density.js';
import { utilityDial, utilityNumCtx, utilityOutputCap } from '../agent/utility-dial.js';
import { standardTierChain } from '../router/standing-filters.js';
import { providerBreaker, type OpenBreaker } from '../providers/billing-breaker.js';
import { createHash } from 'node:crypto';
import type { SummaryResult } from './summarize.js';

const logger = createLogger('summary-writer');

/** Abort reasons that say nothing about the writer: the owner's Stop, and the turn's patience running out. */
export const FOLD_STOPPED_BY_OWNER = 'fold-stopped-by-owner';
export const FOLD_IN_TURN_LIMIT = 'fold-in-turn-limit';
export const abortBlamesWriter = (signal?: AbortSignal): boolean =>
  !(signal?.aborted && (signal.reason === FOLD_STOPPED_BY_OWNER || signal.reason === FOLD_IN_TURN_LIMIT));

export type WaitReason = 'not-answering' | 'no-room' | 'memory-unreadable' | 'cannot-hold' | 'check-failed';
const REASONS: readonly WaitReason[] = ['not-answering', 'no-room', 'memory-unreadable', 'cannot-hold', 'check-failed'];
/** Reasons about the writer now, not about a span: a person speaking or a restart lets them go. */
const TRANSIENT: readonly WaitReason[] = ['not-answering', 'no-room', 'memory-unreadable'];
const SCOPE = 'writer_wait.';
/** The agent part of a mark about the writer itself, for every agent. */
export const EVERY_AGENT = '*';
/** What the compaction pass a summary call runs inside does at that model call, carried by the pass's own
 *  async context (compaction.ts withCompactionActivity), so overlapping passes share nothing. */
export const summaryCallStarts = new AsyncLocalStorage<() => void>();

export type Signal =
  | { kind: 'person-spoke'; agentId: string }
  | { kind: 'writer-answered'; providerKey: string; modelId?: string; summaryFor?: string }
  | { kind: 'own-model-changed'; agentId?: string }
  | { kind: 'span-written'; agentId: string; spanKeys: readonly string[] }
  | { kind: 'boot' }
  | { kind: 'memory-readable' }
  | { kind: 'memory-free'; freeTokens: number };

/** The agent's own model as stored (read afresh: the owner may change it). */
export const ownModel = (agentId: string): string | undefined => {
  try { return (getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined)?.model_id ?? undefined; } catch { return undefined; }
};

export function providerOf(modelId: string): string {
  try { return (getDb().prepare('SELECT provider_id FROM models WHERE id = ?').get(modelId) as { provider_id?: string } | undefined)?.provider_id ?? `model:${modelId}`; } catch { return `model:${modelId}`; }
}

/** The open billing breaker on this writer's provider, read without logging. */
export function writerBreaker(modelId: string | null | undefined): OpenBreaker | null {
  return modelId ? providerBreaker(providerOf(modelId)) : null;
}

/** The key of a span of rows: their ids and contents, so a span that changed is a different span. */
export function spanKeyOf(items: ReadonlyArray<{ id: string; content: string }>): string {
  const h = createHash('sha256');
  for (const it of [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) h.update(`${it.id}\0${it.content}\0`);
  return h.digest('hex').slice(0, 32);
}

/** `needs` is the window a "no room" wait waits for, kept with the mark so the sweep measures the same figure. */
export function markWaiting(agentId: string, writer: string, spanKey: string, reason: WaitReason, needs?: number): void {
  try {
    getDb().prepare('INSERT INTO healer_state (scope, key, at_ms, value) VALUES (?, ?, ?, ?) ON CONFLICT(scope, key) DO UPDATE SET at_ms = excluded.at_ms, value = excluded.value')
      .run(SCOPE + reason, `${agentId}|${writer}|${spanKey}`, Date.now(), needs === undefined ? null : String(needs));
  } catch { /* a missing mark costs one more try */ }
}

export function waiting(agentId: string, writer: string, spanKey = ''): WaitReason | null {
  try {
    const row = getDb().prepare(`SELECT scope FROM healer_state WHERE scope IN (${REASONS.map(() => '?').join(',')}) AND key = ?`)
      .get(...REASONS.map((r) => SCOPE + r), `${agentId}|${writer}|${spanKey}`) as { scope: string } | undefined;
    return row ? row.scope.slice(SCOPE.length) as WaitReason : null;
  } catch { return null; }
}

/** The one list of signals that lets a waiting writer be asked again. */
export function clearOn(signal: Signal): void {
  try {
    const db = getDb();
    const rows = (reasons: readonly WaitReason[]): Array<{ scope: string; agent: string; writer: string; span: string; key: string; needs: number }> =>
      (db.prepare(`SELECT scope, key, value FROM healer_state WHERE scope IN (${reasons.map(() => '?').join(',')})`).all(...reasons.map((r) => SCOPE + r)) as Array<{ scope: string; key: string; value: string | null }>)
        .map(({ scope, key, value }) => { const [agent, writer, ...span] = key.split('|'); return { scope, key, agent, writer, span: span.join('|'), needs: Number(value ?? 0) }; });
    const del = db.prepare('DELETE FROM healer_state WHERE scope = ? AND key = ?');
    const drop = (r: { scope: string; key: string }): void => { del.run(r.scope, r.key); };
    switch (signal.kind) {
      case 'person-spoke': rows(TRANSIENT).filter((r) => r.agent === signal.agentId || (r.agent === EVERY_AGENT && candidateOf(signal.agentId, r.writer))).forEach(drop); break;
      case 'own-model-changed': if (signal.agentId) rows(REASONS.filter((r) => r !== 'cannot-hold')).filter((r) => r.agent === signal.agentId).forEach(drop); break;   // a writer's verdict is keyed by that writer
      case 'span-written': rows(['check-failed']).filter((r) => r.agent === signal.agentId && signal.spanKeys.includes(r.span)).forEach(drop); break;
      case 'boot': rows(TRANSIENT).forEach(drop); break;
      case 'memory-readable': rows(['memory-unreadable']).forEach(drop); break;
      case 'memory-free': rows(['no-room']).filter((r) => fitsNow(r.needs, signal.freeTokens)).forEach(drop); break;
      case 'writer-answered': {
        // A summary answer frees the writer, and lets the small writer be sized again for the agent it wrote for; any
        // other answer frees it only while an agent of its order waits with no writer that can run.
        const waitsOn = (writer: string): boolean => [...wakes.keys()].some((id) => noWriterNow(id) && candidateOf(id, writer));
        const back = rows(['not-answering']).filter((r) => providerOf(r.writer) === signal.providerKey
          && (!signal.modelId || r.writer === signal.modelId) && (signal.summaryFor !== undefined || waitsOn(r.writer)));
        back.forEach(drop);
        rows(['no-room']).filter((r) => r.agent === signal.summaryFor).forEach(drop);
        if (back.length > 0) logger.info('A summary writer answered again; it is asked again', { providerKey: signal.providerKey });
        break;
      }
    }
  } catch { /* no database yet: nothing waits */ }
  for (const [id, w] of wakes) if (!noWriterNow(id)) { wakes.delete(id); w.end(); }
}

/** What a tool-less summary call to `modelId` may carry beside a system prompt: the provider boundary's own budget. */
export function summaryRoom(modelId: string, systemPromptTokens = 0): number {
  try {
    const row = getDb().prepare('SELECT context_window, max_output_tokens FROM models WHERE id = ?').get(modelId) as
      { context_window: number | null; max_output_tokens: number | null } | undefined;
    if (!row?.context_window || row.context_window <= 0) return Number.MAX_SAFE_INTEGER;
    const maxOutputTokens = row.max_output_tokens && row.max_output_tokens > 0 ? row.max_output_tokens : undefined;
    return Math.max(0, contextWindowPolicy(row.context_window, { toolPayloadTokens: 0, maxOutputTokens }).assemblyBudgetTokens - systemPromptTokens);
  } catch { return Number.MAX_SAFE_INTEGER; }
}

/** A writer is dialled only with what it can hold; `tooBig` otherwise, and nothing is recorded against it. */
export function refuseWhatTheWriterCannotHold(modelId: string, systemPrompt: string, content: string, agentId: string): SummaryResult | null {
  const divisors = measuredDivisorsFor(providerOf(modelId));
  const inputTokens = estimateRequestTokens({ proseChars: content.length, schemaChars: 0 }, divisors).tokens;
  if (inputTokens <= summaryRoom(modelId, estimateRequestTokens({ proseChars: systemPrompt.length, schemaChars: 0 }, divisors).tokens)) return null;
  logger.warn('SUMMARY_REFUSED the writer cannot hold this input; it was not dialled', { modelId, inputTokens, agentId });
  return { ok: false, reason: 'the summary writer cannot hold this input', tooBig: true };
}

/** Does a summary window of `needs` tokens fit in the memory free now? The refusal and the sweep both ask here. */
const fitsNow = (needs: number, free: number | null): boolean => free !== null && needs <= free;

/** The Healer's sweep: while some agent waits for room, the free memory is read once and each wait that fits ends. */
export async function endRoomWaitsThatFit(): Promise<void> {
  try {
    if (!getDb().prepare('SELECT 1 FROM healer_state WHERE scope = ? LIMIT 1').get(SCOPE + 'no-room')) return;
    const free = await (await import('../agent/local-model-fit.js')).freeWriterWindowTokens();
    if (free !== null) clearOn({ kind: 'memory-free', freeTokens: free });
  } catch { /* the next sweep measures again */ }
}

const NO_ROOM: SummaryResult = { ok: false, reason: 'the memory free now cannot hold a summary on the Dojo\'s writer', tooBig: true, noRoom: true };

/** The small writer as a fallback uses only the memory free now: a span too big for it is halved, and when not
 *  even a summary fits (or the free memory cannot be read) it waits for this agent with the rows whole. */
export async function refuseFallbackOverFreeMemory(
  modelId: string, systemPrompt: string, content: string, targetTokens: number, agentId: string,
): Promise<SummaryResult | null> {
  if (modelId !== standardModelRowId('writer') || writerAssignedSummaries()) return null;
  if (waiting(agentId, modelId) !== null) return NO_ROOM;
  const free = await (await import('../agent/local-model-fit.js')).freeWriterWindowTokens();
  const windowFor = (inputChars: number): number => utilityNumCtx({ inputChars, charsPerToken: MEASURED_CHARS_PER_TOKEN,
    outputTokens: utilityOutputCap(utilityDial('memory_summarize')!, targetTokens), configuredNumCtx: null });
  if (fitsNow(windowFor(systemPrompt.length + content.length), free)) return null;
  if (!fitsNow(windowFor(systemPrompt.length), free)) {
    markWaiting(agentId, modelId, '', free === null ? 'memory-unreadable' : 'no-room', windowFor(systemPrompt.length));
    logger.warn('SUMMARY_REFUSED the memory free now cannot hold a summary on the Dojo\'s writer; the span waits, rows whole', { free }, agentId);
    return NO_ROOM;
  }
  logger.warn('SUMMARY_REFUSED a fallback summary on the Dojo\'s writer needs more window than the memory free now holds; the span is halved', { free }, agentId);
  return { ok: false, reason: 'the memory free now cannot hold this span for the Dojo\'s writer', tooBig: true, forNow: true };   // the moment's memory, not the span
}

/** What a settled summary call says about its writer: an answer frees it, a failure marks it waiting for this agent.
 *  The owner's Stop is `stopped` and blames nothing; a call never dialled (`tooBig`) says nothing either. */
export function settleSummaryCall(result: SummaryResult, agentId: string, modelId: string | undefined, abortSignal?: AbortSignal): SummaryResult {
  if (!result.ok && isStopFenced(agentId)) return { ...result, stopped: true };
  if (!modelId || (!result.ok && (result.tooBig || !abortBlamesWriter(abortSignal)))) return result;
  if (result.ok) clearOn({ kind: 'writer-answered', providerKey: providerOf(modelId), summaryFor: agentId });
  else {
    markWaiting(EVERY_AGENT, modelId, '', 'not-answering');
    logger.warn('Summary writer failed; it is passed over until something changes', { modelId }, agentId);
  }
  return result;
}

/**
 * Every writer a summary of this agent MAY go to, in order: its own model (an auto agent's router pick at the
 * standard tier), then the Dojo's small writer. Nothing after it, so no fix moves work onto pricier models.
 */
export function summaryWriterCandidates(preferredModelId?: string, agentId?: string): string[] {
  const TEXT_FILTER = "m.capabilities NOT LIKE '%generation%' AND m.capabilities NOT LIKE '%embedding%' AND m.capabilities NOT LIKE '%decision%'";
  const usable = (getDb().prepare(
    `SELECT m.id AS id FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE m.is_enabled = 1 AND p.id != '__system__' AND ${TEXT_FILTER}`,
  ).all() as Array<{ id: string }>).filter((u) => summaryRoom(u.id) > 0);
  const isUsable = (id: string | undefined): id is string => !!id && usable.some((u) => u.id === id);
  const fixed = preferredModelId && preferredModelId !== 'auto' && preferredModelId !== '__auto__' ? preferredModelId : undefined;
  const own = fixed ? (isUsable(fixed) ? fixed : undefined) : standardTierChain(agentId).find(isUsable);
  return [...new Set([own, standardModelRowId('writer') ?? undefined].filter(isUsable))];
}

/** Is this writer passed over for this agent now: its provider's breaker open, or it waits? */
export function writerPassedOver(modelId: string, agentId?: string): boolean {
  return !!writerBreaker(modelId) || waiting(EVERY_AGENT, modelId) !== null || (agentId !== undefined && waiting(agentId, modelId) !== null);
}

/** The writers that may be dialled now, and for `span` when given (less those that cannot hold it). `passWriter`, a
 *  pass's own resolved writer, stays first for the rest of that pass. */
export function eligibleSummaryWriters(
  preferredModelId?: string, agentId?: string, span?: ReadonlyArray<{ id: string; content: string }>, passWriter?: string,
): string[] {
  const key = span && agentId ? spanKeyOf(span) : null;
  const candidates = summaryWriterCandidates(preferredModelId, agentId);
  const first = passWriter && candidates.includes(passWriter) ? [passWriter] : [];
  return [...new Set([...first, ...candidates.filter((w) => !writerPassedOver(w, agentId))])]
    .filter((w) => !(key !== null && waiting(agentId!, w, key) === 'cannot-hold'));
}

/** The writer for this agent now, or null when none can run. */
export const pickWriter = (agentId: string, own: string | undefined = ownModel(agentId)): string | null =>
  eligibleSummaryWriters(own, agentId)[0] ?? null;

/** Has every candidate writer said it cannot hold this exact span? */
export function spanUnwritable(agentId: string, span: ReadonlyArray<{ id: string; content: string }>): boolean {
  const key = spanKeyOf(span);
  const candidates = summaryWriterCandidates(ownModel(agentId), agentId);
  return candidates.length > 0 && candidates.every((w) => waiting(agentId, w, key) === 'cannot-hold');
}

const candidateOf = (agentId: string, writer: string): boolean => summaryWriterCandidates(ownModel(agentId), agentId).includes(writer);

function noWriterNow(agentId: string): boolean {
  const own = ownModel(agentId);
  return summaryWriterCandidates(own, agentId).length > 0 && pickWriter(agentId, own) === null;
}

const wakes = new Map<string, { at: Promise<void>; end: () => void }>();

/** Does this agent have writers, none of which can run now? Then its span waits, rows whole, and a park may wait
 *  on `whenAWriterCanRun`, which ends when a signal lets one of them run. */
export function spanWaitsForAWriter(agentId: string): boolean {
  if (!noWriterNow(agentId)) return false;
  if (!wakes.has(agentId)) {
    let end = (): void => {};
    const at = new Promise<void>((resolve) => { end = resolve; });
    wakes.set(agentId, { at, end });
  }
  return true;
}

export const whenAWriterCanRun = (agentId: string): Promise<void> => wakes.get(agentId)?.at ?? Promise.resolve();

/** Test-only reset of the in-process wakes. */
export function __resetSummaryWriterHealthForTests(): void {
  wakes.clear();
}
