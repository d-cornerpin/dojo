// WHAT KIND OF OLLAMA THIS BOX RUNS, AND HOW THE DOJO STOPS, STARTS AND UPDATES EACH KIND. The kind is read from the REAL
// program listening on Ollama's port (links resolved): `app` (inside Ollama.app), `brew-service` (Homebrew's launchd job),
// `formula` (Homebrew's program, unsupervised), `other` (another Ollama program), `not-ollama` (Docker, an ssh tunnel: never
// stopped). The app and Homebrew's service last across Dojo restarts, so the Dojo restarts into one of them, with the
// loaded-model limit in launchd's environment first, once no local model is busy (`whenQuiet`).

import { getOllamaLock, getOllamaMaxConcurrent } from './ollama-lock.js';
import { createLogger } from '../logger.js';
import { childFailureText } from '../update/child-failure.js';
import { type OllamaHost, TICK_MS, WAIT_MS } from './ollama-host.js';
import { noteUpkeep, readOllamaVersion, upkeepRecord } from './ollama-version.js';

const logger = createLogger('ollama-restart');

export const LIMIT_VAR = 'OLLAMA_MAX_LOADED_MODELS';
/** The Ollama app's bundle in a path, as Ollama's own CLI recognises it (`cmd/start_darwin.go`). */
export const APP_PATH = /\/Ollama\s?\d*\.app\//;
/** A Homebrew formula's program: the Cellar path `brew upgrade ollama` replaces. */
export const BREW_FORMULA_PATH = /\/Cellar\/ollama\//;

export type OllamaKind = 'app' | 'brew-service' | 'formula' | 'other' | 'not-ollama';
/** An Ollama program: inside Ollama.app, or a file named `ollama` (the formula's, the CLI tarball's, a source build's). */
export const isOllamaProgram = (path: string): boolean => APP_PATH.test(path) || /(^|\/)ollama$/.test(path);


