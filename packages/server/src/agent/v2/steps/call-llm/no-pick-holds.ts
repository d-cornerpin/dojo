// ════════════════════════════════════════════════════════════════════════════════════════
// t140 round 7 (round-6 re-review H2') — WHEN NO ROUTER PICK CAN HOLD THE AGENT, THE OWNER IS TOLD
// WHY, IN PLAIN WORDS, AND THE TURN ENDS CLEANLY.
//
// Round 6 threw the by-name refusal into the turn-error cascade, which knows nothing of it: the owner
// read "Agent hit an error and the Healer is looking into it", the agent was marked errored and
// handed to the Healer — when the real cause was a daily spending limit already reached. A budget
// stop is not an injury and nothing the Healer can do changes it. So the cause is read here, from
// the router's own filters (`routedSkipReasons`) restricted to the models that WOULD hold the agent,
// said once to the owner (a persisted note in the agent's chat and a `chat:error` notice), and the
// call step asks the driver to end the turn (`requestExit`). The agent is left idle, not errored.
// The "cannot hold a conversation" card shows too, only when it is true: no model of the agent's own
// (its configured model, or a pick the router opens a tier on) can hold it.
// ════════════════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import { broadcast } from '../../../../gateway/ws.js';
import { insertMessageIfAbsent } from '../../../../memory/message-store.js';
import { routedSkipReasons, type RoutedSkip } from '../../../../router/selector.js';
import { measureAgentToolPayloadTokens } from '../../../../tools/tool-docs.js';
import { anOwnModelHolds, modelHoldsAgent } from './reassemble-for-fit.js';
import { reportStarvedWindow } from '../../../../memory/window-starvation-card.js';
import type { SystemPromptTooLargeError } from '../../../../memory/budget.js';
import type { PromptTurnContext } from '../../../../prompt/assembler.js';

const LEAD = 'This agent\'s turn was not run';
const CAUSE: Record<RoutedSkip, string> = {
  budget: 'today\'s spending limit is reached, and every model still within it is too small for this agent\'s instructions and tools. It runs again when the limit resets, or after you raise it in Settings',
  rate_limit: 'the models big enough for this agent are rate-limited by their provider right now. Send the message again in a few minutes',
  provider_down: 'the provider of the models big enough for this agent is not answering (check it in Settings, under Providers)',
  excluded: 'the models big enough for this agent failed earlier in this turn. Send the message again in a few minutes',
  capability: 'the only models big enough for this agent cannot use tools',
};
const NONE_HOLDS = 'none of the models the auto-router uses can hold its instructions and tools. Add a model with a larger context window to the router, or give it fewer tools';

/** Name why no routed pick holds the agent, tell the owner once, and return what was said. */
export async function tellOwnerNoPickHolds(args: {
  agentId: string; turnNumber: number; tier: string | null | undefined; excluded: string[]; turnContext: PromptTurnContext;
  /** The last pick's refusal: its numbers are the card's. */
  refusal: SystemPromptTooLargeError;
}): Promise<string> {
  const { agentId, turnNumber, tier, excluded, turnContext, refusal } = args;
  const toolPayloadTokens = await measureAgentToolPayloadTokens(agentId);
  if (!(await anOwnModelHolds(agentId, toolPayloadTokens, turnContext))) reportStarvedWindow(agentId, refusal.systemPromptTokens, refusal.policy);
  const causes = new Set<RoutedSkip>();
  for (const { modelId, skip } of routedSkipReasons(tier, agentId, excluded, ['tools'])) {
    if (skip && !causes.has(skip) && await modelHoldsAgent(agentId, modelId, toolPayloadTokens, turnContext)) causes.add(skip);
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
  broadcast({ type: 'chat:error', agentId, error: said, code: 'NO_MODEL', severity: stopOnly ? 'warning' : 'error', retryable: stopOnly });
  return said;
}
