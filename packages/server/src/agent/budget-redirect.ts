// ════════════════════════════════════════════════════════════════════════════════════════
// t149 F6 — THE MONEY WALL'S REDIRECT TO A FREE MODEL: ANNOUNCED ONCE, AFTER IT ANSWERS, AND NEVER
// AN ERROR LOOP.
//
// When a call to a paid model is walled by the spending limit and a free model exists, the call is
// sent to the free model instead (`callModel`, the wall). This used to announce "Using <free model>
// instead" the moment it chose the model — on every walled call, so a message whose turn made three
// calls, plus its utility dials, was announced two or three times, before the free model had
// answered anything — and a free model that was unreachable threw its transport error out of the
// wall, which the turn took for a fault: error texts, Healer cards, agents paused after repeated
// errors, while the true cause was the limit.
//
// Now: the free models are tried in the order the wall offers them, until one ANSWERS. The
// announcement is made only then, only for the turn's own call, and only if this message has not
// been announced already (the record is the chat itself: a note newer than the last inbound row).
// When no free model answers, the call fails with the limit's own error (`BUDGET_EXCEEDED`), which
// the engine's recovery reads as the honest budget stop (`agent/v2/honest-stop.ts`): the agent is
// parked, the owner is told the true cause once, and it runs again when the limit changes.
// ════════════════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { getPrimaryAgentId, isPrimaryAgent } from '../config/platform.js';
import { SystemPromptTooLargeError } from '../memory/budget.js';
import { isStopFenced } from './shared-state.js';
import { AgentError } from './errors.js';
import type { BudgetCheckResult } from '../costs/budget.js';
import type { ModelCallParams, ModelCallResult } from './model.js';

const logger = createLogger('budget-redirect');

const NOTE_LEAD = '[SOURCE: SYSTEM, not a message from the user] Daily budget reached';

/** Tell the agent's chat (and the primary, for a sub-agent) — once per inbound message. Best effort. */
function announce(agentId: string, check: BudgetCheckResult, modelName: string): void {
  try {
    const already = getDb().prepare(
      `SELECT 1 FROM messages
        WHERE agent_id = ? AND role = 'system' AND content LIKE ?
          AND seq > COALESCE((SELECT MAX(seq) FROM messages
                               WHERE agent_id = ? AND role = 'user' AND COALESCE(lane, '') <> 'events'), 0)
        LIMIT 1`,
    ).get(agentId, `${NOTE_LEAD}%`, agentId);
    if (already) return;
    const say = (to: string, content: string): void => {
      const id = uuidv4();
      insertMessageIfAbsent({ id, agentId: to, role: 'system', content });
      broadcast({
        type: 'chat:message',
        agentId: to,
        message: { id, agentId: to, role: 'system' as const, content, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
      });
    };
    say(agentId, `${NOTE_LEAD} ($${check.dailySpend?.toFixed(2)} of $${check.dailyLimit?.toFixed(2)}). Using ${modelName} (free) instead.`);
    if (!isPrimaryAgent(agentId)) {
      say(getPrimaryAgentId(), `[SOURCE: SYSTEM, not a message from the user] Agent "${agentId}" switched to free model (${modelName}) due to budget limits.`);
    }
  } catch { /* notification is best-effort */ }
}

export async function redirectToAFreeModel(
  params: ModelCallParams, check: BudgetCheckResult,
  dial: (p: ModelCallParams) => Promise<ModelCallResult>,
): Promise<ModelCallResult> {
  const { agentId } = params;
  const candidates = check.freeModelFallbacks ?? (check.freeModelFallback ? [check.freeModelFallback] : []);
  let refusal: SystemPromptTooLargeError | null = null;
  let failure: unknown = null;
  for (const fb of candidates) {
    logger.warn(`Budget exceeded, falling back to free model: ${fb.modelName}`, {
      agentId, dailySpend: check.dailySpend, dailyLimit: check.dailyLimit, freeModel: fb.modelName,
    }, agentId);
    // t140 fix round 1 (review I1): re-fit the array to the free model's own window first. A free model
    // too small for the agent's instructions and tools refuses by name and the next one is tried.
    let refit: Awaited<ReturnType<NonNullable<ModelCallParams['refitFor']>>> = null;
    try {
      refit = params.refitFor ? await params.refitFor(fb.modelId) : null;
    } catch (err) {
      if (err instanceof SystemPromptTooLargeError) { refusal = err; continue; }
      throw err;
    }
    try {
      // The redirect target is an ollama transport (exempt from the wall) or a paid $0 model (skipped
      // via the budget_fallback tier): either way it dispatches without re-walling.
      const result = await dial({ ...params, ...(refit ?? {}), modelId: fb.modelId, routerTier: 'budget_fallback' });
      if (params.purpose === 'agent_turn') announce(agentId, check, fb.modelName);
      return result;
    } catch (err) {
      // The owner's Stop, or the caller's own cancel, is not a free model failing.
      if (isStopFenced(agentId) || params.abortSignal?.aborted) throw err;
      failure = err;
      logger.warn('Budget stop: the free model did not answer; trying the next one', {
        agentId, freeModel: fb.modelName, error: err instanceof Error ? err.message : String(err),
      }, agentId);
    }
  }
  // Only window refusals: the engine classifies them by name (a free model too small for the agent).
  if (failure === null && refusal) throw refusal;
  const why = failure instanceof Error ? `: ${failure.message}` : '';
  throw new AgentError(
    `${check.reason ?? 'Daily budget limit reached.'} No free model answered${why}`,
    agentId,
    { code: 'BUDGET_EXCEEDED', retryable: false, cause: failure instanceof Error ? failure : undefined },
  );
}
