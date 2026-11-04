// ════════════════════════════════════════════════════════════════════════════
// FIX W, FIELD FAILURE 2 — THE ONE ROUTINE THAT KEEPS THIS BOX'S OLLAMA CURRENT, RUNNING AND LASTING.
//
// Owner ruling OR-UPKEEP-AUTOMATIC (2026-11-03): "The install process needs to make sure the proper version is installed.
// Period." / "All of this needs to be done automatically." `ensureOllamaCurrent` is the only upkeep of Ollama: setup's start,
// every Dojo start (`ollama-model-limit.ts`), the install of the Dojo's own models (setup, an update's first boot, Repair, the
// health check's retry: `ollama-pair-gate.ts`), setup's own pull, and a registry refusal all run it. It ends when the version
// RUNNING meets the need, whoever started Ollama:
//   1. the program on disk, BEFORE any hold (review M1: brew changes only the disk, so local calls go on meanwhile): an app
//      Homebrew owns → `brew fetch --cask` then `brew upgrade --cask <its token>` (never `reinstall`); an app Homebrew does not
//      own (downloaded from ollama.com), on macOS 14+ → `brew fetch --cask ollama-app` then `brew install --cask --force
//      ollama-app`, so Homebrew owns it from then on; anything else → `brew upgrade ollama`, or `brew install ollama`. The cask
//      needs Sonoma; below it, or when the cask does not install or its app does not answer, the formula and Homebrew's service
//      are the path (review M3). Quarantine is never stripped; nothing here runs `--zap` or `uninstall`, or touches `~/.ollama`;
//   2. only an Ollama program is ever stopped (review H1: a listener that is not Ollama, Docker's or a tunnel's, is left
//      alone). Inside the quiet hold, whatever Ollama serves is stopped and confirmed gone: the app is quit, Homebrew's service
//      is restarted by Homebrew, a serve nothing supervises gets a TERM, with the limit in launchd FIRST so a supervisor's
//      respawn inherits it. A respawn that meets the need is kept, and SETTLED (review H3), like another user's current Ollama:
//      no later start or health retry stops it again;
//   3. it starts again as a kind that lasts: the app, or Homebrew's service, or, when the service cannot start, the program on
//      disk as a detached `ollama serve` (review H2: Ollama is never left down while a program that runs is on disk);
//   4. `/api/version` must meet the need; only then do the callers pull. A start still coming up is not a verdict (review M2).
// Fix W review M4/M5 ("a serve the Dojo did not start is never stopped") is overruled by the owner. What cannot be fixed is ONE
// plain card (`ollama-too-old`), and `ollama-down` when an Ollama it stopped is gone with nothing that runs on disk.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { childFailureText } from '../update/child-failure.js';
import { type OllamaHost } from './ollama-host.js';
import { holdWhenQuiet } from './ollama-quiet.js';
import { isUnknownBuild, ollamaAtLeast, readOllamaVersion } from './ollama-version.js';
import {
  classifyOllama, portOf, readConfig, setConfig, setLaunchdLimit, settleTakeover, settledListener, startApp, startLasting, stopApp, stopServe, takeoverSettled,
  type Start,
} from './ollama-restart.js';
import { ownerCardFrame } from './owner-card-frames.js';
import { OLLAMA_DOWN_WORDS, OLLAMA_TOO_OLD_WORDS, ownerConditionCleared, tellOwnerOnce } from '../healer/owner-notices.js';

const logger = createLogger('ollama-upgrade');
/** The Ollama app's cask (Homebrew renamed it from `ollama`); an app Homebrew does not own is taken over under it. */
const APP_CASK = 'ollama-app';

/** A minimum version; `'newer'` (the registry refused and named none: newer than the one running); null (no version need). */
export type Need = string | 'newer' | null;

export interface UpgradeResult {
  /** Ollama runs and meets the need. */
  ok: boolean;
  /** Nothing could be judged (nothing listens and nothing could be started): not a failure to hold or to tell the owner about. */
  transient?: boolean;
  /** Ollama is still starting (review M2): not a verdict; the install waits for its first answer instead of telling a card. */
  starting?: boolean;
  /** What the Dojo did, or why it could not, in plain words (the Settings card's line); absent when nothing needed doing. */
  line?: string;
}

