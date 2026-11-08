// The judgments the decision model answers, by the owner's decision; every other judgment is its rule.
import { getDecisionProvider } from './decision-provider.js';

/** Keys are `purpose/question`. */
export const OWNER_ON_THE_MODEL: ReadonlySet<string> = new Set([
  'inbound_routing/simple_chat', 'inbound_routing/deliverable', 'memory_shape/filler',
  'reply_claims/claims_sent_to_third_party', 'summary_check/stated_current',
]);

/** Is `question` (`purpose/question`) answered by the decision model on this box? */
export const onTheModel = (question: string): boolean => OWNER_ON_THE_MODEL.has(question) && getDecisionProvider() !== null;
