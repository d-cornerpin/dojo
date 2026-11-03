// ════════════════════════════════════════════════════════════════════════════
// WHAT KIND OF OLLAMA THIS BOX RUNS, AND HOW THE DOJO RESTARTS EACH KIND (Fix W).
//
// THE KIND is read from the REAL program of the process listening on Ollama's port (`OllamaHost.listener`
// resolves links), never from the path it was started by:
//   · app          the program is inside Ollama.app — also a `serve` started through the CLI link into the app;
//   · brew-service Homebrew's launchd job for Ollama is the listener (`brew services`);
//   · own-serve    a `serve` the Dojo started itself (setup's "start"): the program it runs was recorded then;
//   · other        anything else (a plain binary, a hand-written launchd job): the Dojo does not touch it.
// THE RESTART of each puts Ollama's loaded-model limit (`OLLAMA_MAX_LOADED_MODELS`) in the environment the new
// process starts with — launchd's for the app and Homebrew's job, the child's own for a Dojo `serve` — so no one
// is ever asked to set it by hand. Callers hold the local Ollama quiet around a restart (`ollama-quiet.ts`).
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getOllamaLock, getOllamaMaxConcurrent } from './ollama-lock.js';
import { type OllamaHost, TICK_MS, WAIT_MS } from './ollama-host.js';

export const LIMIT_VAR = 'OLLAMA_MAX_LOADED_MODELS';
/** The Ollama app's bundle in a path, as Ollama's own CLI recognises it (`cmd/start_darwin.go`). */
export const APP_PATH = /\/Ollama\s?\d*\.app\//;
/** A Homebrew formula's program: the Cellar path `brew upgrade ollama` replaces. */
export const BREW_FORMULA_PATH = /\/Cellar\/ollama\//;
const OWN_SERVE_KEY = 'ollama_own_serve_exe';
/** `<pid>:<limit>` of the Dojo's own `serve` that was started with the loaded-model limit in its environment. */
export const OWN_SERVE_LIMIT_KEY = 'ollama_own_serve_limit';
export const readConfig = (key: string): string | null =>
  (getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

export type OllamaKind = 'app' | 'brew-service' | 'own-serve' | 'other';

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

/** The value a process the Dojo starts gets: the Dojo's own environment's, when that is already enough. */
export const limitFor = (want: number): string => raisedLoadedLimit(process.env[LIMIT_VAR], want) ?? (process.env[LIMIT_VAR] as string).trim();

export async function classifyOllama(host: OllamaHost, port: number): Promise<{ kind: OllamaKind; pid: number; path: string } | null> {
  const l = await host.listener(port);
  if (!l) return null;
  const kind: OllamaKind = (await host.brewServicePid()) === l.pid ? 'brew-service'
    : APP_PATH.test(l.path) ? 'app'
    : readConfig(OWN_SERVE_KEY) === l.path ? 'own-serve'
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

/** Homebrew's job: `brew services restart ollama` (launchd's environment, set by the caller, is inherited). */
export async function restartBrewService(host: OllamaHost, baseUrl: string): Promise<void> {
  await host.restartBrewService();
  if (!await waitUntil(host, () => host.answers(baseUrl))) throw new Error('the Homebrew Ollama service did not answer after its restart');
}

/** Start `ollama serve` as a child of the Dojo with the limit in its environment and remember the program it
 *  runs (setup's "start", and the restart of one the Dojo started). Resolves when Ollama answers. */
export async function startOwnServe(host: OllamaHost, baseUrl: string, residentCount: number): Promise<boolean> {
  const before = await host.listener(portOf(baseUrl));   // a server already listening is not the one just started
  const limit = limitFor(desiredLoaded(residentCount));
  host.startServe({ [LIMIT_VAR]: limit });
  const answered = await waitUntil(host, () => host.answers(baseUrl));
  const pid = await rememberOwnServe(host, baseUrl, before?.pid);
  if (pid !== null) setConfig(OWN_SERVE_LIMIT_KEY, `${pid}:${limit}`);   // this server has the limit: a Dojo start does not restart it for it
  return answered;
}

/** Remember the program the listener runs as a `serve` the Dojo started (not the app's, not Homebrew's job). */
export async function rememberOwnServe(host: OllamaHost, baseUrl: string, olderPid?: number): Promise<number | null> {
  const l = await host.listener(portOf(baseUrl));
  if (!l || l.pid === olderPid || APP_PATH.test(l.path) || (await host.brewServicePid()) === l.pid) return null;
  setConfig(OWN_SERVE_KEY, l.path);
  return l.pid;
}

/** Stop the Dojo's own `serve` and start it again — from the program on disk now, which an upgrade replaced. */
export async function restartOwnServe(host: OllamaHost, baseUrl: string, pid: number, residentCount: number): Promise<void> {
  host.terminate(pid);
  if (!await waitUntil(host, () => !host.alive(pid))) throw new Error('the Ollama server the Dojo started did not stop');
  setConfig(OWN_SERVE_KEY, null);   // the program it will run is read again once it listens
  if (!await startOwnServe(host, baseUrl, residentCount)) throw new Error('the Ollama server did not answer after its restart');
}

/** The loaded-model limit in launchd's environment (the app and Homebrew's job read it when they start). Returns the
 *  value set, or null when launchd already holds one at least as high (an owner's higher value is never lowered). */
export async function setLaunchdLimit(host: OllamaHost, residentCount: number): Promise<string | null> {
  const raised = raisedLoadedLimit(await host.getenv(LIMIT_VAR), desiredLoaded(residentCount));
  if (raised !== null) await host.setenv(LIMIT_VAR, raised);
  return raised;
}