/** The one card for an Ollama too old that the Dojo could not update (read when used: the words sit in an import cycle). */
export function tellOllamaTooOld(): void { if (tellOwnerOnce('ollama-too-old')) ownerCardFrame(OLLAMA_TOO_OLD_WORDS, 'warning', undefined, 'action'); }   // one of the cases the Dojo cannot fix itself

/** Nothing listens: start what is installed, as a kind that lasts (a plain binary on the PATH as the detached serve). */
async function startInstalled(host: OllamaHost, baseUrl: string, residentCount: number): Promise<Start> {
  try {
    const app = await host.appInstalled();
    const formula = !app && await host.brewFormulaInstalled();
    if (!app && !formula && !await host.cliRuns()) return 'dead';
    await setLaunchdLimit(host, residentCount);
    const started = app ? await startApp(host, baseUrl) : await startLasting(host, baseUrl, residentCount, formula);
    if (started !== 'dead') setConfig('ollama_limit_restart_owed', null);
    logger.info('Nothing served Ollama, so the Dojo started it', { kind: app ? 'app' : formula ? 'brew-service' : 'serve', started });
    return started;
  } catch (err) {
    logger.warn('The Dojo could not start Ollama', { error: childFailureText(err) });
    return 'dead';
  }
}

/** Re-review LOW-3: a start an upkeep left "starting" (alive, not answering yet) is judged at the NEXT upkeep (a start, a health
 *  retry, Repair). Still not answering then, it never will (an app behind a prompt nobody sees, a hung serve): it is ended and
 *  Ollama started another way (the formula and Homebrew's service, then the detached serve), or, with nothing left, it is down. */
const STARTING = 'ollama_start_pending';
async function startingNow(host: OllamaHost): Promise<'app' | 'service' | 'serve'> {
  return (await host.appPids()).length > 0 ? 'app' : (await host.brewServicePid()) !== null ? 'service' : 'serve';
}
/** Resolves 'dead' when it ended a stuck start and nothing else would run (this pass then starts nothing again), else null. */
async function endStuckStart(host: OllamaHost, baseUrl: string, residentCount: number): Promise<'dead' | null> {
  const was = readConfig(STARTING);
  if (!was) return null;
  setConfig(STARTING, null);
  if (await host.answers(baseUrl)) return null;
  logger.warn('A start the Dojo made is still not answering at the next look; it is ended and Ollama is started another way', { was });
  if (was === 'app') await stopApp(host).catch(() => undefined);
  else if (was === 'service') await host.stopBrewService().catch(() => undefined);
  else { const l = settledListener(); if (l) host.terminate(l.pid); }
  const formula = was !== 'serve' && await host.hasBrew()
    && (await host.brewFormulaInstalled() || await host.brew(['install', 'ollama']).then(() => true, () => false));
  const started: Start = formula ? await startLasting(host, baseUrl, residentCount, was === 'app') : 'dead';
  if (started === 'starting') setConfig(STARTING, await startingNow(host));
  if (started !== 'dead') return null;
  if (tellOwnerOnce('ollama-down')) ownerCardFrame(OLLAMA_DOWN_WORDS, 'warning', undefined, 'action');
  return 'dead';
}

type Step = 'install' | 'stop' | 'again' | 'start';
/** A step failed: which one says the plain reason. */
class StepFailed extends Error { constructor(readonly step: Step, cause: unknown) { super(childFailureText(cause)); } }
const during = async <T>(step: Step, work: () => Promise<T>): Promise<T> => { try { return await work(); } catch (e) { throw e instanceof StepFailed ? e : new StepFailed(step, e); } };
const WHY: Record<Step, string> = {
  install: 'Homebrew could not install the newer Ollama.',
  stop: 'it runs as another user or as the system, so the Dojo cannot stop it.',
  again: 'something on this Mac starts the old Ollama again whenever it stops.',
  start: 'it did not start again after the update.',
};

