// ════════════════════════════════════════════════════════════════════════════
// THE PER-CALL AUTHORIZATION CAPABILITY (PHASE-5 T8 Step 2, RULING P5-R14).
//
// Phase 5 moved permission decisions from a name-ladder at one entrance to
// `authorize(grant, effect)` at the real doors. **What it built DECIDES. This is
// what CARRIES.** The residual it closes, stated as the requirement it failed:
// *a handler that acted on a resource it never declared would not be seen by the
// check* — because the authorized handler still called `fs`/`child_process`
// itself, with whatever path it liked.
//
// ── THE SHAPE, AND WHY IT IS NOT A SECOND PERMISSION SYSTEM ──
// RULING P5-R14: **declaration-match enforcement.** Before dispatch the gate
// loop resolves the tool's DECLARED effects against the real arguments and mints
// a capability listing the resources that call is authorized to touch. The
// facade (`effects/fs.ts`, `effects/proc.ts`, `effects/net.ts`) performs the I/O
// and refuses any resource the capability does not name.
//
// There is no barrel over this directory and that is deliberate: every consumer
// imports the entry it needs, so each module stays a leaf that cannot close a
// cycle back into the toolbox. `net` has no entry yet, and that is a measurement
// rather than an oversight — the restricted-import surface this task flips
// (`eslint.config.js` RESTRICTED_EFFECT_MODULES) names `fs` and `child_process`
// only, and an entry nothing calls is unexercised code pretending to be a lock.
// It lands with the category that needs it, with a test that drives it.
//
// Refusing a resource the capability does not name is the LOCK PROPERTY, not a
// policy judgement: **the brokers still DECIDE every allow/deny**, and nothing
// here holds a permission table, an allow list or a deny predicate. What lives
// here is a set-membership test over resources somebody else already decided
// about. If a future edit needs this module to make a judgement of its own, the
// design has gone wrong and the work hands up (the task's STOP condition 2).
//
// ── UNFORGEABLE, AND WHY THAT IS STRUCTURAL RATHER THAN HOPED ──
// A handler cannot hand the facade a capability, because **no facade entry takes
// one as a parameter.** The capability rides `AsyncLocalStorage` — the same
// primitive and for the same reason as `turn-state.ts`'s tool-call identity —
// and the only writer is `mintCallCapability`, whose single production caller is
// the executor's gate loop. `effects/__tests__/facade-contract.test.ts` holds
// that census from source, so a second minting site fails the build naming
// itself. A brand keeps the type unconstructible outside this file.
//
// ── PER CALL MEANS PER CALL, AND IT IS DERIVED RATHER THAN REMEMBERED ──
// A capability answers only inside the async context of the tool call it was
// minted for, and that is not a flag somebody has to clear: it is read from the
// platform's OWN per-call identity (`turn-state.ts`, opened once at the single
// door every dispatch path goes through). A capability that leaked into a
// sibling call is dead — `getCurrentToolCallId` answers only for a matching
// agent, so it cannot be borrowed across identities either. The difference this
// makes: "the authorization was for THAT call" instead of "for that agent,
// roughly, for a while".
//
// ── WHAT "THE CALL" INCLUDES, MEASURED RATHER THAN ASSUMED (T8D) ──
// An earlier wording of this header said a fire-and-forget continuation that
// outlives its dispatch holds a DEAD capability. **It was tested and it is not
// true**, and the distinction is load-bearing for every category still to
// convert, so it is written here and pinned by two clauses in
// `__tests__/facade-contract.test.ts` rather than left as prose:
//
//   * work STARTED INSIDE the dispatch — `void (async () => { … })()`, a
//     `setTimeout`, a callback registered there — inherits the call's async
//     context and therefore holds a LIVE capability for as long as it runs.
//     That is correct and is the property the media/canvas doors depend on:
//     it is still THAT call's work, and it can still only touch resources THAT
//     call declared. `image_create` answers the model immediately and delivers
//     the image from such a continuation.
//   * work reached from ANOTHER context — a poller loop or watcher started at
//     boot, an HTTP route, a callback invoked later from outside the chain —
//     holds NOTHING, and a converted site there refuses.
//
// So "can this file convert?" is not answered by *when* the I/O happens. It is
// answered by *whose async context it happens in*, which is a caller-chain
// question and is why every category establishes that chain by reading before
// it converts.
// ════════════════════════════════════════════════════════════════════════════

import { AsyncLocalStorage } from 'node:async_hooks';
import { createLogger } from '../../logger.js';
import { getCurrentToolCallId } from '../turn-state.js';

const logger = createLogger('effects');

declare const CAPABILITY_BRAND: unique symbol;

/** An fs kind, spelled as the registry spells it. */
export type FsGrantKind = 'fs_read' | 'fs_write' | 'fs_delete';

