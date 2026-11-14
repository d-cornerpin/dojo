// Two questions, and they stay two: may this agent reach this domain (the manifest half,
// synchronous), and is the target on the public internet (DNS, via assertPublicHttpTarget,
// called not re-derived). A DNS FAILURE IS NEVER A REFUSAL: only a NetGuardError refuses
// here; anything else defers to the egress guard that runs at the actual request.

import { assertPublicHttpTarget, NetGuardError, privateAddressClass } from '../net-guard.js';
import { isPrimaryAgent } from '../../config/platform.js';
import { createLogger } from '../../logger.js';
import { evaluateRules, matchDomainPattern, type Grant } from './grants.js';
import type { ResolvedUrl } from './resolve.js';
import { allow, deny, type Verdict } from './types.js';

const logger = createLogger('brokers/net');

/** The manifest half, synchronous and byte-for-byte `permissions.ts:checkNetworkPermission`:
 *  the answer `checkPermission`'s legacy adapter keeps calling. */
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

/** `authorize(grant, {kind:'net', resource})`: the manifest half, then the public-internet half. */
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

  // The main agent reaches router/printer/local addresses; every other agent keeps the guard.
  if (isPrimaryAgent(grant.agentId)) return allow(domainVerdict.rule);

  // Literal-IP class answers without I/O, asked first: metadata shapes never spend a DNS round trip.
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
    // A genuine DNS failure: nothing was reached; the egress guard gives the friendly message.
    logger.info('net broker deferring an unresolved target to the egress guard', {
      host: resource.hostname,
      error: err instanceof Error ? err.message : String(err),
    });
    return allow('net-grant:unresolved-at-gate');
  }

  return allow(domainVerdict.rule);
}
