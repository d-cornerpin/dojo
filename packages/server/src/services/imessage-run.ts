// ════════════════════════════════════════════════════════════════════════════
// THE iMESSAGE PROGRAMS' RUNNER (v3.5 E19b) — the one way a send starts `imsg` or `osascript`.
//
// Every iMessage send used to run its program synchronously (`execFileSync(imsg, ['send', …])`,
// `execSync(osascript …)`). That held the server's event loop for as long as the send took — up to
// its 15 s / 30 s bound — so nothing else ran meanwhile, and the stop race could not even see the
// owner's Stop until the child returned; nothing ended the child either.
//
// Now the program runs asynchronously. A send an AGENT makes (the `imessage_send` tool) passes its
// agent id and is bound to the owner's Stop through the toolbox's existing door
// (`agent/effects/proc-tree.ts`): the Stop ends the whole process group. A platform send (an owner
// notice, the auto-route) passes none and is bound to nobody's Stop.
//
// Same argv and the same bounds as before. The runner itself (spawn detached, the Stop door, the
// bound's SIGTERM then SIGKILL, never-started and cut-by-the-Stop rejections) is the ONE runner in
// `agent/stop-bound-run.ts`, which the screen-control tools use too.
//
// The bridge's two other process calls moved here with it, unchanged, so the bridge itself holds
// no `child_process`: the imsg runnability probe (once per process, at first use) and the HEIC to
// JPEG conversion of an inbound photo (macOS's own `sips`).
// ════════════════════════════════════════════════════════════════════════════

import { execFileSync, execSync } from 'node:child_process';
import { homeDir } from '../home.js';
import { runBoundToTheStop } from '../agent/stop-bound-run.js';

export { wasCutByTheStop, wasNeverStarted, type CutByTheStop } from '../agent/stop-bound-run.js';

/** A send's program (imsg or osascript), through the one runner the screen-control tools use too. */
export function runMessagesProgram(program: string, argv: readonly string[], opts: { timeout: number; agentId?: string }): Promise<string> {
  return runBoundToTheStop(program, argv, opts);
}

export const IMSG_CANDIDATE_PATHS = ['/opt/homebrew/bin/imsg', '/usr/local/bin/imsg', `${homeDir()}/.dojo/bin/imsg`];

function findImsg(): string | null {
  // Select the first candidate that actually RUNS, not the first that exists.
  // Production 2026-07-18: a root-owned broken install at /opt/homebrew/bin
  // (resource bundle missing, crashes at launch) shadowed the healthy copy the
  // boot self-heal had planted lower in this list, because the unprivileged
  // repair cannot overwrite a sudo-installed file and existence-first selection
  // kept choosing the crasher. Any invocation loads the PhoneNumberKit bundle,
  // so a --help probe discriminates broken from healthy; the result is cached
  // by getImsgPath, so the probe cost is paid once per process.
  for (const p of IMSG_CANDIDATE_PATHS) {
    try {
      // A candidate that does not exist throws ENOENT here, like a broken one (E19b: no fs import).
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

/** An inbound HEIC photo, as JPEG (vision models don't accept HEIC), via macOS's built-in `sips`.
 *  Moved here unchanged from the bridge (E19b). Throws on failure; 30 s is generous for any iPhone photo. */
export function convertHeicToJpeg(srcPath: string, destPath: string): void {
  execSync(
    `sips -s format jpeg ${JSON.stringify(srcPath)} --out ${JSON.stringify(destPath)}`,
    { stdio: 'pipe', timeout: 30_000 },
  );
}
