// The proc broker DECIDES, this CARRIES: ONE spawn site, only the gate-resolved program, and no shell.

import { spawn, type ChildProcessByStdio, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable } from 'node:stream';
import { requireAuthorized } from './capability.js';
import { endsWithTheStop } from './proc-tree.js';

// stdin is opened only when the caller writes to it; otherwise a command reading it sees end of input at once.
export type PipedChild = ChildProcessWithoutNullStreams;
export function spawnAuthorized(file: string, argv: readonly string[], options: { cwd?: string; stdin: 'pipe' }): PipedChild;
export function spawnAuthorized(file: string, argv: readonly string[], options?: { cwd?: string }): ChildProcessByStdio<null, Readable, Readable>;
export function spawnAuthorized(
  file: string,
  argv: readonly string[],
  options?: { cwd?: string; stdin?: 'pipe' },
): ChildProcessByStdio<null, Readable, Readable> | ChildProcessWithoutNullStreams {
  const { agentId } = requireAuthorized({ op: 'proc', program: file });
  // detached: the child leads its OWN group, so the owner's Stop ends the whole tree (proc-tree.ts).
  const child = spawn(file, [...argv], {
    ...(options?.cwd ? { cwd: options.cwd } : {}), detached: true, stdio: [options?.stdin ?? 'ignore', 'pipe', 'pipe'],
  });
  endsWithTheStop(agentId, child);
  return child as ChildProcessByStdio<null, Readable, Readable> | ChildProcessWithoutNullStreams;
}
