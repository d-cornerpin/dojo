// ════════════════════════════════════════════════════════════════════════════
// v3.5 — THE DOJO RAISES OLLAMA'S LOADED-MODEL LIMIT ON THE MAC (owner decision 2026-10-24,
// "Dojo raises the limit").
//
// Ollama keeps at most OLLAMA_MAX_LOADED_MODELS models loaded — by default 3 per GPU, and Apple Silicon is
// one GPU (docs.ollama.com/faq; `server/sched.go`: `defaultModelsPerGPU = 3`) — and at that limit it unloads
// an idle model to load the next. The embedder and the Dojo's resident pair are three by themselves, so an
// agent's local model and one of them would unload each other turn after turn.
//
// THE VALUE: 1 (the embedder) + the Dojo's two standard models + the Ollama lock's agent slots
// (`ollama_max_concurrent_models`, the agent models the lock lets load at once). It only ever RAISES: an
// owner's own higher value is left exactly as it is (fix round 4, NB-3). The setup "start" fallback that runs
// `ollama serve` itself follows the same rule (`gateway/routes/setup-deps.ts`).
//
// WHEN: at setup and at EVERY Dojo start — `launchctl setenv` does not survive a reboot.
// WHERE IT IS TRUE (fix round 4, NB-2):
//   · the Ollama app serves this box's Ollama (or is installed and not running) → `launchctl setenv` (the app
//     reads its environment from launchd: docs, "If Ollama is run as a macOS application, environment
//     variables should be set using launchctl" and the app restarted); a running app is restarted ONCE;
//   · another `ollama serve` (Homebrew's, or one started by hand) → nothing is changed or restarted; the card
//     names the one setting the owner can add himself;
//   · no local Ollama → nothing at all.
// THE RESTART (NB-1, NB-5): only when no call on the local Ollama and no pull is in flight (`ollama-quiet.ts
// holdWhenQuiet`); calls that arrive meanwhile wait for it. No AppleScript (no macOS Automation prompt): a
// TERM to the app's processes, then the app is opened the way Ollama's own CLI opens it. A restart that did not
// happen stays owed and is tried again at the next start.
// ════════════════════════════════════════════════════════════════════════════

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { isTestRun, homeDir } from '../home.js';
import { STANDARD_TAGS, localOllamaProvider } from './local-standard.js';
import { getOllamaLock, getOllamaMaxConcurrent } from './ollama-lock.js';
import { ownerCardFrame } from './owner-card-frames.js';
import { holdWhenQuiet } from './ollama-quiet.js';
import { checkOllamaHealth } from './ollama.js';
import {
  tellOwnerOnce, ownerConditionCleared, OLLAMA_LIMIT_SET_WORDS, OLLAMA_LIMIT_FAILED_WORDS, ollamaLimitManualWords,
} from '../healer/owner-notices.js';

export { OLLAMA_LIMIT_SET_WORDS, OLLAMA_LIMIT_FAILED_WORDS, ollamaLimitManualWords };
const logger = createLogger('ollama-model-limit');
const VAR = 'OLLAMA_MAX_LOADED_MODELS';

/** How Ollama's own CLI waits after it opens the Mac app (`cmd/start.go waitForServer`: a heartbeat every
 *  500 ms, given up after 5 s). The Dojo waits the same way for the app to quit and to answer again. */
const TICK_MS = 500;
const WAIT_MS = 5_000;
/** The Ollama app's bundle in a path, as Ollama's own CLI recognises it (`cmd/start_darwin.go`). */
const APP_PATH = /\/Ollama\s?\d*\.app\//;

export interface OllamaLimitDeps {
  /** The launchd value, or null when unset (an unset variable reads as unset however launchctl reports it). */
  getenv(name: string): Promise<string | null>;
  setenv(name: string, value: string): Promise<void>;
  /** The process listening on the local Ollama's port, or null. */
  listener(port: number): Promise<{ pid: number; path: string } | null>;
  /** The Ollama app's own processes (`pgrep -x Ollama`, case-sensitive: Homebrew's server is `ollama`). */
  appPids(): Promise<number[]>;
  appInstalled(): Promise<boolean>;
  terminate(pid: number): void;
  alive(pid: number): boolean;
  launchApp(): Promise<void>;
  answers(baseUrl: string): Promise<boolean>;
  sleep(ms: number): Promise<void>;
}

