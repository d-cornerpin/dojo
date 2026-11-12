// Runs `imsg` and `osascript` asynchronously, so a send never blocks the event loop.
// An agent's send is cut by the owner's Stop (`agent/effects/proc-tree.ts`); a platform send binds to no Stop.
// The spawn and timeout runner is `agent/stop-bound-run.ts`. Also holds the imsg probe and HEIC conversion.

import { execFileSync, execSync } from 'node:child_process';
import { homeDir } from '../home.js';
import { runBoundToTheStop } from '../agent/stop-bound-run.js';

export { wasCutByTheStop, wasNeverStarted, type CutByTheStop } from '../agent/stop-bound-run.js';

export function runMessagesProgram(program: string, argv: readonly string[], opts: { timeout: number; agentId?: string }): Promise<string> {
  return runBoundToTheStop(program, argv, opts);
}

export const IMSG_CANDIDATE_PATHS = ['/opt/homebrew/bin/imsg', '/usr/local/bin/imsg', `${homeDir()}/.dojo/bin/imsg`];

function findImsg(): string | null {
  // Pick the first imsg that RUNS (a --help probe), not the first that exists: a broken install must not win.
  for (const p of IMSG_CANDIDATE_PATHS) {
    try {
      execFileSync(p, ['--help'], { timeout: 10000, encoding: 'utf-8', stdio: 'pipe' });
      return p;
    } catch { /* missing, exists but broken, or probe failed: try the next candidate */ }
  }
  try {
    execSync('which imsg', { encoding: 'utf-8', stdio: 'pipe' });
    execFileSync('imsg', ['--help'], { timeout: 10000, encoding: 'utf-8', stdio: 'pipe' });
    return 'imsg';
  } catch {
    return null;
  }
}

let imsgPathCached: string | null | undefined = undefined;
export function getImsgPath(): string | null {
  if (imsgPathCached === undefined) imsgPathCached = findImsg();
  return imsgPathCached;
}

export function convertHeicToJpeg(srcPath: string, destPath: string): void {
  // HEIC to JPEG (vision models reject HEIC). Argument array, no shell: the file name comes from the sender's phone.
  execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', srcPath, '--out', destPath], { stdio: 'pipe', timeout: 30_000 });
}
