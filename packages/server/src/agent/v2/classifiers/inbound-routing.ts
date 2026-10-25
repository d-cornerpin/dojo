// ════════════════════════════════════════════════════════════════════════════
// v3.5 C2 — INBOUND ROUTING, ASKED ALONGSIDE THE RULES (spec A11–A15).
//
// Five judgments about a message that has just arrived, each still decided by its rule:
//   simple_chat  (A12)  is it a simple conversational ask?          rule: `complexityClassifier`
//   multi_step   (A13)  is it more than two actions or deliverables? rule: the heuristic, then the system model's JSON chat call
//   delegates    (A14)  did the person hand the work to the agent's own agents?   rule: the delegation grammar
//   pleasantry   (A11)  is an agent's iMessage nothing but a pleasantry?           rule: the whole-message pleasantry list
//   deliverable  (A15)  is a sub-agent's FYI really a finished deliverable?         rule: URL, or completion word + artefact
//
// A12–A14 are about the same message on the same turn, so ONE `decide()` call (memoised on the turn's context)
// answers all three; A11 and A15 are single questions asked where they arise. In `rule` and `shadow` mode every
// function here returns its rule's answer and the multistep chat-JSON call is NOT removed (owner ruling): the
// model's answer is logged beside it. Only in `model` mode does the model's verdict replace the rule's, and
// only when it sits outside the question's measured weak band; inside the band, today's behaviour stands and
// the heuristic (and, for multistep, the chat call) is still the fallback. A15 wakes the primary, so it takes
// the strictest reading of the band.
// ════════════════════════════════════════════════════════════════════════════

import type { Question } from '../../decide.js';
import { judgment, type Judgment } from '../../decision-ask.js';
import { complexityClassifier } from './complexity.js';
import { isContentFreeCourtesy, isEngineAckLine } from './inbound-courtesy.js';
import {
  detectMultistep, getMultistepConfig, looksLikeEngineMessage, userExplicitlyAsksToCreateTracker,
  multistepHeuristic, type MultistepConfig, type MultistepDecision,
} from './multistep.js';

export const INBOUND_ROUTING_PURPOSE = 'inbound_routing';

const QUESTIONS: Record<string, Question> = {
  simple_chat: { type: 'noul', instructions: 'Is `message` a simple conversational ask: a greeting, thanks, an acknowledgement, or a one-line question or request that needs no plan?' },
  multi_step: { type: 'noul', instructions: 'Does `message` ask for more than two distinct actions or deliverables?' },
  delegates: { type: 'noul', instructions: 'Does `message` tell the assistant to hand the work to one of its own agents, helpers or team?' },
  pleasantry: { type: 'noul', instructions: 'Is `message` nothing but a pleasantry, thanks or sign-off that carries no request, question or information?' },
  deliverable: { type: 'noul', instructions: 'Does `message` announce that a finished piece of work (a document, post, link, file or result) is ready for someone to receive?' },
};
const only = (...names: string[]): Record<string, Question> => Object.fromEntries(names.map((n) => [n, QUESTIONS[n]]));

/** The turn's one routing judgment (A12–A14): the first site to report starts the call, the rest join it. */
function routing(turnCtx: object, agentId: string, message: string): Judgment {
  return judgment({ purpose: INBOUND_ROUTING_PURPOSE, agentId, state: { message }, questions: only('simple_chat', 'multi_step', 'delegates') }, turnCtx);
}

/** A12 — is this turn a quick conversational ask? */
export async function isConversational(turnCtx: object, agentId: string, message: string): Promise<boolean> {
  const rule = complexityClassifier(message).complexity === 'simple';
  if (!message.trim()) return rule;
  const said = await routing(turnCtx, agentId, message).alongside('simple_chat', rule);
  return typeof said === 'boolean' ? said : rule;
}

/** A14 — did the person route the work to the agent's own agents? `rule` is the grammar's answer. */
export async function delegatesJudged(turnCtx: object, agentId: string, message: string, rule: boolean): Promise<boolean> {
  const said = await routing(turnCtx, agentId, message).alongside('delegates', rule);
  return typeof said === 'boolean' ? said : rule;
}

/**
 * A13 — `detectMultistep`, with the decision model asked alongside. In `model` mode the model's verdict stands in
 * for the rule's chat call (that call is skipped); inside the weak band the rule runs exactly as before.
 */
export async function detectMultistepJudged(
  turnCtx: object, query: string, agentId: string, config: MultistepConfig = getMultistepConfig(),
): Promise<MultistepDecision> {
  // The three early returns of `detectMultistep` are not judgments (off, an engine message, an explicit request).
  const judgeable = config.enabled && !!agentId && !looksLikeEngineMessage(query) && !userExplicitlyAsksToCreateTracker(query);
  if (!judgeable) return detectMultistep(query, agentId, config);
  const say = routing(turnCtx, agentId, query);
  if (say.modeOf('multi_step') === 'model') {
    const heuristic = multistepHeuristic(query);
    // The rule that remains is the heuristic floor: the chat call is what the model replaces.
    const verdict = await say.alongside('multi_step', heuristic.decision === 'definitely_multi');
    if (typeof verdict === 'boolean') return { multistep: verdict, name: null, source: verdict ? 'decision_multi' : 'decision_single', heuristic };
    return detectMultistep(query, agentId, config);
  }
  const rule = detectMultistep(query, agentId, config);
  void say.alongside('multi_step', rule.then((d) => d.multistep, () => null));
  return rule;
}

/** A11 — is an AGENT's iMessage nothing but a pleasantry (so no turn is taken)? Our own ack lines never ask. */
export async function courtesyJudged(agentId: string, text: string): Promise<boolean> {
  const rule = isContentFreeCourtesy(text);
  if (isEngineAckLine(text)) return rule;
  const said = await judgment({ purpose: INBOUND_ROUTING_PURPOSE, agentId, state: { message: text }, questions: only('pleasantry') }).alongside('pleasantry', rule);
  return typeof said === 'boolean' ? said : rule;
}

/** A15 — is a sub-agent's FYI to the primary really a deliverable (so it wakes the primary)? STRICTEST reading of the band. */
export async function deliverableJudged(agentId: string, payload: string, rule: boolean): Promise<boolean> {
  const said = await judgment({ purpose: INBOUND_ROUTING_PURPOSE, agentId, state: { message: payload }, questions: only('deliverable') })
    .alongside('deliverable', rule, { strict: true });
  return typeof said === 'boolean' ? said : rule;
}
