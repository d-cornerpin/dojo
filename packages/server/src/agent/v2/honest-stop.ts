// ════════════════════════════════════════════════════════════════════════════════════════
// t148 (v3.3.3) — AN HONEST STOP: THE PARK, AND ITS RELEASE ON THE REAL EVENT.
//
// Two conditions stop a turn without anything being broken: the owner's money guardrail
// (`budget_stop`), and no model the agent may use being able to hold it (`no_model_fits`). The
// Healer cannot change either. Both ride the platform's EXISTING lock for "this agent cannot
// proceed until something outside it changes" (the Tier D path in `recovery.ts`), with one
// difference in what it shows: the status is `paused` (the dashboard shows it as Ready, not as
// Error; the "paused after repeated errors" card is keyed on an error-loop row this never writes),
// and `last_error` carries `[<kind>] <the owner's words>`, so the lock is self-describing and
// durable across a restart. The drain stands down for `paused` (`isSelfResumeBlockedStatus`), so
// the stopped message is never re-served into the same stop; it stays an open ask.
//
// A PARK IS IDENTIFIED BY ITS OWN RECORD: status `paused` AND the tag at the head of `last_error`. Any
// other pause (the owner's texted pause, the error loop's) overwrites the tag, so these paths never
// release a pause that is not theirs; the owner's pause on a parked agent wins.
//
// RELEASE IS THE EVENT, NEVER A TIMER, AND EVERY RELEASE RE-CHECKS ITS OWN CONDITION FIRST:
//   budget_stop    the limit is raised (gateway/routes/costs.ts), or the window turns over (the
//                  scheduler tick). The question is `budgetStopFor`: the router's own per-model
//                  estimate for a routed agent, the wall's for a pinned one.
//   no_model_fits  the agent's model or tools, the router's tiers, or a model's window or enablement
//                  changed (agents, router and config routes). The question is whether a model of its
//                  own now holds it (`agentFits`); an unrelated edit that does not make it fit changes
//                  nothing: the agent stays parked, silent, with its "already told" record intact.
// Release is the status write the other roads out of a lock use (idle, diagnostic cleared) and the
// boot re-drain's own wake (`handleMessage(id, '')`), so the parked message is answered once. A stop
// that finds its own tag already on is silent; the owner is told once per park, the record being the
// tag (and, for no-fit, the `nofit:` condition), both of which only a real release clears.
// ════════════════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { markTurnDied } from './turn-record.js';
import { sendAlert } from '../../services/imessage-bridge.js';
import { tellOwnerOnce, ownerConditionCleared, wordsOf } from '../../healer/owner-notices.js';
import type { AgentTurnState } from './state.js';
import { createLogger } from '../../logger.js';
import { noteWaitingOfParked } from './honest-stop-notes.js';
import { AgentError } from '../errors.js';
import { setAgentStatus } from '../agent-status.js';
import { SystemPromptTooLargeError } from '../../memory/budget.js';
import { exceededBudget, WALL_ESTIMATE_USD, type ExceededBudget } from '../../costs/budget.js';
import { routedCandidateCosts } from '../../router/selector.js';
import type { PromptTurnContext } from '../../prompt/assembler.js';
import { honestStopWords, type HonestStopKind } from './error-format.js';
import { lockTag, parkedAgents, parkedCauseOf, parkedForFreeDown, BUDGET_STOP_CODE, NO_MODEL_FITS_CODE, FREE_FALLBACK_DOWN_CODE, FREE_DOWN_TAG } from './honest-stop-lock.js';

const logger = createLogger('honest-stop');


export interface HonestStop {
  kind: HonestStopKind;
  words: string;
  /** The limit that stopped it, for `budget_stop` when one still stands. */
  budget: ExceededBudget | null;
  /** t149 round 3: the limit is reached and no free model answered; the park records it. */
  freeDown?: boolean;
}

function causeChain(error: unknown): unknown[] {
  const links: unknown[] = [];
  for (let e: unknown = error; e !== undefined && e !== null && links.length < 6; e = (e as { cause?: unknown }).cause) links.push(e);
  return links;
}

