// ════════════════════════════════════════════════════════════════════════════
// BROKER VOCABULARY (PHASE-5 T2 Step 2) — a leaf with no imports but the brands.
// ════════════════════════════════════════════════════════════════════════════

import type { ResolvedPath, ResolvedCommand, ResolvedArgv, ResolvedUrl } from './resolve.js';

/**
 * WHY A VERDICT CARRIES A `basis`.
 *
 * T2 replaces a 15-branch guard run, and RULING P5-R5 binds it to ENFORCEMENT
 * PARITY: the brokers refuse what the ladder refused, plus the corpus's bypass
 * classes reaching an already-denied resource. Those two are different in one
 * way that matters operationally — the parity refusals have been biting for
 * months and every flow in the product is already shaped around them, while the
 * hardening refusals are new behaviour on the day they land. So the verdict says
 * which it is, and Step 4's staging reads it:
 *
 *   `ladder-parity`     the exact refusal today's tree produces. ENFORCED for
 *                       every agent, always. Nothing is staged, nothing is
 *                       log-only, because turning one of these off would be the
 *                       security regression the staging exists to avoid.
 *   `bypass-hardening`  a refusal the pre-T2 tree did not produce, reaching a
 *                       resource the pre-T2 tree already denied by another
 *                       spelling (a symlink, a `-wal` sibling). Enforced for the
 *                       primary agent and the Healer immediately; recorded but
 *                       not enforced for sub-agents until T5 fixes the default
 *                       manifest (plan T2 Step 4).
 */
export type VerdictBasis = 'ladder-parity' | 'bypass-hardening';

export type BrokerEffect =
  | { readonly kind: 'fs_read' | 'fs_write' | 'fs_delete'; readonly resource: ResolvedPath; readonly surface?: 'tool' | 'share' }
  // `shell` and `applescript` carry a SCRIPT (text an interpreter parses);
  // `proc` carries an argument VECTOR (a program and literal arguments). The
  // types are different because the things are different — that separation is
  // what T3's rebuild buys, and letting one BrokerEffect stand for both would
  // have thrown it away at the door.
  | { readonly kind: 'shell' | 'applescript'; readonly resource: ResolvedCommand }
  | { readonly kind: 'proc'; readonly resource: ResolvedArgv }
  | { readonly kind: 'net'; readonly resource: ResolvedUrl }
  | { readonly kind: 'spawn' };

export type Verdict =
  | { readonly allowed: true; readonly rule: string }
  | {
      readonly allowed: false;
      readonly basis: VerdictBasis;
      /** The rule id or manifest pattern that decided it — what a log line names. */
      readonly rule: string;
      /** The agent-facing reason, in the same words the ladder used. */
      readonly reason: string;
      /**
       * A complete replacement message when the pre-T2 refusal had its own
       * wording (the exec sensitive-file block, the share block). `null` means
       * "render it with `permissionDeniedMessage`", which is what every ladder
       * branch did — and `agent/v2/loop.ts` keys retry behaviour off the
       * `[BLOCKED]` prefix both shapes carry, so neither may lose it.
       */
      readonly blockedMessage: string | null;
    };

export function allow(rule: string): Verdict {
  return { allowed: true, rule };
}

export function deny(
  basis: VerdictBasis,
  rule: string,
  reason: string,
  blockedMessage: string | null = null,
): Verdict {
  return { allowed: false, basis, rule, reason, blockedMessage };
}
