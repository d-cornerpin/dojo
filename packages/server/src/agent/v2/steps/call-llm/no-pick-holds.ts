// When no router pick can hold the agent, name the cause from the router's own filters
// (`routedSkipReasons`), limited to the models that would hold it. The spending limit, or no model that
// fits, is an honest stop thrown to the lock (`agent/v2/honest-stop.ts`); a transient cause is told to
// the owner here and returned, so the `assemble` step ends the turn with the agent idle, not errored.
// The "cannot hold a conversation" card shows only when no model of the agent's own can hold it.

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { routedSkipReasons, type RoutedSkip } from '../../../../router/selector.js';
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
  budget: 'today\'s spending limit is reached, and every model still within it is too small for this agent\'s instructions and tools. It runs again when the limit resets, or after you raise it in Settings',
  rate_limit: 'the models big enough for this agent are rate-limited by their provider right now. Send the message again in a few minutes',
  provider_down: 'the provider of the models big enough for this agent is not answering (check it in Settings → Providers)',
  excluded: 'the models big enough for this agent failed earlier in this turn. Send the message again in a few minutes',
  capability: 'the only models big enough for this agent cannot use tools',
  too_small: 'the only models left have a memory window under 32K, too small for an agent. Add a bigger model to the router',
};
const NONE_HOLDS = 'none of the models the auto-router uses can hold its instructions and tools. Add a model with a larger context window to the router, or give it fewer tools';

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
  for (const { modelId, skip } of routedSkipReasons(tier, agentId, excluded, ['tools'])) {
    if (skip && !causes.has(skip) && (!refusal || await modelHoldsAgent(agentId, modelId, toolPayloadTokens, turnContext))) causes.add(skip);
  }
  // The limit is the real stop even beside a transient cause (a rate limit clears by itself; the limit does not).
  const stop: HonestStopKind | null = causes.has('budget') ? 'budget_stop' : causes.size === 0 ? 'no_model_fits' : null;
  if (stop) {
    revertTrigger();
    throw new AgentError(honestStopWords(stop), agentId, { code: stop === 'budget_stop' ? BUDGET_STOP_CODE : NO_MODEL_FITS_CODE });
  }
  const said = `${LEAD}: ${causes.size === 0 ? NONE_HOLDS : [...causes].map((c) => CAUSE[c]).join('; and ')}.`;
  const stopOnly = causes.size > 0;   // something will change on its own, or by a Settings choice
  try {
    const id = uuidv4();
    insertMessageIfAbsent({ id, agentId, role: 'system', content: said, turnNumber });
    broadcast({
      type: 'chat:message', agentId,
      message: { id, agentId, role: 'system', content: said, tokenCount: null, modelId: null, cost: null, latencyMs: null, createdAt: new Date().toISOString() },
    });
  } catch { /* the notice below still reaches the owner */ }
  broadcast({ type: 'chat:error', agentId, error: said, code: 'NO_MODEL', severity: stopOnly ? 'warning' : 'error', cardClass: stopOnly ? 'informational' : 'action', retryable: stopOnly });
  return said;
}
