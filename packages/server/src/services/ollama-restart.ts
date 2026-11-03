// ════════════════════════════════════════════════════════════════════════════
// WHAT KIND OF OLLAMA THIS BOX RUNS, AND HOW THE DOJO RESTARTS EACH KIND (Fix W).
//
// THE KIND is read from the REAL program of the process listening on Ollama's port (`OllamaHost.listener`
// resolves links), never from the path it was started by:
//   · app          the program is inside Ollama.app — also a `serve` started through the CLI link into the app;
//   · brew-service Homebrew's launchd job for Ollama is the listener (`brew services`);
//   · own-serve    a `serve` the Dojo started itself (setup's "start"): the PID of the child it spawned and the program it
//                  runs are recorded then, so a serve the owner started by hand is never mistaken for it;
//   · formula      a Homebrew formula's program the Dojo did not start: `brew upgrade` is safe, the restart is not the Dojo's;
//   · other        anything else (a plain binary, a hand-written launchd job): the Dojo does not touch it.
// THE RESTART of each puts Ollama's loaded-model limit (`OLLAMA_MAX_LOADED_MODELS`) in the environment the new
// process starts with — launchd's for the app and Homebrew's job, the child's own for a Dojo `serve` — so no one
// is ever asked to set it by hand. Callers hold the local Ollama quiet around a restart (`ollama-quiet.ts`).
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { getOllamaLock, getOllamaMaxConcurrent } from './ollama-lock.js';
import { type OllamaHost, TICK_MS, WAIT_MS } from './ollama-host.js';
import { ownerCardFrame } from './owner-card-frames.js';
import { tellOwnerOnce, ownerConditionCleared, OLLAMA_DOWN_WORDS } from '../healer/owner-notices.js';

export const LIMIT_VAR = 'OLLAMA_MAX_LOADED_MODELS';
/** The Ollama app's bundle in a path, as Ollama's own CLI recognises it (`cmd/start_darwin.go`). */
export const APP_PATH = /\/Ollama\s?\d*\.app\//;
/** A Homebrew formula's program: the Cellar path `brew upgrade ollama` replaces. */
export const BREW_FORMULA_PATH = /\/Cellar\/ollama\//;
export const readConfig = (key: string): string | null =>
  (getDb().prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;

export type OllamaKind = 'app' | 'brew-service' | 'own-serve' | 'formula' | 'other';

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
    : isOwnServe(l) ? 'own-serve'
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

/** Homebrew's job: `brew services restart ollama` (launchd's environment, set by the caller, is inherited). */
export async function restartBrewService(host: OllamaHost, baseUrl: string): Promise<void> {
  await host.restartBrewService();
  if (!await waitUntil(host, () => host.answers(baseUrl))) throw new Error('the Homebrew Ollama service did not answer after its restart');
}

/** The Dojo's own `serve`, as recorded when it spawned the child: its pid, the program it runs (known once it listens) and
 *  the loaded-model limit in its environment. A pid alone is not enough (a reboot reuses them): the program must match too. */
interface OwnServe { pid: number; exe: string | null; limit: string }
export function readOwnServe(): OwnServe | null {
  try { return JSON.parse(readConfig('ollama_own_serve') ?? 'null') as OwnServe | null; } catch { return null; }
}
const isOwnServe = (l: { pid: number; path: string }): boolean => { const o = readOwnServe(); return !!o && o.pid === l.pid && (o.exe === null || o.exe === l.path); };
/** Does the recorded serve already carry `limit`? (Then a Dojo start does not restart it for the limit.) */
export const ownServeHasLimit = (pid: number, limit: string): boolean => { const o = readOwnServe(); return !!o && o.pid === pid && o.limit === limit; };

/** One piece of Ollama upkeep at a time (a limit restart, an upgrade, a serve's restart): they queue here, so two of them never
 *  restart Ollama over each other and a check made after one is made after Ollama is back (field failure: the update boot's
 *  limit restart had the app down while the version gate looked for a listener). No timer: each starts when the one before ends. */
let upkeep: Promise<unknown> = Promise.resolve();
export function inUpkeep<T>(work: () => Promise<T>): Promise<T> {
  const run = upkeep.then(work, work);
  upkeep = run.catch(() => undefined);
  return run;
}

/** Start `ollama serve` as a child of the Dojo with the limit in its environment, and record it AT ONCE by the pid it was given
 *  (a slow start is still recorded). Resolves true when Ollama answers. */
export async function startOwnServe(host: OllamaHost, baseUrl: string, residentCount: number): Promise<boolean> {
  const before = await host.listener(portOf(baseUrl));   // a server already listening is not the one just started
  const limit = limitFor(desiredLoaded(residentCount));
  const pid = host.startServe({ [LIMIT_VAR]: limit });
  if (pid === null) return false;
  setConfig('ollama_own_serve', JSON.stringify({ pid, exe: null, limit } satisfies OwnServe));
  const answered = await waitUntil(host, () => host.answers(baseUrl));
  const l = await host.listener(portOf(baseUrl));
  if (l && l.pid === pid && l.pid !== before?.pid) setConfig('ollama_own_serve', JSON.stringify({ pid, exe: l.path, limit } satisfies OwnServe));
  else if (l && l.pid !== pid) setConfig('ollama_own_serve', null);   // another server holds the port: the child just started is not what serves
  return answered;
}

/** Stop the Dojo's own `serve` and start it again — from the program on disk now, which an upgrade replaced. The old one is not
 *  stopped until the new program is known to run; if the new one still does not come up, the owner is told, in the Dojo's words. */
export async function restartOwnServe(host: OllamaHost, baseUrl: string, pid: number, residentCount: number): Promise<void> {
  if (!await host.cliRuns()) throw new Error('the ollama program does not run, so the server the Dojo started was left as it is');
  host.terminate(pid);
  if (!await waitUntil(host, () => !host.alive(pid))) throw new Error('the Ollama server the Dojo started did not stop');
  if (await startOwnServeOrTell(host, baseUrl, residentCount)) return;
  throw new Error('the Ollama server did not answer after its restart');
}

/** `startOwnServe`, and the owner's one card ("Dojo: Ollama stopped … did not come back") when it did not answer; ended when it does. */
export async function startOwnServeOrTell(host: OllamaHost, baseUrl: string, residentCount: number): Promise<boolean> {
  const answered = await startOwnServe(host, baseUrl, residentCount);
  if (answered) ownerConditionCleared('ollama-down');
  else if (tellOwnerOnce('ollama-down')) ownerCardFrame(OLLAMA_DOWN_WORDS, 'warning');
  return answered;
}

/** The loaded-model limit in launchd's environment (the app and Homebrew's job read it when they start). Returns the
 *  value set, or null when launchd already holds one at least as high (an owner's higher value is never lowered). */
export async function setLaunchdLimit(host: OllamaHost, residentCount: number): Promise<string | null> {
  const raised = raisedLoadedLimit(await host.getenv(LIMIT_VAR), desiredLoaded(residentCount));
  if (raised !== null) await host.setenv(LIMIT_VAR, raised);
  return raised;
}
