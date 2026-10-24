// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 N42 fix round 1 — THE OWNER'S WORDS WHEN AN AUTO AGENT CANNOT RUN AT THE ROUTER WINDOW.
//
// An auto-routed agent has no model of its own: what is too small is the one router window
// (`router-window.ts`), set by the router's smallest model or lowered with the Router tab's slider.
// The words a pinned agent gets ("point it at a model with a bigger context window", "pick a bigger
// model") would send the owner to pin the agent to a big fixed model — every turn quietly moved onto a
// pricier one. These name the router's smallest model and the slider instead. OWNER-FACING ONLY (the
// card and the notice the dashboard shows); the platform notice persisted in the agent's own chat keeps
// its words until the text wave (`overhaul-plans/v35-text-wave.md`).
// ════════════════════════════════════════════════════════════════════════════════════════

import { autoRouterContext } from './router-window.js';
import { honestStopWords } from '../agent/v2/error-format.js';

export interface AutoRouterContext { modelName: string; floorTokens: number; windowTokens: number }

const k = (tokens: number): string => `${Math.round(tokens / 1000)}k`;
const SLIDER = '"Context window for automatic choice"';

/** What changes it: the slider when the owner set it below the smallest model, else that model. */
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

/** The no-fit notice the OWNER reads (`agent/v2/honest-stop.ts`): an auto agent's names the router; a pinned
 *  agent's is the stop's own words. */
export function noFitOwnerWords(agentId: string): string {
  const r = autoRouterContext(agentId);
  return r ? autoNoFitOwnerWords(r) : honestStopWords('no_model_fits');
}
