// The judgments the decision model answers, by the owner's decision, each with its own lines; every other judgment is its
// rule. Yes at or above `yes`, no below `no`; between them no verdict, so the caller's word list or harmless action stands.
import { getDecisionProvider } from './decision-provider.js';

const LINES: ReadonlyMap<string, { yes: number; no: number }> = new Map([
  ['inbound_routing/needs_several_steps', { yes: 0.5, no: 0.3 }],
  ['inbound_routing/declined', { yes: 0.5, no: 0.5 }],
  ['inbound_routing/deliverable', { yes: 0.5, no: 0.5 }],
  ['memory_shape/filler', { yes: 0.52, no: 0.52 }],
  ['memory_shape/obligation', { yes: 0.7, no: 0.3 }],
  ['deliverable_declaration/owes_a_message', { yes: 0.4, no: 0.4 }],
  ['summary_check/stated_current', { yes: 0.5, no: 0.5 }],
  ['reply_claims/claims_sent_to_third_party', { yes: 0.5, no: 0.5 }],
  ['reply_claims/only_promises_to_start', { yes: 0.5, no: 0.5 }],
  ['reply_claims/standing_promise', { yes: 0.7, no: 0.3 }],
  ['reply_claims/asserts_board_state', { yes: 0.7, no: 0.3 }],
  ['work_done/delivered_what_it_owes', { yes: 0.6, no: 0.6 }],
]);

export const onTheModel = (question: string): boolean => LINES.has(question) && getDecisionProvider() !== null;

export function verdict(question: string, probability: number): boolean | undefined {
  const line = LINES.get(question);
  if (!line) return undefined;
  return probability >= line.yes ? true : probability < line.no ? false : undefined;
}
