// The proc broker DECIDES, this CARRIES: ONE spawn site, only the gate-resolved program, and no shell.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { requireAuthorized } from './capability.js';
import { endsWithTheStop } from './proc-tree.js';

export function spawnAuthorized(
  file: string,
  argv: readonly string[],
  options?: { cwd?: string },
): ChildProcessWithoutNullStreams {
  const { agentId } = requireAuthorized({ op: 'proc', program: file });
  // detached: the child leads its OWN group, so the owner's Stop ends the whole tree (proc-tree.ts).
  const child = spawn(file, [...argv], { ...(options?.cwd ? { cwd: options.cwd } : {}), detached: true });
  endsWithTheStop(agentId, child);
  return child;
}
