// A walled paid call goes to a free model, tried in the wall's own order until one ANSWERS.
// It is announced only once one answers, only for the turn's own call, once per inbound message.
// None answers: throw the wall's own BUDGET_EXCEEDED, which the honest stop reads and names the true cause.

import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { broadcast } from '../gateway/ws.js';
import { insertMessageIfAbsent } from '../memory/message-store.js';
import { getPrimaryAgentId, isPrimaryAgent } from '../config/platform.js';
import { SystemPromptTooLargeError } from '../memory/budget.js';
import { isStopFenced } from './shared-state.js';
import { AgentError } from './errors.js';
import { FREE_FALLBACK_DOWN_CODE } from './v2/honest-stop-lock.js';
import type { BudgetCheckResult } from '../costs/budget.js';
import type { ModelCallParams, ModelCallResult } from './model.js';

const logger = createLogger('budget-redirect');

const NOTE_LEAD = '[SOURCE: SYSTEM, not a message from the user] Daily budget reached';

/** Tell the agent's chat (and the primary, for a sub-agent), once per inbound message. Best effort. */
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
    // Re-fit the array to the free model's own window first: one too small refuses by name, the next is tried.
    let refit: Awaited<ReturnType<NonNullable<ModelCallParams['refitFor']>>> = null;
    try {
      refit = params.refitFor ? await params.refitFor(fb.modelId) : null;
    } catch (err) {
      if (err instanceof SystemPromptTooLargeError) { refusal = err; continue; }
      throw err;
    }
    try {
      // The target is wall-exempt (ollama) or $0 via the budget_fallback tier: it dispatches without re-walling.
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
    { code: failure === null ? 'BUDGET_EXCEEDED' : FREE_FALLBACK_DOWN_CODE, retryable: false, cause: failure instanceof Error ? failure : undefined },
  );
}
