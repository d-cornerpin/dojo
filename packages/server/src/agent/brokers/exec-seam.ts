// ════════════════════════════════════════════════════════════════════════════
// THE EXEC SEAM (PHASE-5 T3, RULING P5-R3) — ONE function, two callers, and the
// reason it exists is that they used to be two functions that agreed by accident.
//
// `destructive-gate.ts` holds a call it documents, in its own words, as
// *"the EXACT call executeTool makes"*. Before T3 that was literally true by
// coincidence of spelling: both sides wrote
// `checkPermission(agentId,{type:'exec',command:String(args.command ?? '')})`.
// The moment exec's shape moved to `{argv}`, both sides kept compiling and both
// sides started asking about the EMPTY STRING — the gate would have filed an
// approval for a command nobody typed, and the executor would have refused a
// command the approver never saw.
//
// So "the exact call" stops being a comment and becomes a function. The
// dispatcher's `proc`/`shell` gate rows call it, and the destructive gate's
// pre-hold check calls it. There is no second implementation to drift.
//
// ── WHAT IT REFUSES, AND WHY REFUSING IS THE POINT ──
// A shape it cannot resolve — no argv, a string where argv belongs, an empty
// vector, a non-string script — is REFUSED. Never defaulted, never coerced, and
// above all never treated as an empty command that everything permits. An
// approval seam evaluating an empty string is the incident class this phase
// exists to refuse, and it is the only thing in this file worth memorising.
// ════════════════════════════════════════════════════════════════════════════

import { authorizeArgv, authorizeShellScript } from './proc.js';
import { resolveArgvArg, resolveCommandArg } from './resolve.js';
import type { Grant } from './grants.js';
import { deny, type Verdict } from './types.js';

/** Which door a tool name speaks to. Anything else is not an exec-shaped call. */
export type ExecDoor = 'proc' | 'shell';

export function execDoorFor(toolName: string): ExecDoor | null {
  if (toolName === 'exec') return 'proc';
  if (toolName === 'shell') return 'shell';
  return null;
}

/** The argument each door reads. Kept beside the door so a rename moves once. */
export const EXEC_DOOR_ARG: Readonly<Record<ExecDoor, string>> = { proc: 'argv', shell: 'script' };

/**
 * THE EXACT CALL. Resolve this call's own resource, then authorize it against
 * this agent's grant.
 *
 * `raw` is passed rather than read from `args` so the caller that already has
 * the resource (the dispatcher, which reads it from the tool's DECLARED effect)
 * and the caller that only has the argument object (the approval gate) reach the
 * same function without either of them re-deriving where the resource lives.
 */
export function authorizeExecShapedCall(grant: Grant, door: ExecDoor, raw: unknown): Verdict {
  if (door === 'proc') {
    const resolved = resolveArgvArg(raw);
    if (!resolved.ok) {
      return deny('ladder-parity', `exec-shape:${resolved.code}`, resolved.reason);
    }
    return authorizeArgv(grant, resolved.value);
  }
  const resolved = resolveCommandArg(raw);
  if (!resolved.ok) {
    return deny('ladder-parity', `shell-shape:${resolved.code}`, resolved.reason);
  }
  return authorizeShellScript(grant, resolved.value);
}

/** The same question asked of an argument OBJECT, for callers outside the
 *  dispatcher that never see the declared effect. */
export function authorizeExecShapedArgs(
  grant: Grant,
  toolName: string,
  args: Record<string, unknown>,
): Verdict | null {
  const door = execDoorFor(toolName);
  if (!door) return null;
  return authorizeExecShapedCall(grant, door, args[EXEC_DOOR_ARG[door]]);
}

/**
 * THE TEXT AN EXEC-SHAPED CALL WOULD RUN, for classifiers and audit rows.
 *
 * One owner for "what did this call actually ask to run", because the
 * destructive classifier, the audit row and the approval description all need it
 * and three answers is how one of them goes stale. Returns `null` for a call
 * whose shape is unreadable, which callers must treat as *unknown*, never as
 * *harmless* — the `{}` case is what P5-R3 is about.
 */
export function execCallText(toolName: string, args: Record<string, unknown>): string | null {
  const door = execDoorFor(toolName);
  if (!door) return null;
  const raw = args[EXEC_DOOR_ARG[door]];
  if (door === 'proc') {
    if (Array.isArray(raw) && raw.every((e) => typeof e === 'string') && raw.length > 0) {
      return (raw as string[]).join(' ');
    }
    // The legacy `{command}` spelling, still answered for as long as anything
    // can emit it (a replayed transcript, a stored approval row).
    if (typeof args.command === 'string' && args.command.length > 0) return args.command;
    return null;
  }
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof args.command === 'string' && args.command.length > 0) return args.command;
  return null;
}
