// ════════════════════════════════════════════════════════════════════════════
// THE COMMANDS THE DOJO RUNS ON THIS MAC TO LOOK AFTER ITS OLLAMA (v3.5, moved out of `ollama-model-limit.ts`
// and extended by Fix W): who listens on Ollama's port, which program that really is, launchd's environment,
// the Ollama app's processes, Homebrew, and a `serve` of the Dojo's own. Every command is behind the
// `OllamaHost` seam so a test reads the argv of the real ones and runs fakes for the rest; a test run never
// reaches the real set (`getOllamaHost`).
// ════════════════════════════════════════════════════════════════════════════

import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { homeDir, isTestRun } from '../home.js';
import { checkOllamaHealth } from './ollama.js';
import { attachIdleBound, type WatchableChild } from '../child-idle-bound.js';

/** How Ollama's own CLI waits after it opens the Mac app (`cmd/start.go waitForServer`: a heartbeat every
 *  500 ms, given up after 5 s). The Dojo waits the same way for the app to quit and to answer again. */
export const TICK_MS = 500;
export const WAIT_MS = 5_000;
/** An installer is idle-bounded like setup's (`gateway/routes/setup-deps.ts`, t114): talking keeps it going. */
const BREW_IDLE_MS = 90_000;
const BREW_CEILING_MS = 60 * 60_000;
const BREW_SERVICE = 'homebrew.mxcl.ollama';

