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
// RELEASE IS THE EVENT, NEVER A TIMER:
//   budget_stop    the limit is raised (gateway/routes/costs.ts), or the window turns over (the
//                  scheduler tick, scheduler/background-checks.ts). Both ask the same pure
//                  question, `exceededBudget`, and release only the agents it no longer stops.
//   no_model_fits  the agent's model or tools, the router's tiers, or a model's window or
//                  enablement changed (agents, router and config routes).
// Release is the status write the other roads out of a lock use (idle, diagnostic cleared) and
// the boot re-drain's own wake (`handleMessage(id, '')`), so the parked message is answered once.
// If the condition still stands the stop re-parks, and does not tell the owner again: the lock's
// own `last_error` is the record that he was told.
// ════════════════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/connection.js';
import { broadcast } from '../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../memory/message-store.js';
import { markTurnDied } from './turn-record.js';
import type { AgentTurnState } from './state.js';
import { createLogger } from '../../logger.js';
import { AgentError } from '../errors.js';
import { setAgentStatus } from '../agent-status.js';
import { SystemPromptTooLargeError } from '../../memory/budget.js';
import { exceededBudget, type ExceededBudget } from '../../costs/budget.js';
import { honestStopWords, type HonestStopKind } from './error-format.js';
import { lockTag, parkedAgents, BUDGET_STOP_CODE, NO_MODEL_FITS_CODE } from './honest-stop-lock.js';

const logger = createLogger('honest-stop');


export interface HonestStop {
  kind: HonestStopKind;
  words: string;
  /** The limit that stopped it, for `budget_stop` when one still stands. */
  budget: ExceededBudget | null;
}

function causeChain(error: unknown): unknown[] {
  const links: unknown[] = [];
  for (let e: unknown = error; e !== undefined && e !== null && links.length < 6; e = (e as { cause?: unknown }).cause) links.push(e);
  return links;
}

function budgetStop(agentId: string): HonestStop {
  const budget = exceededBudget(agentId);
  return {
    kind: 'budget_stop',
    budget,
    words: honestStopWords('budget_stop', budget
      ? { scope: budget.scope, period: budget.period, spendUsd: budget.spend, limitUsd: budget.limitUsd } : {}),
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
  if (codes.includes(BUDGET_STOP_CODE) || codes.includes('BUDGET_EXCEEDED')) return budgetStop(agentId);
  if (codes.includes(NO_MODEL_FITS_CODE)) return noFit();
  // The auto-router found no model at all, and the money limit is what filtered them out.
  if (codes.includes('NO_MODEL') && exceededBudget(agentId)) return budgetStop(agentId);

  const refusal = links.find((e): e is SystemPromptTooLargeError => e instanceof SystemPromptTooLargeError);
  if (refusal) {
    const row = getDb().prepare('SELECT model_id FROM agents WHERE id = ?').get(agentId) as { model_id: string | null } | undefined;
    if (!row?.model_id || row.model_id === 'auto') return null;   // a routed turn has its own exit (call-llm)
    // The pinned model holds the agent, and the limit sent the call to a free stand-in that cannot.
    if (exceededBudget(agentId) && !(await pinnedWindowRefused(agentId, refusal.policy.contextWindow))) return budgetStop(agentId);
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
  setAgentStatus(agentId, 'paused', { lastError: `${lockTag(stop.kind)} ${stop.words}`.slice(0, 400) });
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
 * Lift the lock on every agent parked for `kind` (or just `agentId`) and wake it, so the parked
 * message is answered once. For `budget_stop` pass `onlyWhereCleared` and an agent whose limit
 * still stops it stays parked. Returns the agents released.
 */
export async function releaseHonestStops(
  kind: HonestStopKind,
  opts: { agentId?: string; onlyWhereCleared?: boolean } = {},
): Promise<string[]> {
  const ids = parkedAgents(kind, opts.agentId);
  const released: string[] = [];
  for (const id of ids) {
    if (opts.onlyWhereCleared && kind === 'budget_stop' && exceededBudget(id)) continue;
    setAgentStatus(id, 'idle', { clearError: true });
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
 * sends NO text of its own: a budget stop is always preceded by the budget's own crossing alert
 * (t138: the wall and the router's budget filter both run `checkBudget`, which texts and raises
 * the dashboard card before it refuses), once per window, so a second text would be a second
 * telling of the same window; and a no-fit is not a class the platform may text (OR-V333-SET (3)).
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
  if (alreadyTold) return true;

  noteInChat(agentId, `[System (platform notice): ${stop.words}]`);
  broadcast({ type: 'chat:error', agentId, error: stop.words, code: 'NO_MODEL', severity: 'warning', retryable: false });
  return true;
}
