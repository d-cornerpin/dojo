// ════════════════════════════════════════════════════════════════════════════
// v3.5 C3 — THE PROVIDER ERROR'S CLASS, ASKED ALONGSIDE THE RULES (spec item 42).
//
// `provider-error.ts` reads what the provider ANSWERED (its HTTP status, its structured body, the transport's own
// code) and only as a last resort the error's words. That first reading is exact and stays the fast path: when it
// settled the class (`basis` status / body / transport) nothing is asked. The decision model is asked about the
// words only where the words were all there was (`basis` text or none) — every provider phrases an overlong
// prompt, an exhausted quota or a brief outage differently, and a `choice` with one criterion per outcome
// generalises across them.
//
// `rule` and `shadow`: the class is the rule's, unchanged; both are logged. `model`: the model's choice stands in,
// outside its measured weak band and (a class can lock an agent and banner the owner) only when clearly beyond it.
// The choice is mapped onto the classes the engine already acts on; nothing new is acted on.
// ════════════════════════════════════════════════════════════════════════════

import type { Question } from './decide.js';
import { judgment, subjectKey } from './decision-hooks.js';
import type { ProviderErrorClass, ProviderErrorFacts } from './provider-error.js';

export const PROVIDER_ERROR_PURPOSE = 'provider_error';

const ERROR_CLASS: Question = {
  type: 'choice',
  instructions: 'Which kind of failure does `error` describe?',
  criteria: {
    retryable_transient: 'The provider or the connection is briefly unavailable, and sending the same request again may succeed.',
    auth: 'The credential is missing, invalid, expired or revoked.',
    context_too_long: 'The request is larger than the model can read (a prompt or context over its limit).',
    rate_limited: 'Too many requests, or a usage limit that lifts with time.',
    permanent: 'The request itself is refused or the account may not do this, and sending it again unchanged will fail the same way.',
  },
};

/** The rule's class in the choice's own words. `unknown` is not a choice the model can make, so the rule is never right on it. */
const CHOICE_OF: Record<ProviderErrorClass, string> = {
  auth: 'auth', access_denied: 'permanent', quota: 'permanent', rate_limit: 'rate_limited', overloaded: 'retryable_transient',
  server: 'retryable_transient', network: 'retryable_transient', bad_request: 'permanent', declared_patience_exceeded: 'permanent', unknown: 'unknown',
};
/** The class the engine already acts on for each choice. An overlong request is a request that fails the same way forever: `bad_request`. */
const CLASS_OF: Record<string, ProviderErrorClass> = {
  retryable_transient: 'server', auth: 'auth', context_too_long: 'bad_request', rate_limited: 'rate_limit', permanent: 'bad_request',
};

export interface JudgedProviderError { facts: ProviderErrorFacts; choice: string }

export async function judgeProviderError(facts: ProviderErrorFacts, text: string, agentId: string): Promise<JudgedProviderError> {
  const rule = { facts, choice: CHOICE_OF[facts.class] };
  if ((facts.basis !== 'text' && facts.basis !== 'none') || !text) return rule;   // the provider's own answer settled it
  const said = await judgment({ purpose: PROVIDER_ERROR_PURPOSE, agentId, subject: subjectKey(agentId, text), state: { error: text }, questions: { error_class: ERROR_CLASS } })
    .alongside('error_class', rule.choice, { strict: true });
  if (said === rule.choice) return rule;
  const cls = typeof said === 'string' ? CLASS_OF[said] : undefined;
  return cls ? { facts: { ...facts, class: cls, basis: 'text' }, choice: said as string } : rule;
}
