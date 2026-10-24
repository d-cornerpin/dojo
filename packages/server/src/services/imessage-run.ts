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
// Same argv and the same bounds as before. `spawn`, not `execFile`: execFile cannot make the child
// a group leader, and without `detached` the Stop's group kill would miss what the program started.
// The bound and the output cap keep execFile's own semantics: SIGTERM to the tree at `timeout`, and
// Node's documented 1 MiB `maxBuffer` default per stream.
//
// A run the Stop cut rejects with `cutByTheStop: true`, so the bridge does not mistake it for a
// broken program and retry the send another way.
//
// The bridge's two other process calls moved here with it, unchanged, so the bridge itself holds
// no `child_process`: the imsg runnability probe (once per process, at first use) and the HEIC to
// JPEG conversion of an inbound photo (macOS's own `sips`).
// ════════════════════════════════════════════════════════════════════════════

import { execFileSync, execSync, spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { homeDir } from '../home.js';
import { endsWithTheStop, signalProcessTree, KILL_GRACE_MS } from '../agent/effects/proc-tree.js';
import { untilUserStop } from '../agent/stop-waiters.js';

/** The rejection of a run the owner's Stop ended. */
export type CutByTheStop = Error & { readonly cutByTheStop: true };

export function wasCutByTheStop(err: unknown): err is CutByTheStop {
  return err instanceof Error && (err as Partial<CutByTheStop>).cutByTheStop === true;
}

/** The rejection of a run that never started, because the owner's Stop was already standing. */
export function wasNeverStarted(err: unknown): boolean {
  return err instanceof Error && (err as { neverStarted?: boolean }).neverStarted === true;
}

export function runMessagesProgram(program: string, argv: readonly string[], opts: { timeout: number; agentId?: string }): Promise<string> {
  const maxBuffer = 1024 * 1024;   // Node's documented execFile default, made explicit
  return new Promise((resolve, reject) => {
    const stop = opts.agentId === undefined ? null : untilUserStop(opts.agentId);
    let cut = false;
    // Fix round 1: a run the standing Stop kept from starting is NOT a cut send — nothing went out.
    if (stop?.already === true) { stop.dispose(); reject(Object.assign(new Error(`${program}: not started, the agent was stopped`), { neverStarted: true })); return; }
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(program, [...argv], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { stop?.dispose(); reject(err); return; }   // fix round 1: the waiter is not left behind
    if (opts.agentId !== undefined) endsWithTheStop(opts.agentId, child);
    void stop?.stopped.then(() => { cut = true; });
    let stdout = '';
    let stderr = '';
    let fault: string | null = null;
    let closed = false;
    // Fix round 1: the bound escalates like the Stop does (proc-tree.ts): SIGTERM to the group, then
    // SIGKILL after the same grace, so a program that ignores SIGTERM cannot leave the send pending.
    const end = (why: string): void => {
      fault ??= why;
      signalProcessTree(child, 'SIGTERM');
      setTimeout(() => { if (!closed) signalProcessTree(child, 'SIGKILL'); }, KILL_GRACE_MS).unref();
    };
    const bound = setTimeout(() => end(`timed out after ${opts.timeout} ms`), opts.timeout);
    const done = (): void => { closed = true; clearTimeout(bound); stop?.dispose(); };
    child.stdout.setEncoding('utf-8').on('data', (d: string) => { stdout += d; if (stdout.length > maxBuffer) end('stdout maxBuffer exceeded'); });
    child.stderr.setEncoding('utf-8').on('data', (d: string) => { stderr += d; if (stderr.length > maxBuffer) end('stderr maxBuffer exceeded'); });
    child.once('error', (err) => { done(); reject(Object.assign(err, { stderr })); });
    child.once('close', (code, signal) => {
      done();
      // An exit 0 sent, even if the Stop landed at that instant: the owner then hears it went out.
      if (code === 0 && fault === null) { resolve(stdout); return; }
      const why = cut ? 'ended by the owner\'s Stop' : fault ?? (signal ? `ended by ${signal}` : `exited with code ${code}`);
      reject(Object.assign(new Error(`${program} ${argv[0] ?? ''} failed (${why})${stderr ? `\n${stderr}` : ''}`), { stderr, status: code, ...(cut ? { cutByTheStop: true as const } : {}) }));
    });
  });
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
