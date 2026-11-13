// The judgments the decision model answers, by the owner's decision; every other judgment is its rule.
import { getDecisionProvider } from './decision-provider.js';

export const OWNER_ON_THE_MODEL: ReadonlySet<string> = new Set([
  'inbound_routing/simple_chat', 'inbound_routing/deliverable', 'memory_shape/filler',
  'reply_claims/claims_sent_to_third_party', 'summary_check/stated_current',
  'reply_claims/only_promises_to_start', 'reply_claims/standing_promise', 'reply_claims/asserts_board_state',
]);

export const onTheModel = (question: string): boolean => OWNER_ON_THE_MODEL.has(question) && getDecisionProvider() !== null;

export const isYes = (probability: number): boolean => probability >= 0.5;