type Run = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
type Kill = (pid: number, signal: NodeJS.Signals | 0) => boolean;

/** The real commands, built over `run`/`kill` so a test can read their argv without running any. */
export function makeRealDeps(run: Run, kill: Kill): OllamaLimitDeps {
  const pids = (out: string): number[] => out.split('\n').map((l) => parseInt(l, 10)).filter((n) => Number.isInteger(n) && n > 0);
  return {
    getenv: async (name) => { try { return (await run('launchctl', ['getenv', name])).stdout.trim() || null; } catch { return null; } },
    setenv: async (name, value) => { await run('launchctl', ['setenv', name, value]); },
    listener: async (port) => {
      try {
        const [pid] = pids((await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'])).stdout);
        if (!pid) return null;
        return { pid, path: (await run('ps', ['-o', 'comm=', '-p', String(pid)])).stdout.trim() };
      } catch { return null; }
    },
    appPids: async () => { try { return pids((await run('pgrep', ['-x', 'Ollama'])).stdout); } catch { return []; } },
    appInstalled: async () => {   // `/bin/test -d`: the bundle is there (no file-system import for one yes/no)
      for (const p of ['/Applications/Ollama.app', join(homeDir(), 'Applications', 'Ollama.app')]) { try { await run('/bin/test', ['-d', p]); return true; } catch { /* not here */ } }
      return false;
    },
    terminate: (pid) => { try { kill(pid, 'SIGTERM'); } catch { /* already gone */ } },
    alive: (pid) => { try { return kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } },
    // Exactly how Ollama's CLI starts the Mac app (`cmd/start_darwin.go`): hidden, fast start-up.
    launchApp: async () => { await run('/usr/bin/open', ['-j', '-a', 'Ollama', '--args', '--fast-startup']); },
    answers: (baseUrl) => checkOllamaHealth(baseUrl),   // the Dojo's one Ollama health check (`services/ollama.ts`)
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}
const execRun = promisify(execFile);
const REAL = makeRealDeps((cmd, args) => execRun(cmd, args), (pid, sig) => process.kill(pid, sig));

const toldValue = (): string | null =>
  (getDb().prepare("SELECT value FROM config WHERE key = 'ollama_limit_told'").get() as { value: string } | undefined)?.value ?? null;
const restartOwed = (): boolean => !!getDb().prepare("SELECT 1 FROM config WHERE key = 'ollama_limit_restart_owed'").get();
const setConfig = (key: string, value: string | null): void => {
  if (value === null) { getDb().prepare('DELETE FROM config WHERE key = ?').run(key); return; }
  getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value);
};
const RESTART_OWED = 'ollama_limit_restart_owed';
/** The local Ollama's port (Ollama's default, 11434, when its URL names none). */
const portOf = (baseUrl: string): number => Number(new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`).port || 11434);

/** The limit the Dojo needs: the embedder + the pair + the lock's agent slots (see the header). */
export function desiredOllamaMaxLoaded(): number {
  getOllamaLock().reloadConfig();
  return 1 + STANDARD_TAGS.length + getOllamaMaxConcurrent();
}

/** NB-3: the value to set, or null when `current` is already at least `want` (an owner's higher value stands). */
export function raisedLoadedLimit(current: string | null | undefined, want: number): string | null {
  const n = Number((current ?? '').trim());
  return (current ?? '').trim() !== '' && Number.isFinite(n) && n >= want ? null : String(want);
}

/** Told once per value (fix round 3): a reboot loses the variable and every start re-applies it silently. */
function tellOncePerValue(key: string, told: string, words: string): void {
  if (toldValue() === told) return;
  ownerConditionCleared('ollama-limit-set');
  ownerConditionCleared('ollama-limit-manual:', true);
  if (tellOwnerOnce(key)) ownerCardFrame(words, 'warning');
  setConfig('ollama_limit_told', told);
}

let restarting: Promise<void> | null = null;
/** Resolves when no restart is pending (tests; never awaited by a boot or a request). */
export function ollamaRestartSettled(): Promise<void> { return restarting ?? Promise.resolve(); }

export async function ensureOllamaModelLimit(
  deps: OllamaLimitDeps = REAL, platform: NodeJS.Platform = process.platform,
): Promise<'already' | 'set' | 'manual' | 'failed' | 'skipped'> {
  if (platform !== 'darwin') return 'skipped';
  if (deps === REAL && isTestRun()) return 'skipped';   // the real launchctl and the real app are never touched by a test
  const local = localOllamaProvider();
  if (!local) return 'skipped';                        // NB-2: no local Ollama — nothing, no card
  const want = desiredOllamaMaxLoaded();
  try {
    const listening = await deps.listener(portOf(local.baseUrl));
    if (listening && !APP_PATH.test(listening.path)) {
      // Another `ollama serve` answers (Homebrew's, or one started by hand): launchd's value does not reach it.
      tellOncePerValue(`ollama-limit-manual:${want}`, `manual:${want}`, ollamaLimitManualWords(want));
      return 'manual';
    }
    const appRunning = !!listening || (await deps.appPids()).length > 0;
    if (!appRunning && !(await deps.appInstalled())) return 'skipped';   // nothing serves and no app: tried again next start
    const raised = raisedLoadedLimit(await deps.getenv(VAR), want);
    if (raised === null && !(appRunning && restartOwed())) {
      if (!appRunning) setConfig(RESTART_OWED, null);   // a stopped app reads the value when it starts
      ownerConditionCleared('ollama-limit-failed');
      return 'already';
    }
    if (raised !== null) {
      await deps.setenv(VAR, raised);
      tellOncePerValue('ollama-limit-set', raised, OLLAMA_LIMIT_SET_WORDS);
      logger.info('Raised Ollama\'s loaded-model limit', { value: raised });
    }
    if (appRunning) {
      setConfig(RESTART_OWED, '1');   // owed until the restart has really happened (NB-5)
      restarting ??= restartWhenQuiet(deps, local).finally(() => { restarting = null; });
    } else {
      ownerConditionCleared('ollama-limit-failed');
    }
    return 'set';
  } catch (err) {
    failed(err);
    return 'failed';
  }
}

function failed(err: unknown): void {
  logger.warn('Could not raise Ollama\'s loaded-model limit (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
  if (tellOwnerOnce('ollama-limit-failed')) ownerCardFrame(OLLAMA_LIMIT_FAILED_WORDS, 'warning');
}

async function waitUntil(deps: OllamaLimitDeps, done: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let waited = 0; ; waited += TICK_MS) {
    if (await done()) return true;
    if (waited >= WAIT_MS) return false;
    await deps.sleep(TICK_MS);
  }
}

/** NB-1: deferred until nothing is in flight on the local Ollama; new calls wait while it runs. */
async function restartWhenQuiet(deps: OllamaLimitDeps, local: { id: string; baseUrl: string }): Promise<void> {
  const endHold = await holdWhenQuiet(local.id);
  try {
    const listening = await deps.listener(portOf(local.baseUrl));
    const pids = [...new Set([...await deps.appPids(), ...(listening && APP_PATH.test(listening.path) ? [listening.pid] : [])])];
    for (const pid of pids) deps.terminate(pid);
    const quit = await waitUntil(deps, () => pids.every((pid) => !deps.alive(pid)));
    await deps.launchApp();   // also when it did not quit: the app must be running afterwards either way
    const answered = await waitUntil(deps, () => deps.answers(local.baseUrl));
    if (!quit) throw new Error('the Ollama app did not quit');
    setConfig(RESTART_OWED, null);
    ownerConditionCleared('ollama-limit-failed');
    logger.info('Restarted the Ollama app to apply its loaded-model limit', { answered });
  } catch (err) {
    failed(err);   // the restart stays owed: the next start tries it again
  } finally {
    endHold();
  }
}
