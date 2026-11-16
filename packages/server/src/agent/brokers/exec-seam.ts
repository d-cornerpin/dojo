// One function, both callers, so the two exec authorization calls never drift; an
// unresolvable shape is REFUSED, never defaulted: an empty command must never pass.

import { authorizeArgv, authorizeProc } from './proc.js';
import { resolveArgvArg, resolveCommandArg } from './resolve.js';
import type { Grant } from './grants.js';
import { deny, type Verdict } from './types.js';
import { redirectDojoQuestion } from './dojo-redirect.js';

export type ExecDoor = 'proc' | 'shell';

export function execDoorFor(toolName: string): ExecDoor | null {
  if (toolName === 'exec') return 'proc';
  if (toolName === 'shell') return 'shell';
  return null;
}

export const EXEC_DOOR_ARG: Readonly<Record<ExecDoor, string>> = { proc: 'argv', shell: 'script' };

/** Resolve this call's resource, then authorize it; `raw` saves both callers re-deriving where it lives. */
export function authorizeExecShapedCall(grant: Grant, door: ExecDoor, raw: unknown): Verdict {
  if (door === 'proc') {
    const resolved = resolveArgvArg(raw);
    if (!resolved.ok) {
      return deny('ladder-parity', `exec-shape:${resolved.code}`, resolved.reason);
    }
    const verdict = authorizeArgv(grant, resolved.value);
    return verdict.allowed ? redirectDojoQuestion(grant.agentId, resolved.value.argv) ?? verdict : verdict;
  }
  const resolved = resolveCommandArg(raw);
  if (!resolved.ok) {
    return deny('ladder-parity', `shell-shape:${resolved.code}`, resolved.reason);
  }
  const verdict = authorizeProc(grant, resolved.value);
  // The Dojo database door: asked only of lines the broker allowed, so it can refuse, never permit.
  return verdict.allowed ? redirectDojoQuestion(grant.agentId, resolved.value.raw) ?? verdict : verdict;
}

export function authorizeExecShapedArgs(
  grant: Grant,
  toolName: string,
  args: Record<string, unknown>,
): Verdict | null {
  const door = execDoorFor(toolName);
  if (!door) return null;
  return authorizeExecShapedCall(grant, door, args[EXEC_DOOR_ARG[door]]);
}

/** The text this call would run, for classifiers, audit lines and approval descriptions.
 *  null for a call whose shape cannot be read: unknown, never harmless. */
export function execCallText(toolName: string, args: Record<string, unknown>): string | null {
  const door = execDoorFor(toolName);
  if (!door) return null;
  const raw = args[EXEC_DOOR_ARG[door]];
  if (door === 'proc') {
    if (Array.isArray(raw) && raw.every((e) => typeof e === 'string') && raw.length > 0) {
      return (raw as string[]).join(' ');
    }
    // The legacy `{command}` spelling still answers: stored approval rows and replays may emit it.
    if (typeof args.command === 'string' && args.command.length > 0) return args.command;
    return null;
  }
  if (typeof raw === 'string' && raw.length > 0) return raw;
  if (typeof args.command === 'string' && args.command.length > 0) return args.command;
  return null;
}
