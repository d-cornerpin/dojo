// Owner-facing words for an auto agent that cannot run at the router window (router-window.ts). They name
// the router's smallest model and the slider; "pick a bigger model" would push the owner to pin a pricier one.

import { autoRouterContext, isAutoRouted } from './router-window.js';
import { honestStopWords } from '../agent/v2/error-format.js';

export interface AutoRouterContext { modelName: string; floorTokens: number; windowTokens: number }

const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`;
const SLIDER = '"Context window for automatic choice"';

function theFix(r: AutoRouterContext): string {
  return r.windowTokens < r.floorTokens
    ? `raise the ${SLIDER} slider on the Router tab in Settings (it can go up to ${k(r.floorTokens)}, the window of the router's smallest model, ${r.modelName})`
    : `the ${SLIDER} slider on the Router tab is already at its top, set by the router's smallest model, ${r.modelName} (${k(r.floorTokens)}): raise that model's window or take it off the router`;
}

/** The WINDOW_TOO_SMALL card for an auto agent (`memory/window-starvation-card.ts`). */
export function autoStarvedCardText(r: AutoRouterContext): string {
  return `This agent cannot hold a conversation: it runs on automatic model choice, every model the router picks runs at one ${k(r.windowTokens)} window, `
    + 'and its instructions and tools need more than that. Nothing has been lost, and nothing here needs deleting. '
    + `To fix it, ${theFix(r)}; or give this agent a shorter tool list. It will not start working on its own until one of those changes.`;
}

/** The no-fit notice the owner reads for an auto agent (`agent/v2/honest-stop.ts`). */
export function autoNoFitOwnerWords(r: AutoRouterContext): string {
  return `This agent's turn was not run: on automatic model choice it runs at the router's one ${k(r.windowTokens)} window, which cannot hold its instructions and tools. `
    + `Your message is kept. To fix it, ${theFix(r)}, and it will answer.`;
}

export function noFitOwnerWords(agentId: string): string {
  const r = autoRouterContext(agentId);
  if (r) return autoNoFitOwnerWords(r);
  return isAutoRouted(agentId) ? `This agent's turn was not run: the router has no model with a memory window of 32K or more, the least an agent needs. Your message is kept. Add one to the router in Settings and it will answer.` : honestStopWords('no_model_fits');
}
