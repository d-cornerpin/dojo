// ════════════════════════════════════════════════════════════════════════════
// THE NETWORK BROKER (PHASE-5 T2 Step 2).
//
// Two questions, and they have always been two:
//
//   MAY THIS AGENT REACH THIS DOMAIN?   `network_domains` on the manifest. This
//      is the ladder's branches 5, 6 and 14b, and it is SYNCHRONOUS.
//   IS THIS TARGET ON THE PUBLIC INTERNET?   `assertPublicHttpTarget`
//      (`agent/net-guard.ts:183`, PHASE-0 T11, six product call sites). This is
//      the SSRF class, it needs DNS, and §T0-PINS P9 records it as HOLDING —
//      so the broker CALLS it rather than re-deriving it. Nothing is re-fixed.
//
// The corpus asks the private-address classes THROUGH the broker, which is the
// plan's own wording ("already checked — assert through the broker now"), so
// both halves live behind one `authorize`.
//
// ── A DNS FAILURE IS NEVER A REFUSAL ──
// `assertPublicHttpTarget` deliberately re-throws a genuine DNS failure
// unchanged, because `web_fetch` has a friendly "that domain does not resolve"
// branch keyed on the error text. If the broker turned that into a permission
// refusal, a typo'd hostname would start reading as "you are not allowed" — a
// capability message regression on a path that was never about permission. So
// only a NetGuardError refuses here; anything else defers to the egress guard
// that runs at the actual request.
// ════════════════════════════════════════════════════════════════════════════

import { assertPublicHttpTarget, NetGuardError, privateAddressClass } from '../net-guard.js';
import { createLogger } from '../../logger.js';
import { evaluateRules, matchDomainPattern, type Grant } from './grants.js';
import type { ResolvedUrl } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

const logger = createLogger('brokers/net');

/**
 * The manifest half — synchronous, and byte-for-byte
 * `permissions.ts:checkNetworkPermission`. This is the one the ladder ran, so it
 * is the one `checkPermission`'s legacy adapter keeps calling.
 */
export function authorizeNetDomain(grant: Grant, domain: string): Verdict {
  const verdict = evaluateRules(grant, 'net', (pattern) => matchDomainPattern(pattern, domain));
  if (verdict.decided && verdict.allowed) return allow(verdict.pattern);
  if (verdict.decided && !verdict.allowed) {
    return deny('ladder-parity', verdict.pattern, `Network access not allowed for domain: ${domain}`);
  }
  const configured = grant.manifest.network_domains;
  if (configured === 'none') {
    return deny('ladder-parity', 'network-none', 'Network access is not permitted for this agent');
  }
  if (Array.isArray(configured)) {
    return deny('ladder-parity', 'no-domain-grant', `Network access not allowed for domain: ${domain}`);
  }
  return deny('ladder-parity', 'network-unconfigured', 'Network access not configured');
}

/**
 * `authorize(grant, {kind:'net', resource})` — the manifest half, then the
 * public-internet half.
 */
export async function authorizeNet(grant: Grant, resource: ResolvedUrl): Promise<Verdict> {
  const domainVerdict = authorizeNetDomain(grant, resource.hostname);
  if (!domainVerdict.allowed) return domainVerdict;

  if (resource.protocol !== 'http:' && resource.protocol !== 'https:') {
    return deny(
      'ladder-parity',
      'net-guard:scheme',
      `Blocked: outbound web tools only speak http and https, not "${resource.protocol}" (${resource.raw}).`,
      `[BLOCKED] Blocked: outbound web tools only speak http and https, not "${resource.protocol}" (${resource.raw}).`,
    );
  }

  // The literal-IP class answers without any I/O; do it first so the common
  // metadata-endpoint shapes never spend a DNS round trip.
  const literalClass = privateAddressClass(resource.hostname);
  if (literalClass && literalClass !== 'not an IP address') {
    return deny(
      'ladder-parity',
      'net-guard:private-address',
      `Blocked: ${resource.raw} points at ${resource.hostname}, which is a ${literalClass} address. Outbound web tools may only reach public internet addresses.`,
      `[BLOCKED] Blocked: ${resource.raw} points at ${resource.hostname}, which is a ${literalClass} address. Outbound web tools may only reach public internet addresses.`,
    );
  }

  try {
    await assertPublicHttpTarget(resource.href);
  } catch (err) {
    if (err instanceof NetGuardError) {
      return deny('ladder-parity', 'net-guard:private-address', err.message, `[BLOCKED] ${err.message}`);
    }
    // A genuine DNS failure. Nothing was reached either way; the egress guard at
    // the real request will produce the friendly "does not resolve" answer.
    logger.info('net broker deferring an unresolved target to the egress guard', {
      host: resource.hostname,
      error: err instanceof Error ? err.message : String(err),
    });
    return allow('net-grant:unresolved-at-gate');
  }

  return allow(domainVerdict.rule);
}