/**
 * ONE resource this call is authorized to touch, as the gate loop resolved it.
 *
 * `at:'path'` carries BOTH spellings for the same reason `ResolvedPath` does: a
 * match on the lexical name alone is walked around with a symlink, and a match
 * on the real name alone refuses a legitimate path whose parent is a link.
 */
export type ResourceGrant =
  | { readonly kind: FsGrantKind; readonly at: 'path'; readonly lexical: string; readonly real: string }
  | { readonly kind: FsGrantKind; readonly at: 'tree'; readonly root: string }
  | { readonly kind: 'proc' | 'shell'; readonly program: string; readonly display: string }
  | { readonly kind: 'net'; readonly host: string };

/** What the facade is about to do. The unit is one syscall-shaped operation. */
export type EffectRequest =
  /**
   * Read the bytes or the listing of a path.
   *
   * BOTH spellings ride every fs request, for the reason `ResolvedPath` carries
   * both: a match on the lexical name alone is walked around with a symlink, and
   * a match on the real name alone refuses a legitimate path whose parent
   * directory happens to be a link.
   */
  | { readonly op: 'fs_read'; readonly path: string; readonly real: string }
  /** Create or modify a path. */
  | { readonly op: 'fs_write'; readonly path: string; readonly real: string }
  /** Remove a path. */
  | { readonly op: 'fs_delete'; readonly path: string; readonly real: string }
  /**
   * Ask whether a path exists / what it is. Authorized by ANY fs grant naming
   * it: being authorized to WRITE a path already tells you whether it is there,
   * so requiring a separate read grant would refuse `file_write`'s own
   * is-this-a-directory probe — a narrowing, not a lock.
   */
  | { readonly op: 'fs_stat'; readonly path: string; readonly real: string }
  /**
   * Create a directory. Authorized by an fs_write grant on something INSIDE it
   * (`mkdir -p` of a granted file's parent) or by a write tree containing it.
   * The rule is the gate loop's, expressed once, here — never a per-tool list.
   */
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

const capabilityContext = new AsyncLocalStorage<CallCapability>();

/**
 * MINT. The ONE writer, and its single production caller is the executor's gate
 * loop — held by a census from source, not by this comment.
 *
 * It takes resources somebody else resolved and decided about; it computes no
 * permission of its own.
 */
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

/**
 * Attach a capability to the current tool execution.
 *
 * `enterWith` rather than `run`: the executor's dispatch is a 380-line body with
 * early returns at every guard, and wrapping it in a callback would have been a
 * mechanism change dressed as plumbing. The context this enters is already ONE
 * PER TOOL CALL (`turn-state.ts` opens it), and that same context is what makes
 * the capability expire — see `currentCapability`.
 */
export function attachCallCapability(capability: CallCapability): void {
  capabilityContext.enterWith(capability);
}

/**
 * The capability of the call the caller is inside, or null outside one.
 *
 * The liveness test is the platform's own per-call identity, not a flag: a
 * capability minted for call X answers only while call X is the execution the
 * caller is inside, for the agent it was minted for.
 */
export function currentCapability(): CallCapability | null {
  const cap = capabilityContext.getStore();
  if (!cap) return null;
  if (getCurrentToolCallId(cap.agentId) !== cap.callId) return null;
  return cap;
}

/**
 * A facade call the capability does not cover.
 *
 * It is a THROW rather than a returned verdict on purpose: every converted call
 * site used to be a raw `fs`/`child_process` call whose failure mode was a
 * throw, so the executor's existing catch already renders it, and no handler can
 * carry on having silently not done the work.
 */
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

/**
 * THE MATCH. Pure set membership over resources the brokers already decided
 * about — no rule of its own, which is what keeps one owner per job.
 */
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

/**
 * The grant and the request name the SAME file — asked of both spellings, so a
 * symlink cannot make one path look like another and a link in a parent
 * directory cannot make a legitimate path look foreign.
 */
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

/**
 * THE ONE ENTRY EVERY FACADE OPERATION GOES THROUGH.
 *
 * No capability at all is refused exactly as an unnamed resource is: the point
 * of the layer is that the I/O cannot happen without the gate loop's decision
 * for THAT call, and "there was no decision" is the strongest form of that.
 */
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
    // A refusal on driven traffic is BLOCKED until adjudicated (RULING P5-R14):
    // this line is the durable sink that says which declaration was too narrow.
    logger.error('facade refused a resource the call never declared', {
      tool: capability.tool, callId: capability.callId, request,
      grants: capability.grants.map((g) => ('at' in g ? `${g.kind}:${g.at}` : g.kind)),
    }, capability.agentId);
    throw new EffectNotAuthorized(message, request, capability.tool, capability.agentId);
  }
  return capability;
}