/**
 * THE ONE BUDGET TRUTH: is a spending limit what stops this agent right now? A pinned agent is stopped
 * by the wall (`WALL_ESTIMATE_USD`, agent/model.ts). A routed agent is stopped when EVERY model the router
 * can reach is over the limit by that model's OWN request estimate (`routedCandidateCosts`, the number
 * `selectModel` skips each model on), so a park, a classification and a release all agree with the
 * router. Returns the limit as the owner should read it (the cheapest model's numbers), or null.
 */
export function budgetStopFor(agentId: string): ExceededBudget | null {
  const row = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
  if (row?.model_id !== 'auto') return exceededBudget(agentId, WALL_ESTIMATE_USD);
  const costs = routedCandidateCosts().sort((a, b) => a - b);
  const over = costs.map((c) => exceededBudget(agentId, c));
  return costs.length > 0 && over.every((o) => o !== null) ? over[0] : null;
}

/** Whether a model of the agent's own can hold its instructions and tools right now (the fit, re-measured). */
async function agentFits(agentId: string): Promise<boolean> {
  const [{ anOwnModelHolds }, { measureAgentToolPayloadTokens }] = await Promise.all([
    import('./steps/call-llm/reassemble-for-fit.js'), import('../../tools/tool-docs.js'),
  ]);
  return anOwnModelHolds(agentId, await measureAgentToolPayloadTokens(agentId), undefined as unknown as PromptTurnContext);
}

function budgetStop(agentId: string, freeDown = false): HonestStop {
  // A routed agent offered free models has no `budgetStopFor` (a free model is under the line): the wall's own reading names the limit.
  const budget = budgetStopFor(agentId) ?? (freeDown ? exceededBudget(agentId, WALL_ESTIMATE_USD) : null);
  return {
    kind: 'budget_stop',
    budget,
    freeDown,
    words: honestStopWords('budget_stop', { ...(budget
      ? { scope: budget.scope, period: budget.period, spendUsd: budget.spend, limitUsd: budget.limitUsd } : {}), freeDown }),
  };
}

const noFit = (): HonestStop => ({ kind: 'no_model_fits', words: honestStopWords('no_model_fits'), budget: null });

/** Is the pinned model's own window the one that refused? (Else a stand-in's did.) */
async function pinnedWindowRefused(agentId: string, refusalWindow: number): Promise<boolean> {
  const row = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
  if (!row?.model_id) return true;
  const { getContextWindow } = await import('../model.js');
  return getContextWindow(row.model_id) === refusalWindow;
}

