/**
 * THE `origin_intent` VOCABULARY — A LEAF, SO IT CAN BE READ FROM MODULE SCOPE (t117).
 *
 * `origin_intent` is the open-vocabulary "which subsystem produced this row" column on
 * `messages` (T3-0b §2). These are its named values: the spellings that a writer and the
 * reader that must recognise what the writer stamped share, so they cannot drift apart.
 *
 * ── WHY THEY LIVE IN THEIR OWN FILE RATHER THAN IN `message-store.ts` ──
 * They were declared in `message-store.ts`, beside the functions that use them, which reads
 * naturally and was wrong for one reason: `work/ask-settlement.ts` builds a SQL fragment out of
 * `START_ACK_ORIGIN_INTENT` at MODULE SCOPE, and `message-store` reaches `ask-settlement` again
 * through its own dependency graph. So when `message-store` was the first module a process
 * entered, ESM ran `ask-settlement`'s top level while `message-store` was still
 * mid-initialization — before the `export const` line had executed — and the read landed in the
 * temporal dead zone: `Cannot access 'START_ACK_ORIGIN_INTENT' before initialization`.
 *
 * THIS FILE IMPORTS NOTHING. That is its whole job and the property to preserve: a module with
 * no dependencies can never be partway through initialization when someone reads it, so a
 * module-scope read of anything declared here is safe under every possible import order. Give
 * this file an import and the dead zone comes back.
 *
 * `memory/__tests__/the-assembler-initializes-when-it-is-imported-first.test.ts` holds both
 * halves: that the modules in the cycle each initialize as a fresh process's first import, and
 * that this file is still a leaf.
 */

/** What marks a row as the agent BUS (spawn results, PM status, scheduler notices)
 *  rather than ordinary peer conversation. */
export const AGENT_BUS_INTENT = 'agent_bus';

/**
 * UX-REPAIR T2 — WHAT MARKS THE PROMOTED START LINE, IN ONE SPELLING.
 *
 * The model's opening line, pushed to the person EARLY, ahead of the answer
 * (`agent/v2/steps/post-call-classify/terminal-text.ts` — one production writer). It is the
 * agent's own words, not engine prose (PHASE-4 T4), which is why its row also carries an
 * explicit `displayKind: 'agent-text'` and reads in chat exactly as any other bubble.
 *
 * It is a CONSTANT rather than two string literals because the writer and the settlement
 * authority that refuses it as an ask's receipt (`work/ask-settlement.ts`, the seventh
 * narrowing) must be unable to drift apart — a stamp nobody matches is the defect this fix
 * exists to close, in a new spelling.
 */
export const START_ACK_ORIGIN_INTENT = 'engine_start_ack';