/** Make the Ollama running on this box meet `need`, running as a kind that lasts (see the header). */
export async function ensureOllamaCurrent(
  host: OllamaHost, local: { id: string; baseUrl: string }, need: Need, residentCount: number,
): Promise<UpgradeResult> {
  const port = portOf(local.baseUrl);
  if (await endStuckStart(host, local.baseUrl, residentCount) === 'dead') {
    return { ok: false, line: 'Ollama was started but never answered, and nothing else on this Mac can run it now. The Dojo tries again at its next start.' };
  }
  let found = await classifyOllama(host, port);
  if (!found) {
    const started = await startInstalled(host, local.baseUrl, residentCount);
    if (started === 'answering') found = await classifyOllama(host, port);
    if (started === 'starting') setConfig(STARTING, await startingNow(host));
    if (!found) return started === 'starting' ? { ok: false, transient: true, starting: true, line: 'Ollama is starting.' } : { ok: false, transient: true, line: 'Ollama is not running, and the Dojo could not start it at that moment.' };
  }
  const here = found;
  const before = await readOllamaVersion(local.baseUrl);
  const meets = (v: string | null): boolean => (need === 'newer' ? v !== null && v !== before : need === null || v === null || isUnknownBuild(v) || ollamaAtLeast(v, need));
  const stale = need === 'newer' || !meets(before);
  const ok = (line?: string): UpgradeResult => { setConfig(STARTING, null); ownerConditionCleared('ollama-too-old'); ownerConditionCleared('ollama-down'); return { ok: true, line }; };
  const tooOld = !stale ? '' : need === 'newer' ? `Ollama ${before ?? '(unknown version)'} is older than the model needs. `
    : `Ollama ${before ?? '(unknown version)'} is older than the Dojo's models need (${need}). `;
  const cannot = (why: string): UpgradeResult => {
    logger.warn('The Dojo could not update or take over the local Ollama', { kind: here.kind, have: before, need, why });
    if (!stale) return ok();   // it serves what the models need; only the limit and lasting past a Dojo restart are missing
    tellOllamaTooOld();
    return { ok: false, line: `${tooOld}The Dojo could not update it: ${why}` };
  };
  if (here.kind === 'not-ollama') return cannot(`the program answering on Ollama's port is not Ollama (${here.path.split('/').pop()}), so the Dojo leaves it alone.`);
  const lasts = here.kind === 'app' || here.kind === 'brew-service';
  if (!stale && (lasts || isUnknownBuild(before) || takeoverSettled(here))) return ok();
  if (!await host.hasBrew()) return cannot('Homebrew is not installed on this Mac.');
  let started: Start;
  try {
    started = here.kind === 'app' ? await upkeepApp(host, local, here.pid, residentCount) : await upkeepServe(host, local, here, stale, meets, residentCount);
    if (started !== 'dead') setConfig('ollama_limit_restart_owed', null);   // the restart carried the limit
  } catch (err) {
    const step = err instanceof StepFailed ? err.step : 'start';
    logger.warn('The Ollama upkeep did not complete', { kind: here.kind, step, error: childFailureText(err) });
    if (step === 'stop' && !stale) { settleTakeover(here); return ok(); }   // another user's current Ollama: left serving, never stopped again
    if (step !== 'install' && !await host.answers(local.baseUrl) && (await host.listener(port)) === null) started = 'dead';
    else return cannot(WHY[step]);
  }
  if (started === 'dead') {   // it was stopped and nothing on disk would run: the one card that it is down
    if (tellOwnerOnce('ollama-down')) ownerCardFrame(OLLAMA_DOWN_WORDS, 'warning', undefined, 'action');
    return { ok: false, line: `${tooOld}Ollama stopped while the Dojo was updating it and has not come back yet.` };
  }
  if (started === 'starting') { setConfig(STARTING, await startingNow(host)); return { ok: false, transient: true, starting: true, line: 'Ollama is starting again after the update.' }; }
  const after = await readOllamaVersion(local.baseUrl);
  if (!meets(after)) return cannot(after === before ? 'Homebrew has no newer Ollama to install.' : `it is still on ${after ?? 'an unknown version'}.`);
  const now = await classifyOllama(host, port);
  const did = now?.kind === 'app' ? 'the Ollama app' : 'Ollama (installed with Homebrew)';
  logger.info('The local Ollama is current', { kind: now?.kind, before, after });
  return ok(stale ? `Updated ${did} from ${before ?? 'an older version'} to ${after} and restarted it.` : undefined);
}