/** The cause of a thrown turn error, when it is an honest stop; null for anything else. */
export async function classifyHonestStop(agentId: string, error: unknown): Promise<HonestStop | null> {
  const links = causeChain(error);
  const codes = links.map((e) => (e instanceof AgentError ? e.code : undefined));
  if (codes.includes(FREE_FALLBACK_DOWN_CODE)) return budgetStop(agentId, true);
  if (codes.includes(BUDGET_STOP_CODE) || codes.includes('BUDGET_EXCEEDED')) return budgetStop(agentId);
  if (codes.includes(NO_MODEL_FITS_CODE)) return noFit();
  // The auto-router found no model at all, and the money limit is what filtered them out.
  if (codes.includes('NO_MODEL') && budgetStopFor(agentId)) return budgetStop(agentId);

  const refusal = links.find((e): e is SystemPromptTooLargeError => e instanceof SystemPromptTooLargeError);
  if (refusal) {
    const row = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
    if (!row?.model_id) return null;
    // A routed turn's per-pick refusals have their own exit (call-llm). The bare refusal that reaches
    // here is the FIRST assembly's, sized for the largest window the router opens a tier on (t149 F5):
    // when no model of the agent's own holds it, no pick can — the same stop as a pinned agent.
    if (row.model_id === 'auto') return (await agentFits(agentId)) ? null : noFit();
    // The pinned model holds the agent, and the limit sent the call to a free stand-in that cannot.
    if (budgetStopFor(agentId) && !(await pinnedWindowRefused(agentId, refusal.policy.contextWindow))) return budgetStop(agentId);
    return noFit();
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

/** Put the lock on: status `paused`, the owner's words as the diagnostic (one statement). */
export function parkAgent(agentId: string, stop: HonestStop): void {
  const lastError = `${lockTag(stop.kind)} ${stop.freeDown ? `${FREE_DOWN_TAG} ` : ''}${stop.words}`.slice(0, 400);
  setAgentStatus(agentId, 'paused', { lastError });
  // The live frame carries the true cause, so an open dashboard's pill tooltip needs no reload.
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

/**
 * Lift the lock on every agent parked for `kind` (or just `agentId`) whose OWN condition no longer
 * stands, and wake it so the parked message is answered once. EVERY release re-checks first (a limit
 * raised, or an unrelated model edited, that does not clear THIS agent's condition changes nothing:
 * it stays parked, silent, with its "already told" record intact). The check is the async one; the
 * row is then re-read and written with no await between, so a second release or an owner pause that
 * landed meanwhile is never written over (only a row still `paused` with its own tag is released).
 * Returns the agents released.
 */
export async function releaseHonestStops(kind: HonestStopKind, opts: { agentId?: string; onModelsChange?: boolean } = {}): Promise<string[]> {
  const released: string[] = [];
  for (const id of parkedAgents(kind, opts.agentId)) {
    // A "free fallback did not answer" park (t149 round 3) is not lifted by a free model merely existing (the
    // 30-second tick would flip it): a limit change or the window turning over lifts it, a model/tier change
    // lifts it for a fresh try, and a person's message tries the redirect again (runtime -> the turn).
    const freeDown = kind === 'budget_stop' && parkedForFreeDown(id);
    if (opts.onModelsChange && !freeDown) continue;
    const stands = freeDown ? !opts.onModelsChange && exceededBudget(id, WALL_ESTIMATE_USD) !== null
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

/** The agent's own chat gets the platform's notice (its next session reads it). */
function noteInChat(agentId: string, content: string): void {
  try {
    const id = uuidv4();
    insertMessageIfAbsent({ id, agentId, role: 'system', content });
    broadcast({ type: 'chat:message', agentId, message: { id, agentId, role: 'system', content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() } });
  } catch { /* the chat:error below still reaches the owner */ }
}

/**
 * The recovery cascade's step for an honest stop (`recovery.ts`, ahead of the Tier D check). Parks
 * the agent on the lock, tells the owner the true cause ONCE per condition, and never calls the
 * Healer. Returns true when it handled the error.
 *
 * The owner is told when the lock goes on. A stop that finds its own lock already on (the message
 * was served again, or he sent another) is silent: the status and the card already say it. It
 * sends NO text for a budget stop: it is always preceded by the budget's own crossing alert (t138: the
 * wall and the router's budget filter both run `checkBudget`, which texts and raises the dashboard card
 * before it refuses), once per window, so a second text would be a second telling of the same window.
 * A no-fit agent is a broken agent the owner must act on (OR-V333-SET (3)): it gets one text and a card.
 */
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
  // The turn's record says what stopped it: the money guardrail has its word (`budget`); a model
  // that cannot fit keeps the quarantine word, because nothing here observed a better one.
  markTurnDied(agentId, state.turnNumber, stop.kind === 'budget_stop' ? 'budget' : (state.engineCutExit ?? 'unknown'));
  parkAgent(agentId, stop);
  noteWaitingOfParked(agentId, alreadyTold ? null : state.lastUserMessageId);   // a message that arrived mid-turn is not left in silence
  if (alreadyTold) return true;

  noteInChat(agentId, `[System (platform notice): ${stop.words}]`);
  broadcast({ type: 'chat:error', agentId, error: stop.words, code: 'NO_MODEL', severity: 'warning', retryable: false });
  // A no-fit agent is a broken agent the owner must act on (OR-V333-SET (3)): ONE text through the
  // owner-notice door, and its lasting card (healer/owner-notices.ts, `nofit:<agent>`), same words.
  if (stop.kind === 'no_model_fits' && tellOwnerOnce(`nofit:${agentId}`)) sendAlert(wordsOf(`nofit:${agentId}`), 'notice');
  return true;
}
