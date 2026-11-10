// THE PER-CALL AUTHORIZATION CAPABILITY: the gate loop mints a capability listing the resources this
// call declared; the facade performs I/O only for those. The brokers DECIDE, this is set membership
// over what they decided: no permission table, allow list or deny predicate is the design.
// Unforgeable, not hoped: no entry takes a capability as a parameter; it rides AsyncLocalStorage,
// mintCallCapability is its only writer (a census holds), a brand bars construction outside this file,
// and currentCapability tests the platform's per-call identity, so a leaked or stale one is dead.
// No barrel over this directory: every consumer imports its entry, so no module closes a cycle back.

import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../../logger.js';
import { getCurrentToolCallId } from '../turn-state.js';

const logger = createLogger('effects');

declare const CAPABILITY_BRAND: unique symbol;

export type FsGrantKind = 'fs_read' | 'fs_write' | 'fs_delete';

/** ONE resource this call may touch; at:'path' carries lexical AND real names against symlinks. */
export type ResourceGrant =
  | { readonly kind: FsGrantKind; readonly at: 'path'; readonly lexical: string; readonly real: string }
  | { readonly kind: FsGrantKind; readonly at: 'tree'; readonly root: string }
  | { readonly kind: 'proc' | 'shell'; readonly program: string; readonly display: string }
  | { readonly kind: 'net'; readonly host: string };

/** What the facade is about to do; the unit is one syscall-shaped operation. */
export type EffectRequest =
  /** Read bytes or the listing of a path; every fs request carries both spellings. */
  | { readonly op: 'fs_read'; readonly path: string; readonly real: string }
  | { readonly op: 'fs_write'; readonly path: string; readonly real: string }
  | { readonly op: 'fs_delete'; readonly path: string; readonly real: string }
  /** Exists/what-is-it: ANY fs grant naming it authorizes; a write grant already proves the path. */
  | { readonly op: 'fs_stat'; readonly path: string; readonly real: string }
  /** Create a dir: a write INSIDE it or a containing write tree, one rule here, never a per-tool list. */
  | { readonly op: 'fs_mkdir'; readonly path: string; readonly real: string }
  | { readonly op: 'proc'; readonly program: string }
  | { readonly op: 'net'; readonly host: string };

export interface CallCapability {
  readonly agentId: string;
  readonly tool: string;
  readonly callId: string;
  readonly grants: readonly ResourceGrant[];
  readonly [CAPABILITY_BRAND]: true;
}

// Work started inside a dispatch inherits its capability and stays live; pollers and routes hold none.
const capabilityContext = new AsyncLocalStorage<CallCapability>();

/** MINT: the ONE writer, called only by the gate loop (a census holds); it computes no permission. */
export function mintCallCapability(input: {
  agentId: string;
  tool: string;
  callId: string;
  grants: readonly ResourceGrant[];
}): CallCapability {
  return {
    agentId: input.agentId,
    tool: input.tool,
    callId: input.callId,
    grants: input.grants,
  } as unknown as CallCapability;
}

/** enterWith not run: wrapping the early-returning dispatch changes mechanism; the context is per call. */
export function attachCallCapability(capability: CallCapability): void {
  capabilityContext.enterWith(capability);
}

/** The live capability or null outside a call: liveness is the platform's per-call identity, not a flag. */
export function currentCapability(): CallCapability | null {
  const cap = capabilityContext.getStore();
  if (!cap) return null;
  if (getCurrentToolCallId(cap.agentId) !== cap.callId) return null;
  return cap;
}

/** A refusal THROWS rather than returns a verdict: no handler may carry on having silently not done it. */
export class EffectNotAuthorized extends Error {
  readonly request: EffectRequest;
  readonly tool: string;
  readonly agentId: string;
  constructor(message: string, request: EffectRequest, tool: string, agentId: string) {
    super(message);
    this.name = 'EffectNotAuthorized';
    this.request = request;
    this.tool = tool;
    this.agentId = agentId;
  }
}

function describe(request: EffectRequest): string {
  return request.op === 'proc' ? `program ${request.program}`
    : request.op === 'net' ? `host ${request.host}`
      : `${request.op} ${request.path}`;
}

/** THE MATCH. Pure set membership over resources the brokers already decided about. */
export function grantsCover(grants: readonly ResourceGrant[], request: EffectRequest): boolean {
  for (const grant of grants) {
    switch (request.op) {
      case 'fs_read':
      case 'fs_write':
      case 'fs_delete': {
        if (grant.kind !== request.op) break;
        if (grant.at === 'path' && namesSameResource(grant, request)) return true;
        if (grant.at === 'tree' && (withinTree(request.path, grant.root) || withinTree(request.real, grant.root))) return true;
        break;
      }
      case 'fs_stat': {
        if (grant.kind !== 'fs_read' && grant.kind !== 'fs_write' && grant.kind !== 'fs_delete') break;
        if (grant.at === 'path' && namesSameResource(grant, request)) return true;
        if (grant.at === 'tree' && (withinTree(request.path, grant.root) || withinTree(request.real, grant.root))) return true;
        break;
      }
      case 'fs_mkdir': {
        if (grant.kind !== 'fs_write') break;
        // The directory an authorized write needs underneath it.
        if (grant.at === 'path' && (withinTree(grant.lexical, request.path) || withinTree(grant.real, request.real))) return true;
        if (grant.at === 'tree' && (withinTree(request.path, grant.root) || withinTree(grant.root, request.path))) return true;
        break;
      }
      case 'proc': {
        if ((grant.kind === 'proc' || grant.kind === 'shell') && grant.program === request.program) return true;
        break;
      }
      case 'net': {
        if (grant.kind === 'net' && grant.host === request.host) return true;
        break;
      }
    }
  }
  return false;
}

/** Grant and request name the SAME file, asked of both spellings, so a symlink cannot impersonate. */
function namesSameResource(
  grant: { readonly lexical: string; readonly real: string },
  request: { readonly path: string; readonly real: string },
): boolean {
  return grant.lexical === request.path
    || grant.real === request.real
    || grant.lexical === request.real
    || grant.real === request.path;
}

/** `child` is `parent` itself or lives under it. Both are already absolute. */
function withinTree(child: string, parent: string): boolean {
  if (child === parent) return true;
  const root = parent.endsWith('/') ? parent : `${parent}/`;
  return child.startsWith(root);
}

/** THE ONE ENTRY of every facade operation: no capability is refused exactly as an unnamed resource is. */
export function requireAuthorized(request: EffectRequest): CallCapability {
  const capability = currentCapability();
  if (!capability) {
    const message =
      `Effect refused: ${describe(request)} was attempted outside any authorized tool call. ` +
      'The fs/proc/net facade performs work only for a call the gate loop authorized.';
    logger.error('facade call with no live capability', { request });
    throw new EffectNotAuthorized(message, request, '(none)', '(none)');
  }
  if (!grantsCover(capability.grants, request)) {
    const message =
      `Effect refused: ${capability.tool} is not authorized for ${describe(request)}. ` +
      'It reaches beyond the resources this call declared.';
    // This log line is the durable record of which declaration was too narrow.
    logger.error('facade refused a resource the call never declared', {
      tool: capability.tool, callId: capability.callId, request,
      grants: capability.grants.map((g) => ('at' in g ? `${g.kind}:${g.at}` : g.kind)),
    }, capability.agentId);
    throw new EffectNotAuthorized(message, request, capability.tool, capability.agentId);
  }
  return capability;
}