export const portOf = (baseUrl: string): number => Number(new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`).port || 11434);

/** The loaded-model limit the Dojo needs: the embedder, its resident models and the lock's agent slots. */
export function desiredLoaded(residentCount: number): number {
  getOllamaLock().reloadConfig();
  return 1 + residentCount + getOllamaMaxConcurrent();
}

/** The value to set, or null when `current` is already at least `want` (an owner's higher value stands). */
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

/** How a start ended: still alive after Ollama's own CLI patience is a slow start; only a start whose process is gone is `dead`. */
export type Start = 'answering' | 'starting' | 'dead';
export async function waitForStart(host: OllamaHost, baseUrl: string, alive: () => boolean | Promise<boolean>): Promise<Start> {
  if (await waitUntil(host, () => host.answers(baseUrl))) return 'answering';
  return (await alive()) ? 'starting' : 'dead';
}
const appAlive = (host: OllamaHost) => async (): Promise<boolean> => (await host.appPids()).length > 0;

/** The Ollama app: a TERM to its processes, then opened the way Ollama's CLI opens it. Throws when it did not quit or is gone. */
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

export async function startApp(host: OllamaHost, baseUrl: string): Promise<Start> {
  await host.launchApp();
  return waitForStart(host, baseUrl, appAlive(host));
}

/** Homebrew's job: `brew services restart ollama` (launchd's environment, set by the caller, is inherited); how its start ended. */
export async function restartBrewService(host: OllamaHost, baseUrl: string): Promise<Start> {
  await host.restartBrewService();
  return waitForStart(host, baseUrl, async () => (await host.brewServicePid()) !== null);
}

/** A takeover that cannot end in a kind that lasts (an owner's job that starts Ollama again, another user's Ollama, the
 *  fallback serve) is settled for that listener, so no later look stops it again. */
export const settleTakeover = (l: { pid: number; path: string }): void => noteUpkeep({ settled: { pid: l.pid, path: l.path } });
export function takeoverSettled(l: { pid: number; path: string }): boolean { const v = upkeepRecord().settled; return !!v && v.pid === l.pid && v.path === l.path; }

/** Homebrew's service, or, when it cannot start, the program on disk as a detached `ollama serve` with the limit in its
 *  own environment, recorded as settled: Ollama is never left down while a program that runs is on disk. */
export async function startLasting(host: OllamaHost, baseUrl: string, residentCount: number, viaService = true): Promise<Start> {
  if (viaService) {
    const service = await restartBrewService(host, baseUrl).catch((): Start => 'dead');
    if (service !== 'dead') return service;
    // Unloaded, so a job launchd loaded anyway never crash-loops against the serve for the port.
    await host.stopBrewService().catch(() => undefined);
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

/** Resolves once nothing is in flight on the local Ollama (the lock's slots and its unslotted work). */
export async function whenQuiet(providerId: string): Promise<void> {
  for (let waited = 0; getOllamaLock().localBusy(providerId) > 0; waited += TICK_MS) {
    if (waited === 5 * 60_000) logger.warn('An Ollama restart has waited five minutes for local work to end', { providerId });
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

/** The limit restart of `found`, a kind that lasts, once nothing is busy. Throws when Ollama did not come back. */
export async function restartWithLimit(host: OllamaHost, local: { id: string; baseUrl: string }, found: { kind: OllamaKind; pid: number }, residentCount: number): Promise<void> {
  await whenQuiet(local.id);
  if (found.kind !== 'brew-service') await restartApp(host, local.baseUrl, found.pid);
  else if (await startLasting(host, local.baseUrl, residentCount) === 'dead') throw new Error('Ollama did not start again after the limit restart');
}

/** A serve nothing supervises: a TERM, confirmed gone; resolves a supervisor's respawn or null. Throws when the signal is refused. */
export async function stopServe(host: OllamaHost, port: number, pid: number): Promise<{ pid: number; path: string } | null> {
  host.terminate(pid);
  if (!await waitUntil(host, async () => !host.alive(pid) && (await host.listener(port))?.pid !== pid)) {
    throw new Error('the Ollama server did not stop (it runs as another user or as the system)');
  }
  return host.listener(port);
}

/** The loaded-model limit in launchd's environment: the value set, or null when launchd already holds one at least as high. */
export async function setLaunchdLimit(host: OllamaHost, residentCount: number): Promise<string | null> {
  const raised = raisedLoadedLimit(await host.getenv(LIMIT_VAR), desiredLoaded(residentCount));
  if (raised !== null) await host.setenv(LIMIT_VAR, raised);
  return raised;
}

/** Nothing listens: start what is installed, as a kind that lasts (a plain binary on the PATH as the detached serve). */
export async function startInstalled(host: OllamaHost, baseUrl: string, residentCount: number): Promise<Start> {
  try {
    const app = await host.appInstalled();
    const formula = !app && await host.brewFormulaInstalled();
    if (!app && !formula && !await host.cliRuns()) return 'dead';
    await setLaunchdLimit(host, residentCount);
    const started = app ? await startApp(host, baseUrl) : await startLasting(host, baseUrl, residentCount, formula);
    if (started !== 'dead') noteUpkeep({ limitOwed: undefined });
    logger.info('Nothing served Ollama, so the Dojo started it', { kind: app ? 'app' : formula ? 'brew-service' : 'serve', started });
    return started;
  } catch (err) {
    logger.warn('The Dojo could not start Ollama', { error: childFailureText(err) });
    return 'dead';
  }
}

export const startingNow = async (host: OllamaHost): Promise<'app' | 'service' | 'serve'> =>
  ((await host.appPids()).length > 0 ? 'app' : (await host.brewServicePid()) !== null ? 'service' : 'serve');

/** A start an earlier run left "starting" that still does not answer is ended and Ollama started another way; 'dead' when nothing else would run. */
export async function endStuckStart(host: OllamaHost, baseUrl: string, residentCount: number): Promise<'dead' | null> {
  const was = upkeepRecord().starting;
  if (!was) return null;
  noteUpkeep({ starting: undefined });
  if (await host.answers(baseUrl)) return null;
  logger.warn('A start the Dojo made is still not answering at the next look; it is ended and Ollama is started another way', { was });
  if (was === 'app') await stopApp(host).catch(() => undefined);
  else if (was === 'service') await host.stopBrewService().catch(() => undefined);
  else { const l = upkeepRecord().settled; if (l) host.terminate(l.pid); }
  const formula = was !== 'serve' && await host.hasBrew()
    && (await host.brewFormulaInstalled() || await host.brew(['install', 'ollama']).then(() => true, () => false));
  const started: Start = formula ? await startLasting(host, baseUrl, residentCount, was === 'app') : 'dead';
  if (started === 'starting') noteUpkeep({ starting: await startingNow(host) });
  return started === 'dead' ? 'dead' : null;
}

export class StepFailed extends Error {
  constructor(readonly step: 'install' | 'stop' | 'again' | 'start', cause: unknown) { super(childFailureText(cause)); }
}
const during = async <T>(step: StepFailed['step'], work: () => Promise<T>): Promise<T> => {
  try { return await work(); } catch (e) { throw e instanceof StepFailed ? e : new StepFailed(step, e); }
};
/** The Ollama app's cask (Homebrew renamed it from `ollama`); an app Homebrew does not own is taken over under it. */
const APP_CASK = 'ollama-app';
const formulaStep = async (host: OllamaHost): Promise<void> => during('install', async () => host.brew([await host.brewFormulaInstalled() ? 'upgrade' : 'install', 'ollama']));

/** Update the app. The download happens before the app is quit. The cask needs Sonoma; below it, or when the cask does not
 *  install or its new app does not answer, the app is quit and the formula and Homebrew's service take its place. */
export async function upkeepApp(host: OllamaHost, local: { id: string; baseUrl: string }, pid: number, residentCount: number): Promise<Start> {
  const token = await host.brewCaskToken();
  let viaCask = token !== null || ((await host.macosMajor()) ?? 14) >= 14;
  if (viaCask) viaCask = await host.brew(['fetch', '--cask', token ?? APP_CASK]).then(() => true, (e: unknown) => { logger.warn('The Ollama cask could not be fetched; the formula is the path', { error: childFailureText(e) }); return false; });
  if (!viaCask) await formulaStep(host);
  await setLaunchdLimit(host, residentCount);
  await whenQuiet(local.id);   // only the stop and the start interrupt local calls
  await during('stop', () => stopApp(host, pid));
  if (viaCask) {
    const installed = await host.brew(token ? ['upgrade', '--cask', token] : ['install', '--cask', '--force', APP_CASK])
      .then(() => true, (e: unknown) => { logger.warn('The Ollama cask did not install; the formula is the path', { error: childFailureText(e) }); return false; });
    const app: Start = installed ? await startApp(host, local.baseUrl) : 'dead';
    // Homebrew's own app, upgraded, keeps its approval: a slow start is only slow. A first install over an app from
    // ollama.com that does not answer may sit behind a first-launch prompt nobody sees: the formula instead.
    if (app === 'answering' || (app === 'starting' && token !== null)) return app;
    if (installed) {
      await stopApp(host).catch(() => undefined);
      logger.warn('The updated Ollama app did not answer; the formula and Homebrew\'s service take its place', { app });
    }
    await formulaStep(host);
  }
  return during('start', () => startLasting(host, local.baseUrl, residentCount));
}

/** Update a serve (Homebrew's service, or one nothing supervises): `brew` first, the limit in launchd before the TERM. */
export async function upkeepServe(
  host: OllamaHost, local: { id: string; baseUrl: string }, found: { kind: string; pid: number; path: string }, stale: boolean,
  meets: (v: string | null) => boolean, residentCount: number,
): Promise<Start> {
  const formula = await host.brewFormulaInstalled();
  if (stale || !formula) await during('install', () => host.brew([formula ? 'upgrade' : 'install', 'ollama']));
  if (!await host.cliRuns()) throw new StepFailed('install', 'the updated ollama program does not run, so the running one was left as it is');
  await setLaunchdLimit(host, residentCount);
  await whenQuiet(local.id);
  if (found.kind === 'brew-service') return during('start', () => startLasting(host, local.baseUrl, residentCount));
  const again = await during('stop', () => stopServe(host, portOf(local.baseUrl), found.pid));
  if (!again) return during('start', () => startLasting(host, local.baseUrl, residentCount));
  if (!meets(await readOllamaVersion(local.baseUrl))) throw new StepFailed('again', `pid ${again.pid} (${again.path}) took the port again on an old version`);
  settleTakeover(again);   // a supervisor of the owner's runs the new program: kept, and never stopped again for this
  return 'answering';
}
