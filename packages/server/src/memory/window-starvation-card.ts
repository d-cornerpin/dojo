// When a model's window cannot hold a conversation, the person is told; on its own, the refusal
// `assertSystemPromptFits` throws reaches only the log.
// The card rides the `chat:error` broadcast (rendered by severity); one outage, one card, the log line per
// occurrence, `retryable: false`, nothing destructive suggested. It never tells them to fix the system
// prompt (not theirs to change): the two repairs it names are the tool list and the model.

import { createLogger } from '../logger.js';
import { broadcast } from '../gateway/ws.js';
import type { ContextWindowPolicy } from './budget.js';
import { autoRouterContext } from '../router/router-window.js';
import { autoStarvedCardText } from '../router/router-window-words.js';

const logger = createLogger('window-starvation');

const starved = new Map<string, { since: string; systemPromptTokens: number }>();

/** The card in the person's words: leads with the bigger share of the window, always names both repairs. */
export function starvedWindowCardText(policy: ContextWindowPolicy): string {
  const usable = Math.max(1, Math.floor(policy.compactionThreshold * policy.contextWindow));
  const reserveIsTheProblem = policy.toolAndOutputReserve > usable / 2;
  const lead = reserveIsTheProblem
    ? 'the tools it has been given take up more of that window than its own instructions can fit beside'
    : 'its own instructions do not fit in that window at all';
  return `This agent cannot hold a conversation: its model's memory window is too small, ${lead}. `
    + 'Nothing has been lost, and nothing here needs deleting. '
    + 'Two things fix it: give this agent a shorter tool list, or point it at a model with a '
    + 'bigger context window. It will not start working on its own until one of those changes.';
}

/** Say it once per outage, to both audiences. Returns true when this call is the one that carded. */
export function reportStarvedWindow(
  agentId: string,
  systemPromptTokens: number,
  policy: ContextWindowPolicy,
): boolean {
  logger.error('WINDOW_STARVED the system prompt does not fit this model\'s window', {
    systemPromptTokens,
    assemblyBudgetTokens: policy.assemblyBudgetTokens,
    contextWindow: policy.contextWindow,
    toolAndOutputReserve: policy.toolAndOutputReserve,
    compactionThreshold: policy.compactionThreshold,
    alreadyCarded: starved.has(agentId),
  }, agentId);

  if (starved.has(agentId)) return false;
  starved.set(agentId, { since: new Date().toISOString(), systemPromptTokens });
  try {
    broadcast({
      type: 'chat:error',
      agentId,
      // An auto agent's card names the router's smallest model and the slider.
      error: ((r) => (r ? autoStarvedCardText(r) : starvedWindowCardText(policy)))(autoRouterContext(agentId)),
      code: 'WINDOW_TOO_SMALL',
      severity: 'error',
      cardClass: 'action',   // he gives it a bigger model or fewer tools
      // False: nothing here clears itself, the tool list or the model has to change.
      retryable: false,
    });
  } catch { /* best effort: the log line is the record, the card is the courtesy */ }
  return true;
}

/** An assembly fit: forget the note so a future outage cards again (once per outage, not per process). */
export function noteWindowHolds(agentId: string): void {
  const was = starved.get(agentId);
  if (!was) return;
  starved.delete(agentId);
  logger.info('This agent\'s window holds its prompt again — the configuration changed', {
    wasStarvedSince: was.since, wasSystemPromptTokens: was.systemPromptTokens,
  }, agentId);
}

export function windowIsStarved(agentId: string): boolean {
  return starved.has(agentId);
}

export function __resetStarvedWindowsForTests(): void {
  starved.clear();
}
