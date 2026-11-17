// AN HONEST STOP: a parked turn (`budget_stop` or `no_model_fits`, with nothing broken) waits for
// the real outside event that clears its condition. The lock's record shape: `honest-stop-lock.ts`.
// A park is status `paused` plus the tag at the head of last_error; any other pause overwrites the
// tag, so release never lifts a pause that is not ours.

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import { markTurnDied } from './turn-record.js';
import { sendAlert } from '../../services/imessage-bridge.js';
import { tellOwner, ownerConditionCleared, wordsOf } from '../../healer/owner-notices.js';
import type { AgentTurnState } from './state.js';
import { createLogger } from '../../logger.js';
import { chatLine, noteWaitingOfParked, tellCannotRun } from './honest-stop-notes.js';
import { AgentError } from '../errors.js';
import { setAgentStatus } from '../agent-status.js';
import { SystemPromptTooLargeError } from '../../memory/budget.js';
import { exceededBudget, WALL_ESTIMATE_USD, budgetStopToTell, type ExceededBudget } from '../../costs/budget.js';
import { routedCandidateCosts } from '../../router/selector.js';
import { limitTurnsAway } from './limit-turns-away.js';
import type { PromptTurnContext } from '../../prompt/assembler.js';
import { honestStopWords, type HonestStopKind } from './error-format.js';
import { noFitOwnerWords } from '../../router/router-window-words.js';
import { lockTag, parkedAgents, parkedCauseOf, parkedForFreeDown, BUDGET_STOP_CODE, NO_MODEL_FITS_CODE, FREE_FALLBACK_DOWN_CODE, FREE_DOWN_TAG } from './honest-stop-lock.js';

const logger = createLogger('honest-stop');

export interface HonestStop {
  kind: HonestStopKind;
  words: string;
  budget: ExceededBudget | null;
  /** Set when the limit is reached and no free model answered; the park records it. */
  freeDown?: boolean;
}

function causeChain(error: unknown): unknown[] {
  const links: unknown[] = [];
  for (let e: unknown = error; e !== undefined && e !== null && links.length < 6; e = (e as { cause?: unknown }).cause) links.push(e);
  return links;
}

/** THE ONE BUDGET TRUTH: what spending limit stops this agent right now? A pinned agent: the wall
 *  (`WALL_ESTIMATE_USD`, agent/model.ts); a routed agent only when EVERY reachable model is over by its
 *  OWN request estimate, so a park, a classification and a release agree with the router itself. */
export function budgetStopFor(agentId: string): ExceededBudget | null {
  const row = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
  if (row?.model_id !== 'auto') return exceededBudget(agentId, WALL_ESTIMATE_USD);
  const costs = routedCandidateCosts().sort((a, b) => a - b);
  const over = costs.map((c) => exceededBudget(agentId, c));
  return costs.length > 0 && over.every((o) => o !== null) ? over[0] : null;
}

/** Whether a model of the agent's own can hold its instructions and tools right now (the fit). */
export async function agentFits(agentId: string): Promise<boolean> {
  const [{ anOwnModelHolds }, { measureAgentToolPayloadTokens }] = await Promise.all([
    import('./steps/call-llm/reassemble-for-fit.js'), import('../../tools/tool-docs.js'),
  ]);
  return anOwnModelHolds(agentId, await measureAgentToolPayloadTokens(agentId), undefined as unknown as PromptTurnContext);
}

function budgetStop(agentId: string, freeDown = false): HonestStop {
  const budget = budgetStopFor(agentId) ?? (freeDown ? exceededBudget(agentId, WALL_ESTIMATE_USD) : null);
  return {
    kind: 'budget_stop',
    budget,
    freeDown,
    words: honestStopWords('budget_stop', { ...(budget
      ? { scope: budget.scope, period: budget.period, spendUsd: budget.spend, limitUsd: budget.limitUsd } : {}), freeDown }),
  };
}

const noFit = (agentId: string): HonestStop => ({ kind: 'no_model_fits', words: noFitOwnerWords(agentId), budget: null });   // an auto agent's names the router window

async function pinnedWindowRefused(agentId: string, refusalWindow: number): Promise<boolean> {
  const row = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
  if (!row?.model_id) return true;
  const { getContextWindow } = await import('../model.js');
  return getContextWindow(row.model_id) === refusalWindow;
}

export async function classifyHonestStop(agentId: string, error: unknown): Promise<HonestStop | null> {
  const links = causeChain(error);
  const codes = links.map((e) => (e instanceof AgentError ? e.code : undefined));
  if (codes.includes(FREE_FALLBACK_DOWN_CODE)) return budgetStop(agentId, true);
  if (codes.includes(BUDGET_STOP_CODE) || codes.includes('BUDGET_EXCEEDED')) return budgetStop(agentId);
  if (codes.includes(NO_MODEL_FITS_CODE)) return noFit(agentId);

  const refusal = links.find((e): e is SystemPromptTooLargeError => e instanceof SystemPromptTooLargeError);
  if (refusal) {
    const row = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
    if (!row?.model_id) return null;
    // The bare refusal here is the FIRST assembly's (per-pick refusals have their own exit, call-llm).
    if (row.model_id === 'auto') return (await agentFits(agentId)) ? null : noFit(agentId);
    // The pinned model holds the agent, and the limit sent the call to a free stand-in that cannot.
    if (budgetStopFor(agentId) && !(await pinnedWindowRefused(agentId, refusal.policy.contextWindow))) return budgetStop(agentId);
    return noFit(agentId);
  }
  return null;
}