export interface OllamaHost {
  /** The launchd value, or null when unset (an unset variable reads as unset however launchctl reports it). */
  getenv(name: string): Promise<string | null>;
  setenv(name: string, value: string): Promise<void>;
  /** The process listening on the local Ollama's port, with the REAL executable it runs (links resolved), or null. */
  listener(port: number): Promise<{ pid: number; path: string } | null>;
  /** The Ollama app's own processes (`pgrep -x Ollama`, case-sensitive: Homebrew's server is `ollama`). */
  appPids(): Promise<number[]>;
  appInstalled(): Promise<boolean>;
  terminate(pid: number): void;
  alive(pid: number): boolean;
  launchApp(): Promise<void>;
  answers(baseUrl: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  /** The pid of Homebrew's launchd job for Ollama when it is loaded and running, else null. */
  brewServicePid(): Promise<number | null>;
  hasBrew(): Promise<boolean>;
  /** `brew <args>`, under the installer idle bound; rejects when brew fails. */
  brew(args: string[]): Promise<void>;
  /** `brew services restart ollama`: launchd starts the job again, with launchd's environment. */
  restartBrewService(): Promise<void>;
  /** `ollama serve` as a child of the Dojo, with `env` added to the Dojo's own. */
  startServe(env: Record<string, string>): void;
}

type Run = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
type Kill = (pid: number, signal: NodeJS.Signals | 0) => boolean;

const BREW_PATHS = ['/opt/homebrew/bin/brew', '/usr/local/bin/brew'];
/** launchd has a minimal PATH: the Homebrew locations first (the same list setup's installer uses). */
const EXTENDED_PATH = `/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`;

/** The real commands, built over `run`/`kill`/`spawnChild`/`serve` so a test can read their argv without running any. */
export function makeRealDeps(
  run: Run, kill: Kill, spawnChild: (cmd: string, args: string[]) => WatchableChild, serve: (env: Record<string, string>) => void = () => undefined,
): OllamaHost {
  const pids = (out: string): number[] => out.split('\n').map((l) => parseInt(l, 10)).filter((n) => Number.isInteger(n) && n > 0);
  const brewPath = async (): Promise<string | null> => {
    for (const p of BREW_PATHS) { try { await run('/bin/test', ['-x', p]); return p; } catch { /* not here */ } }
    return null;
  };
  return {
    getenv: async (name) => { try { return (await run('launchctl', ['getenv', name])).stdout.trim() || null; } catch { return null; } },
    setenv: async (name, value) => { await run('launchctl', ['setenv', name, value]); },
    listener: async (port) => {
      try {
        const [pid] = pids((await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).stdout);
        if (!pid) return null;
        // The program the process really runs: its first text mapping (`-d txt`), which lsof reports as the file on
        // disk, links resolved. `ps -o comm=` reports the path it was STARTED by, so a `serve` started through the
        // CLI link into the app read as not the app (field failure, Fix W).
        const fields = (await run('lsof', ['-nP', '-a', '-p', String(pid), '-d', 'txt', '-Fn'])).stdout.split('\n');   // `f<fd>` then `n<path>`, per mapping
        const mapped = fields.slice(fields.indexOf('ftxt') + 1).find((l) => l.startsWith('n/'))?.slice(1);
        return { pid, path: mapped ?? (await run('ps', ['-o', 'comm=', '-p', String(pid)])).stdout.trim() };
      } catch { return null; }
    },
    // This user's own processes only (fix round 5): another user's Ollama app is not ours to signal.
    appPids: async () => { try { return pids((await run('pgrep', ['-x', '-u', String(process.getuid?.() ?? ''), 'Ollama'])).stdout); } catch { return []; } },
    appInstalled: async () => {   // `/bin/test -d`: the bundle is there (no file-system import for one yes/no)
      for (const p of ['/Applications/Ollama.app', join(homeDir(), 'Applications', 'Ollama.app')]) { try { await run('/bin/test', ['-d', p]); return true; } catch { /* not here */ } }
      return false;
    },
    terminate: (pid) => { try { kill(pid, 'SIGTERM'); } catch { /* already gone */ } },
    alive: (pid) => { try { return kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
    // Exactly how Ollama's CLI starts the Mac app (`cmd/start_darwin.go`): hidden, fast start-up. Run under the
    // platform's child-process bound (`child-idle-bound.ts`) at the app-start patience below (fix round 5, NB4-2).
    launchApp: async () => {
      await attachIdleBound(spawnChild('/usr/bin/open', ['-j', '-a', 'Ollama', '--args', '--fast-startup']), { idleMs: WAIT_MS, ceilingMs: WAIT_MS });
    },
    answers: (baseUrl) => checkOllamaHealth(baseUrl),   // the Dojo's one Ollama health check (`services/ollama.ts`)
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    brewServicePid: async () => {
      try {
        const pid = /"PID"\s*=\s*(\d+)/.exec((await run('launchctl', ['list', BREW_SERVICE])).stdout)?.[1];
        return pid ? Number(pid) : null;
      } catch { return null; }
    },
    hasBrew: async () => (await brewPath()) !== null,
    brew: async (args) => {
      const brew = await brewPath();
      if (!brew) throw new Error('Homebrew is not installed');
      await attachIdleBound(spawnChild(brew, args), { idleMs: BREW_IDLE_MS, ceilingMs: BREW_CEILING_MS });
    },
    restartBrewService: async () => {
      const brew = await brewPath();
      if (!brew) throw new Error('Homebrew is not installed');
      await run(brew, ['services', 'restart', 'ollama']);
    },
    startServe: (env) => { serve(env); },
  };
}

const execRun = promisify(execFile);
const REAL = makeRealDeps(
  (cmd, args) => execRun(cmd, args, { env: { ...process.env, PATH: EXTENDED_PATH } }), (pid, sig) => process.kill(pid, sig),
  (cmd, args) => spawn(cmd, args, { env: { ...process.env, PATH: EXTENDED_PATH } }),
  (env) => { spawn('ollama', ['serve'], { env: { ...process.env, PATH: EXTENDED_PATH, ...env }, stdio: 'ignore' }).on('error', () => undefined); },
);

let override: OllamaHost | null = null;
/** A test's fake host for the code that is not handed one (null puts the real one back). */
export function overrideOllamaHost(host: OllamaHost | null): void { override = host; }
/** The host the platform uses, or null in a test run with no fake: the real launchctl, brew and app are never touched by a test. */
export function getOllamaHost(): OllamaHost | null { return override ?? (isTestRun() ? null : REAL); }
