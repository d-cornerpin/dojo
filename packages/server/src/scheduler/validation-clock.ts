/**
 * THE OWNER-ESCALATION CLOCK — A LEAF, SO IT CAN BE READ FROM MODULE SCOPE (t117).
 *
 * One number, declared where it has no dependencies of its own.
 *
 * ── WHY IT IS NOT DECLARED IN `runner.ts` ──
 * `tracker/pm-agent.ts` derives `VALIDATION_COVERAGE_BOUND_MS` from this value at MODULE
 * SCOPE, and `scheduler/runner.ts` reaches `pm-agent.ts` again through its own dependency
 * graph. So a declaration in `runner.ts` was a temporal dead zone for any process that entered
 * `runner.ts` first: ESM ran `pm-agent`'s top level while `runner` was still mid-initialization,
 * before the `export const` line, and the read threw
 * `Cannot access 'VALIDATION_ESCALATION_MIN' before initialization`.
 *
 * THIS FILE IMPORTS NOTHING, and that is the property to preserve: a module with no
 * dependencies can never be partway through initialization when someone reads it. Give this
 * file an import and the dead zone comes back. The same argument, and the same fix, as
 * `memory/origin-intents.ts`.
 */

/**
 * EXPORTED, SWEEP-A TB8 JOB 2. This is the only clock in the product that says how long a row
 * may await Key 2 before the OWNER is told about it, so it is also the only honest bound on how
 * long the platform's own validator may take. `scheduler/runner.ts` and `tracker/pm-agent.ts`
 * both read it from here rather than declaring a second number — the two clocks must be ORDERED
 * (the validator is accountable before the owner is bothered), and two copies cannot be ordered.
 */
export const VALIDATION_ESCALATION_MIN = 5;
