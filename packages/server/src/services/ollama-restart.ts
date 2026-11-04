// ════════════════════════════════════════════════════════════════════════════
// WHAT KIND OF OLLAMA THIS BOX RUNS, AND HOW THE DOJO STOPS AND STARTS EACH KIND (Fix W; field failure 2).
//
// THE KIND is read from the REAL program of the process listening on Ollama's port (`OllamaHost.listener`
// resolves links), never from the path it was started by. It only chooses HOW Ollama is restarted, never WHETHER
// (owner ruling OR-UPKEEP-AUTOMATIC: the Dojo takes over whatever Ollama is running, whoever started it):
//   · app          the program is inside Ollama.app — also a `serve` started through the CLI link into the app;
//   · brew-service Homebrew's launchd job for Ollama is the listener (`brew services`);
//   · formula      a Homebrew formula's program that nothing supervises (the 3.4.1 Dojo's `serve`, a shell's, an agent's);
//   · other        any other program (a plain binary, a hand-written launchd job).
// The app and Homebrew's service are the kinds that LAST (launchd or the app keeps them up across Dojo restarts), so the
// Dojo restarts into one of them (`ollama-upgrade.ts`). THE RESTART puts Ollama's loaded-model limit
// (`OLLAMA_MAX_LOADED_MODELS`) in launchd's environment first, which both start with, so no one is ever asked to set it
// by hand. Callers hold the local Ollama quiet around a restart (`ollama-quiet.ts`).
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getOllamaLock, getOllamaMaxConcurrent } from './ollama-lock.js';
import { type OllamaHost, TICK_MS, WAIT_MS } from './ollama-host.js';

export const LIMIT_VAR = 'OLLAMA_MAX_LOADED_MODELS';
/** The Ollama app's bundle in a path, as Ollama's own CLI recognises it (`cmd/start_darwin.go`). */
export const APP_PATH = /\/Ollama\s?\d*\.app\//;
/** A Homebrew formula's program: the Cellar path `brew upgrade ollama` replaces. */
export const BREW_FORMULA_PATH = /\/Cellar\/ollama\//;
export const readConfig = (key: string): string | null =>
  (getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

export type OllamaKind = 'app' | 'brew-service' | 'formula' | 'other';

export const setConfig = (key: string, value: string | null): void => {
  if (value === null) { getDb().prepare('DELETE FROM config WHERE key = ?').run(key); return; }
  getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, value);
};

/** The local Ollama's port (Ollama's default, 11434, when its URL names none). */
export const portOf = (baseUrl: string): number => Number(new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`).port || 11434);

/** The limit the Dojo needs: the embedder + the Dojo's resident models + the Ollama lock's agent slots. */
export function desiredLoaded(residentCount: number): number {
  getOllamaLock().reloadConfig();
  return 1 + residentCount + getOllamaMaxConcurrent();
}

/** NB-3: the value to set, or null when `current` is already at least `want` (an owner's higher value stands). */
export function raisedLoadedLimit(current: string | null | undefined, want: number): string | null {
  const n = Number((current ?? '').trim());
  return (current ?? '').trim() !== '' && Number.isFinite(n) && n >= want ? null : String(want);
}

export async function classifyOllama(host: OllamaHost, port: number): Promise<{ kind: OllamaKind; pid: number; path: string } | null> {
  const l = await host.listener(port);
  if (!l) return null;
  const kind: OllamaKind = (await host.brewServicePid()) === l.pid ? 'brew-service'
    : APP_PATH.test(l.path) ? 'app'
    : BREW_FORMULA_PATH.test(l.path) ? 'formula'
    : 'other';
  return { kind, ...l };
}

export async function waitUntil(host: OllamaHost, done: () => boolean | Promise<boolean>): Promise<boolean> {
  for (let waited = 0; ; waited += TICK_MS) {
    if (await done()) return true;
    if (waited >= WAIT_MS) return false;
    await host.sleep(TICK_MS);
  }
}

/** The Ollama app: a TERM to its processes (no AppleScript, so no macOS Automation prompt), then opened the way
 *  Ollama's own CLI opens it. Resolves when Ollama ANSWERS again (fix round 5, NB4-1); throws when it did not. */
export async function restartApp(host: OllamaHost, baseUrl: string, serverPid?: number): Promise<void> {
  const pids = [...new Set([...await host.appPids(), ...(serverPid ? [serverPid] : [])])];
  for (const pid of pids) host.terminate(pid);
  const quit = await waitUntil(host, () => pids.every((pid) => !host.alive(pid)));
  await host.launchApp();   // also when it did not quit: the app must be running afterwards either way
  const answered = await waitUntil(host, () => host.answers(baseUrl));
  if (!quit) throw new Error('the Ollama app did not quit');
  if (!answered) throw new Error('the Ollama app did not answer after its relaunch');
}

/** Quit the Ollama app (and the server it runs) with a TERM and confirm it is gone; throws when it is not. */
export async function stopApp(host: OllamaHost, serverPid?: number): Promise<void> {
  const pids = [...new Set([...await host.appPids(), ...(serverPid ? [serverPid] : [])])];
  for (const pid of pids) host.terminate(pid);
  if (!await waitUntil(host, () => pids.every((pid) => !host.alive(pid)))) throw new Error('the Ollama app did not quit');
}

/** Open the Ollama app and wait for Ollama to ANSWER; throws when it does not. */
export async function startApp(host: OllamaHost, baseUrl: string): Promise<void> {
  await host.launchApp();
  if (!await waitUntil(host, () => host.answers(baseUrl))) throw new Error('the Ollama app did not answer after its relaunch');
}

/** Homebrew's job: `brew services restart ollama` (launchd's environment, set by the caller, is inherited). */
export async function restartBrewService(host: OllamaHost, baseUrl: string): Promise<void> {
  await host.restartBrewService();
  if (!await waitUntil(host, () => host.answers(baseUrl))) throw new Error('the Homebrew Ollama service did not answer after its restart');
}

/** One piece of Ollama upkeep at a time (a limit restart, an upgrade, a serve's restart): they queue here, so two of them never
 *  restart Ollama over each other and a check made after one is made after Ollama is back (field failure: the update boot's
 *  limit restart had the app down while the version gate looked for a listener). No timer: each starts when the one before ends. */
let upkeep: Promise<unknown> = Promise.resolve();
export function inUpkeep<T>(work: () => Promise<T>): Promise<T> {
  const run = upkeep.then(work, work);
  upkeep = run.catch(() => undefined);
  return run;
}

/** A serve nothing supervises: a TERM, then confirmed gone from the port. Resolves what holds the port afterwards: null when
 *  it is free, else a process a supervisor started again in its place. Throws when it does not stop: the signal is refused
 *  (another user's process, or the system's) and `alive` reads that as alive. */
export async function stopServe(host: OllamaHost, port: number, pid: number): Promise<{ pid: number; path: string } | null> {
  host.terminate(pid);
  if (!await waitUntil(host, async () => !host.alive(pid) && (await host.listener(port))?.pid !== pid)) {
    throw new Error('the Ollama server did not stop (it runs as another user or as the system)');
  }
  return host.listener(port);
}

/** The loaded-model limit in launchd's environment (the app and Homebrew's job read it when they start). Returns the
 *  value set, or null when launchd already holds one at least as high (an owner's higher value is never lowered). */
export async function setLaunchdLimit(host: OllamaHost, residentCount: number): Promise<string | null> {
  const raised = raisedLoadedLimit(await host.getenv(LIMIT_VAR), desiredLoaded(residentCount));
  if (raised !== null) await host.setenv(LIMIT_VAR, raised);
  return raised;
}
