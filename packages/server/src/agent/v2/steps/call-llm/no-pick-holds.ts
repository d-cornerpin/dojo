// When no router pick can hold the agent, name the cause from the router's own filters
// (`routedSkipReasons`), after a refused pick limited to the models that would hold it. The spending limit, no
// model that fits, or only models under the 32K floor is an honest stop thrown to the lock (`agent/v2/honest-stop.ts`);
// a transient cause is told to the owner here and returned, so the `assemble` step ends the turn with the agent idle.
// The "cannot hold a conversation" card shows only when no model of the agent's own can hold it.

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { routedSkipReasons, type RoutedSkip } from '../../../../router/selector.js';
import { getRateLimitInfo } from '../../../../router/rate-limits.js';
import { turnContext as turnCtxOf } from '../../../turn-context.js';
import { measureAgentToolPayloadTokens } from '../../../../tools/tool-docs.js';
import { anOwnModelHolds, modelHoldsAgent } from './reassemble-for-fit.js';
import { reportStarvedWindow } from '../../../../memory/window-starvation-card.js';
import type { SystemPromptTooLargeError } from '../../../../memory/budget.js';
import { honestStopWords, type HonestStopKind } from '../../error-format.js';
import { AgentError } from '../../../errors.js';
import { BUDGET_STOP_CODE, NO_MODEL_FITS_CODE } from '../../honest-stop-lock.js';
import type { PromptTurnContext } from '../../../../prompt/assembler.js';

const LEAD = 'This agent\'s turn was not run';
const CAUSE: Record<RoutedSkip, string> = {
  budget: 'today\'s spending limit is reached for the models it could use. It runs again when the limit resets, or after you raise it in Settings',
  rate_limit: 'the models it could use are rate-limited by their provider right now. Send the message again in a few minutes',
  provider_down: 'the provider of the models it could use is not answering (check it in Settings → Providers)',
  excluded: 'the models it could use failed earlier in this turn. Send the message again in a few minutes',
  capability: 'the only models it could use cannot use tools',
  too_small: 'the only models left have a memory window under 32K, too small for an agent. Add a bigger model to the router',
};

/** Why no routed pick holds the agent: a transient cause is told and returned, an honest stop thrown. */
export async function tellOwnerNoPickHolds(args: {
  agentId: string; turnNumber: number; tier: string | null | undefined; excluded: string[]; turnContext: PromptTurnContext;
  /** The last pick's refusal: its numbers are the card's. None when nothing was picked: every skip is a cause. */
  refusal?: SystemPromptTooLargeError;
  /** Re-arms the ask (no settlement rung spent) before an honest stop is thrown. */
  revertTrigger: () => void;
}): Promise<string> {
  const { agentId, turnNumber, tier, excluded, turnContext, refusal, revertTrigger } = args;
  const toolPayloadTokens = await measureAgentToolPayloadTokens(agentId);
  if (refusal && !(await anOwnModelHolds(agentId, toolPayloadTokens, turnContext))) reportStarvedWindow(agentId, refusal.systemPromptTokens, refusal.policy);
  const causes = new Set<RoutedSkip>();
  const resets: number[] = [];
  for (const { modelId, skip } of routedSkipReasons(tier, agentId, excluded, ['tools'])) {
    if (skip === 'rate_limit') resets.push(getRateLimitInfo(modelId)?.resetAt ?? 0);
    if (skip && !causes.has(skip) && (!refusal || await modelHoldsAgent(agentId, modelId, toolPayloadTokens, turnContext))) causes.add(skip);
  }
  // The limit is the real stop even beside a transient cause (a rate limit clears by itself; the limit does not).
  const stop: HonestStopKind | null = causes.has('budget') ? 'budget_stop' : [...causes].every((c) => c === 'too_small') ? 'no_model_fits' : null;
  if (stop) {
    revertTrigger();
    throw new AgentError(honestStopWords(stop), agentId, { code: stop === 'budget_stop' ? BUDGET_STOP_CODE : NO_MODEL_FITS_CODE });
  }
  // A limit clears by itself: the request waits on its row for the earliest reset (the turn ends as a provider error).
  const bag = causes.has('rate_limit') ? turnCtxOf(agentId) : undefined;
  if (bag) bag.retryAt = Math.max(Date.now() + 60_000, Math.min(...resets));
  const said = `${LEAD}: ${[...causes].map((c) => CAUSE[c]).join('; and ')}.`;
  try {
    const id = uuidv4();
    insertMessageIfAbsent({ id, agentId, role: 'system', content: said, turnNumber });
    broadcast({
      type: 'chat:message', agentId,
      message: { id, agentId, role: 'system', content: said, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
    });
  } catch { /* the notice below still reaches the owner */ }
  broadcast({ type: 'chat:error', agentId, error: said, code: 'NO_MODEL', severity: 'warning', cardClass: 'informational', retryable: true });
  return said;
}