/** The lock is already on, for this kind: the owner was told when it was put there. */
export function stopAlreadyTold(agentId: string, kind: HonestStopKind): boolean {
  try {
    const row = getDb().prepare('SELECT last_error FROM agents WHERE id = ?').get(agentId) as { last_error: string | null } | undefined;
    return !!row?.last_error && row.last_error.startsWith(lockTag(kind));
  } catch { return false; }
}

export function parkAgent(agentId: string, stop: HonestStop): void {
  const lastError = `${lockTag(stop.kind)} ${stop.freeDown ? `${FREE_DOWN_TAG} ` : ''}${stop.words}`.slice(0, 400);
  setAgentStatus(agentId, 'paused', { lastError });
  // The live frame carries the true cause, so an open dashboard needs no reload.
  broadcast({ type: 'agent:status', agentId, status: 'paused', parkedCause: parkedCauseOf('paused', lastError) ?? undefined });
}

async function wake(agentId: string): Promise<void> {
  try {
    const { getAgentRuntime } = await import('../runtime.js');
    getAgentRuntime().handleMessage(agentId, '').catch((err: unknown) => {
      logger.warn('honest stop: the wake after release failed', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
    });
  } catch (err) {
    logger.warn('honest stop: could not wake after release', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
  }
}

/** Lift the lock on every parked agent whose OWN condition no longer stands (every release re-checks
 *  first), wake it so the parked message is answered once, and write with NO await after the check:
 *  a concurrent release or owner pause that landed during the async check is never written over. */
export async function releaseHonestStops(kind: HonestStopKind, opts: { agentId?: string; onModelsChange?: boolean } = {}): Promise<string[]> {
  const released: string[] = [];
  for (const id of parkedAgents(kind, opts.agentId)) {
    const freeDown = kind === 'budget_stop' && parkedForFreeDown(id);   // lifted by the limit moving (the park's own predicate) or a model/tier change
    if (opts.onModelsChange && !freeDown) continue;
    const stands = freeDown ? !opts.onModelsChange && limitTurnsAway(id)
      : kind === 'budget_stop' ? budgetStopFor(id) !== null : !(await agentFits(id));
    if (stands || parkedAgents(kind, id).length === 0) continue;
    setAgentStatus(id, 'idle', { clearError: true });
    if (kind === 'no_model_fits') ownerConditionCleared(`nofit:${id}`);   // the owner's card ends with the lock
    released.push(id);
    await wake(id);
  }
  if (released.length > 0) logger.info('honest stop released on the real event', { kind, agentIds: released });
  return released;
}

/** The park's own notice is the line of the message that met the stop, when that message was not yet told. */
async function noteInChat(agentId: string, content: string, answers: string | null): Promise<void> {
  try {
    if (!answers || !(await tellCannotRun(agentId, answers, content))) chatLine(agentId, uuidv4(), content);
  } catch { /* the chat:error below still reaches the owner */ }
}

/** The recovery step for an honest stop (`recovery.ts`, ahead of the Tier D check): parks the agent,
 *  tells the owner ONCE per condition, and never calls the Healer; a BUDGET STOP is told once per window:
 *  the crossing alert and the first stop share one told-record (`budgetStopToTell`). A stop finding its
 *  own lock already on is silent. */
export async function tryHonestStopRecovery(state: AgentTurnState, error: unknown): Promise<boolean> {
  const agentId = state.agentId;
  let stop: HonestStop | null;
  try {
    stop = await classifyHonestStop(agentId, error);
  } catch (err) {
    logger.warn('honest stop: classifier threw', { agentId, error: err instanceof Error ? err.message : String(err) }, agentId);
    return false;
  }
  if (!stop) return false;

  const alreadyTold = stopAlreadyTold(agentId, stop.kind);
  logger.warn('honest stop: parking the agent until the condition clears', { agentId, kind: stop.kind, alreadyTold }, agentId);
  // The turn's record names the stop: `budget` for the guardrail; no-fit keeps the quarantine word.
  markTurnDied(agentId, state.turnNumber, stop.kind === 'budget_stop' ? 'budget' : (state.engineCutExit ?? 'unknown'));
  parkAgent(agentId, stop);
  await noteWaitingOfParked(agentId, alreadyTold ? null : state.lastUserMessageId);   // a message that arrived mid-turn is not left in silence
  if (alreadyTold) return true;

  await noteInChat(agentId, `[System (platform notice): ${stop.words}]`, state.lastUserMessageId);
  broadcast({ type: 'chat:error', cardClass: 'informational', agentId, error: stop.kind === 'no_model_fits' ? noFitOwnerWords(agentId) : stop.words, code: 'NO_MODEL', severity: 'warning', retryable: false });
  // A no-fit agent is a broken agent the owner must act on: one text and its card.
  if (stop.kind === 'no_model_fits' && tellOwner(`nofit:${agentId}`, wordsOf(`nofit:${agentId}`))) void sendAlert(wordsOf(`nofit:${agentId}`), 'notice', { kind: 'broken-agent', agentId });
  if (stop.kind === 'budget_stop') budgetStopToTell(stop.budget, (words) => void sendAlert(words, 'notice', { kind: 'budget' }));   // once per budget window, however many agents stop
  return true;
}
