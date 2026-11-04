// ════════════════════════════════════════════════════════════════════════════
// WHAT KIND OF OLLAMA THIS BOX RUNS, AND HOW THE DOJO STOPS AND STARTS EACH KIND (Fix W; field failure 2).
//
// THE KIND is read from the REAL program of the process listening on Ollama's port (`OllamaHost.listener`
// resolves links), never from the path it was started by. It only chooses HOW Ollama is restarted, never WHETHER
// (owner ruling OR-UPKEEP-AUTOMATIC: the Dojo takes over whatever Ollama is running, whoever started it):
//   · app          the program is inside Ollama.app — also a `serve` started through the CLI link into the app;
//   · brew-service Homebrew's launchd job for Ollama is the listener (`brew services`);
//   · formula      a Homebrew formula's program that nothing supervises (the 3.4.1 Dojo's `serve`, a shell's, an agent's);
//   · other        another Ollama program (a plain binary, a hand-written launchd job);
//   · not-ollama   the listener's real program is NOT Ollama (Docker Desktop forwarding a container, an `ssh -L` tunnel): the
//                  Dojo cannot know what it is, so it is never stopped (review H1: the identity check outlives M4/M5).
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

export type OllamaKind = 'app' | 'brew-service' | 'formula' | 'other' | 'not-ollama';
/** An Ollama program: inside Ollama.app, or a file named `ollama` (the formula's, the CLI tarball's, a source build's). */
export const isOllamaProgram = (path: string): boolean => APP_PATH.test(path) || /(^|\/)ollama$/.test(path);

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
  const kind: OllamaKind = !isOllamaProgram(l.path) ? 'not-ollama'
    : (await host.brewServicePid()) === l.pid ? 'brew-service'
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

/** How a start ended. Review M2: Ollama's own CLI patience (`WAIT_MS`) is the POLL, not the verdict. A process still alive
 *  when it ends is a slow start (a first launch being scanned, a busy update boot), never a failure: the caller holds and
 *  tells nothing, and the next health answer judges it. Only a start whose process is gone is `dead`. */
export type Start = 'answering' | 'starting' | 'dead';
export async function waitForStart(host: OllamaHost, baseUrl: string, alive: () => boolean | Promise<boolean>): Promise<Start> {
  if (await waitUntil(host, () => host.answers(baseUrl))) return 'answering';
  return (await alive()) ? 'starting' : 'dead';
}
const appAlive = (host: OllamaHost) => async (): Promise<boolean> => (await host.appPids()).length > 0;

/** The Ollama app: a TERM to its processes (no AppleScript, so no macOS Automation prompt), then opened the way
 *  Ollama's own CLI opens it. Throws when it did not quit or is gone after its relaunch (fix round 5, NB4-1). */
export async function restartApp(host: OllamaHost, baseUrl: string, serverPid?: number): Promise<Start> {
  const pids = [...new Set([...await host.appPids(), ...(serverPid ? [serverPid] : [])])];
  for (const pid of pids) host.terminate(pid);
  const quit = await waitUntil(host, () => pids.every((pid) => !host.alive(pid)));
  await host.launchApp();   // also when it did not quit: the app must be running afterwards either way
  const started = await waitForStart(host, baseUrl, appAlive(host));
  if (!quit) throw new Error('the Ollama app did not quit');
  if (started === 'dead') throw new Error('the Ollama app is not running after its relaunch');
  return started;
}

/** Quit the Ollama app (and the server it runs) with a TERM and confirm it is gone; throws when it is not. */
export async function stopApp(host: OllamaHost, serverPid?: number): Promise<void> {
  const pids = [...new Set([...await host.appPids(), ...(serverPid ? [serverPid] : [])])];
  for (const pid of pids) host.terminate(pid);
  if (!await waitUntil(host, () => pids.every((pid) => !host.alive(pid)))) throw new Error('the Ollama app did not quit');
}

/** Open the Ollama app; how its start ended. */
export async function startApp(host: OllamaHost, baseUrl: string): Promise<Start> {
  await host.launchApp();
  return waitForStart(host, baseUrl, appAlive(host));
}

/** Homebrew's job: `brew services restart ollama` (launchd's environment, set by the caller, is inherited); how its start ended. */
export async function restartBrewService(host: OllamaHost, baseUrl: string): Promise<Start> {
  await host.restartBrewService();
  return waitForStart(host, baseUrl, async () => (await host.brewServicePid()) !== null);
}

/** Review H3: a takeover that cannot end in a kind that lasts (an owner's job that starts Ollama again, another user's Ollama, the
 *  fallback serve below) is SETTLED for that listener, so no start and no health retry stops it again for the same situation. */
const SETTLED = 'ollama_takeover_settled';
export const settleTakeover = (l: { pid: number; path: string }): void => setConfig(SETTLED, JSON.stringify({ pid: l.pid, path: l.path }));
export function takeoverSettled(l: { pid: number; path: string }): boolean {
  try { const v = JSON.parse(readConfig(SETTLED) ?? 'null') as { pid: number; path: string } | null; return !!v && v.pid === l.pid && v.path === l.path; } catch { return false; }
}

/** Review H2: Homebrew's service, or, when it cannot start (a stale plist's "Bootstrap failed", no formula), the program on disk
 *  run as a detached `ollama serve` with the limit in its own environment, recorded as settled. Ollama is never left down while
 *  a program that runs is on disk; the service is tried again at the next start that finds nothing serving. */
export async function startLasting(host: OllamaHost, baseUrl: string, residentCount: number, viaService = true): Promise<Start> {
  if (viaService) {
    const service = await restartBrewService(host, baseUrl).catch((): Start => 'dead');
    if (service !== 'dead') return service;
  }
  if (!await host.cliRuns()) return 'dead';
  const launchd = await host.getenv(LIMIT_VAR);
  const pid = host.startServe({ [LIMIT_VAR]: raisedLoadedLimit(launchd, desiredLoaded(residentCount)) ?? (launchd as string).trim() });
  if (pid === null) return 'dead';
  const started = await waitForStart(host, baseUrl, () => host.alive(pid));
  const l = await host.listener(portOf(baseUrl));
  if (started !== 'dead') settleTakeover(l ?? { pid, path: 'ollama' });
  return started;
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