/** The app. Review M3: the cask needs Sonoma; below it, or when the cask does not install or its app does not answer, the app is
 *  quit and the formula and Homebrew's service take its place. Downloads happen before the app is quit (review M1). */
async function upkeepApp(host: OllamaHost, local: { id: string; baseUrl: string }, pid: number, residentCount: number): Promise<Start> {   // reached only when it is too old
  const token = await host.brewCaskToken();
  let viaCask = token !== null || ((await host.macosMajor()) ?? 14) >= 14;
  if (viaCask) viaCask = await host.brew(['fetch', '--cask', token ?? APP_CASK]).then(() => true, (e: unknown) => { logger.warn('The Ollama cask could not be fetched; the formula is the path', { error: childFailureText(e) }); return false; });
  if (!viaCask) await during('install', async () => host.brew([await host.brewFormulaInstalled() ? 'upgrade' : 'install', 'ollama']));
  await setLaunchdLimit(host, residentCount);
  const endHold = await holdWhenQuiet(local.id);   // only the stop and the start interrupt local calls
  try {
    await during('stop', () => stopApp(host, pid));
    if (viaCask) {
      const installed = await host.brew(token ? ['upgrade', '--cask', token] : ['install', '--cask', '--force', APP_CASK])
        .then(() => true, (e: unknown) => { logger.warn('The Ollama cask did not install; the formula is the path', { error: childFailureText(e) }); return false; });
      const app: Start = installed ? await startApp(host, local.baseUrl) : 'dead';
      // Homebrew's own app, upgraded, keeps its approval: a slow start is only slow (review M2). A first install over an app
      // from ollama.com that does not answer may sit behind a first-launch prompt nobody sees (review M3): the formula instead.
      if (app === 'answering' || (app === 'starting' && token !== null)) return app;
      if (installed) {   // quit it, and the formula instead
        await stopApp(host).catch(() => undefined);
        logger.warn('The updated Ollama app did not answer; the formula and Homebrew\'s service take its place', { app });
      }
      await during('install', async () => host.brew([await host.brewFormulaInstalled() ? 'upgrade' : 'install', 'ollama']));
    }
    return await during('start', () => startLasting(host, local.baseUrl, residentCount));
  } finally { endHold(); }
}

/** A serve (Homebrew's service, or one nothing supervises). Review M1: `brew` before the hold; review H3: the limit before the TERM. */
async function upkeepServe(
  host: OllamaHost, local: { id: string; baseUrl: string }, found: { kind: string; pid: number; path: string }, stale: boolean,
  meets: (v: string | null) => boolean, residentCount: number,
): Promise<Start> {
  const formula = await host.brewFormulaInstalled();
  if (stale || !formula) await during('install', () => host.brew([formula ? 'upgrade' : 'install', 'ollama']));
  if (!await host.cliRuns()) throw new StepFailed('install', 'the updated ollama program does not run, so the running one was left as it is');
  await setLaunchdLimit(host, residentCount);
  const endHold = await holdWhenQuiet(local.id);
  try {
    if (found.kind === 'brew-service') return await during('start', () => startLasting(host, local.baseUrl, residentCount));
    const again = await during('stop', () => stopServe(host, portOf(local.baseUrl), found.pid));
    if (!again) return await during('start', () => startLasting(host, local.baseUrl, residentCount));
    if (!meets(await readOllamaVersion(local.baseUrl))) throw new StepFailed('again', `pid ${again.pid} (${again.path}) took the port again on an old version`);
    settleTakeover(again);   // a supervisor of the owner's runs the new program: kept, and never stopped again for this
    return 'answering';
  } finally { endHold(); }
}
