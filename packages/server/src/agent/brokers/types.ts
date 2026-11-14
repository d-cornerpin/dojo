// A leaf: imports nothing but the brands in resolve.js, so brokers can import this without a cycle.

import type { ResolvedPath, ResolvedCommand, ResolvedArgv, ResolvedUrl } from './resolve.js';

/** `ladder-parity`: always enforced; log-only would be the regression. `bypass-hardening`: staged. */
export type VerdictBasis = 'ladder-parity' | 'bypass-hardening';

export type BrokerEffect =
  | { readonly kind: 'fs_read' | 'fs_write'; readonly resource: ResolvedPath; readonly surface?: 'tool' | 'share' }
  | { readonly kind: 'shell' | 'applescript'; readonly resource: ResolvedCommand }
  | { readonly kind: 'proc'; readonly resource: ResolvedArgv }
  | { readonly kind: 'net'; readonly resource: ResolvedUrl }
  | { readonly kind: 'spawn' };

export type Verdict =
  | { readonly allowed: true; readonly rule: string }
  | {
      readonly allowed: false;
      readonly basis: VerdictBasis;
      readonly rule: string;
      /** The agent-facing reason, worded as the guard it replaced worded it. */
      readonly reason: string;
      /** null renders via permissionDeniedMessage; loop.ts keys retry off the [BLOCKED] prefix. */
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
