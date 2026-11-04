// ════════════════════════════════════════════════════════════════════════════
// FIX W, FIELD FAILURE 2 — THE ONE ROUTINE THAT KEEPS THIS BOX'S OLLAMA CURRENT, RUNNING AND LASTING.
//
// Owner ruling OR-UPKEEP-AUTOMATIC (2026-11-03): "The install process needs to make sure the proper version is installed.
// Period." / "All of this needs to be done automatically." `ensureOllamaCurrent` is the only upkeep of Ollama: setup's start,
// every Dojo start (`ollama-model-limit.ts`), the install of the Dojo's own models (setup, an update's first boot, Repair, the
// health check's retry: `ollama-pair-gate.ts`) and a registry refusal all run it. It ends when the version RUNNING meets the
// need, whoever started Ollama:
//   1. the program on disk: an app Homebrew owns → `brew upgrade --cask <its token>` (never `reinstall`: upgrade keeps the
//      app's approval); an app Homebrew does not own (downloaded from ollama.com) → `brew install --cask --force ollama-app`,
//      so Homebrew owns it from then on; anything else → `brew upgrade ollama`, or `brew install ollama` without the formula;
//   2. inside the quiet hold (`holdWhenQuiet`), whatever serves is stopped and confirmed gone: the app is quit (its own TERM,
//      no AppleScript), Homebrew's service is restarted by Homebrew, and a serve nothing supervises (the 3.4.1 Dojo's child, a
//      shell's, an agent's) gets a TERM. A supervisor that starts one again in its place (a launchd job of the owner's) runs
//      the program on disk at that path: kept when it meets the need, else one of the cases the Dojo cannot fix (a
//      `launchctl kickstart` would start that same program again, so it is not tried);
//   3. it starts again as a kind that lasts, with the loaded-model limit in launchd's environment first: the app is opened,
//      or Homebrew's service (`brew services restart ollama`). Neither dies with the Dojo, as the Dojo's own `serve` did;
//   4. `/api/version` must meet the need; only then do the callers pull.
// Fix W review M4/M5 ("a serve the Dojo did not start is never stopped") is overruled by the owner. What cannot be fixed is ONE
// plain card (`ollama-too-old`): another user's or the system's Ollama (the signal is refused), no Homebrew, Homebrew with
// nothing newer; and `ollama-down` when the Ollama it stopped did not come back. Raw errors go to the log only. Nothing
// listening and nothing installed is not a verdict (`transient`): nothing is held or told.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { childFailureText } from '../update/child-failure.js';
import { type OllamaHost } from './ollama-host.js';
import { holdWhenQuiet } from './ollama-quiet.js';
import { isUnknownBuild, ollamaAtLeast, readOllamaVersion } from './ollama-version.js';
import { classifyOllama, portOf, restartBrewService, setConfig, setLaunchdLimit, startApp, stopApp, stopServe } from './ollama-restart.js';
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
  /** What the Dojo did, or why it could not, in plain words (the Settings card's line); absent when nothing needed doing. */
  line?: string;
}

/** The one card for an Ollama too old that the Dojo could not update (read when used: the words sit in an import cycle). */
export function tellOllamaTooOld(): void { if (tellOwnerOnce('ollama-too-old')) ownerCardFrame(OLLAMA_TOO_OLD_WORDS, 'warning'); }

/** Nothing listens: start what is installed, as a kind that lasts. False when nothing is installed or it did not answer. */
async function startInstalled(host: OllamaHost, baseUrl: string, residentCount: number): Promise<boolean> {
  try {
    const app = await host.appInstalled();
    if (!app && !await host.brewFormulaInstalled()) return false;
    await setLaunchdLimit(host, residentCount);
    if (app) await startApp(host, baseUrl); else await restartBrewService(host, baseUrl);
    setConfig('ollama_limit_restart_owed', null);
    logger.info('Nothing served Ollama, so the Dojo started it', { kind: app ? 'app' : 'brew-service' });
    return true;
  } catch (err) {
    logger.warn('The Dojo could not start Ollama', { error: childFailureText(err) });
    return false;
  }
}

/** Make the Ollama running on this box meet `need`, running as a kind that lasts (see the header). */
export async function ensureOllamaCurrent(
  host: OllamaHost, local: { id: string; baseUrl: string }, need: Need, residentCount: number,
): Promise<UpgradeResult> {
  const port = portOf(local.baseUrl);
  const found = await classifyOllama(host, port) ?? (await startInstalled(host, local.baseUrl, residentCount) ? await classifyOllama(host, port) : null);
  if (!found) return { ok: false, transient: true, line: 'Ollama is not running, and the Dojo could not start it at that moment.' };
  const before = await readOllamaVersion(local.baseUrl);
  const meets = (v: string | null): boolean => (need === 'newer' ? v !== null && v !== before : need === null || v === null || isUnknownBuild(v) || ollamaAtLeast(v, need));
  const stale = need === 'newer' || !meets(before);
  const ok = (line?: string): UpgradeResult => { ownerConditionCleared('ollama-too-old'); ownerConditionCleared('ollama-down'); return { ok: true, line }; };
  if (!stale && (found.kind === 'app' || found.kind === 'brew-service' || isUnknownBuild(before))) return ok();
  const tooOld = !stale ? '' : need === 'newer' ? `Ollama ${before ?? '(unknown version)'} is older than the model needs. `
    : `Ollama ${before ?? '(unknown version)'} is older than the Dojo's models need (${need}). `;
  const cannot = (why: string): UpgradeResult => {
    logger.warn('The Dojo could not update or take over the local Ollama', { kind: found.kind, have: before, need, why });
    if (!stale) return ok();   // it serves what the models need; only the limit and lasting past a Dojo restart are missing
    tellOllamaTooOld();
    return { ok: false, line: `${tooOld}The Dojo could not update it: ${why}` };
  };
  if (!await host.hasBrew()) return cannot('Homebrew is not installed on this Mac.');
  const at = { step: 'install' as 'install' | 'stop' | 'again' | 'start' };   // which step failed decides the plain reason
  try {
    const endHold = await holdWhenQuiet(local.id);   // nothing is in flight while Ollama is down, and new calls wait
    try {
      if (found.kind === 'app') {
        const token = await host.brewCaskToken();
        at.step = 'stop'; await stopApp(host, found.pid);
        at.step = 'install';
        const failed = await (async () => { if (stale) await host.brew(token ? ['upgrade', '--cask', token] : ['install', '--cask', '--force', APP_CASK]); await setLaunchdLimit(host, residentCount); })()
          .then(() => null, (e: unknown) => e ?? new Error('brew failed'));
        at.step = 'start'; await startApp(host, local.baseUrl);   // the app is opened again whether brew worked or not
        if (failed) { at.step = 'install'; throw failed; }
      } else {
        const formula = await host.brewFormulaInstalled();
        if (stale || !formula) await host.brew([formula ? 'upgrade' : 'install', 'ollama']);
        if (found.kind === 'brew-service' || await takeOverServe(host, local.baseUrl, found.pid, meets, (s) => { at.step = s; })) {
          at.step = 'start'; await setLaunchdLimit(host, residentCount); await restartBrewService(host, local.baseUrl);
        }
      }
      setConfig('ollama_limit_restart_owed', null);   // the restart carried the limit
    } finally { endHold(); }
  } catch (err) {
    const { step } = at;
    logger.warn('The Ollama upkeep did not complete', { kind: found.kind, step, error: childFailureText(err) });
    if (step !== 'install' && !await host.answers(local.baseUrl)) {   // it was stopped and is not back
      if (tellOwnerOnce('ollama-down')) ownerCardFrame(OLLAMA_DOWN_WORDS, 'warning');
      return { ok: false, line: `${tooOld}Ollama stopped while the Dojo was updating it and has not come back yet.` };
    }
    return cannot(step === 'install' ? 'Homebrew could not install the newer Ollama.'
      : step === 'stop' ? 'it runs as another user or as the system, so the Dojo cannot stop it.'
      : step === 'again' ? 'something on this Mac starts the old Ollama again whenever it stops.'
      : 'it did not start again after the update.');
  }
  const after = await readOllamaVersion(local.baseUrl);
  if (!meets(after)) return cannot(after === before ? 'Homebrew has no newer Ollama to install.' : `it is still on ${after ?? 'an unknown version'}.`);
  const did = found.kind === 'app' ? 'the Ollama app' : 'Ollama (installed with Homebrew)';
  logger.info('The local Ollama is current and runs as a kind that lasts', { kind: found.kind, before, after });
  return ok(stale ? `Updated ${did} from ${before ?? 'an older version'} to ${after} and restarted it.` : undefined);
}

/** Stop a serve nothing supervises, confirmed gone. True: the port is free and Homebrew's service is to start in its place.
 *  False: a supervisor started one again that meets the need. Throws when it cannot be stopped, or one starts again that does not. */
async function takeOverServe(host: OllamaHost, baseUrl: string, pid: number, meets: (v: string | null) => boolean, at: (s: 'stop' | 'again') => void): Promise<boolean> {
  if (!await host.cliRuns()) throw new Error('the updated ollama program does not run, so the running one was left as it is');
  at('stop');
  const again = await stopServe(host, portOf(baseUrl), pid);
  if (!again) return true;
  at('again');
  if (meets(await readOllamaVersion(baseUrl))) return false;
  throw new Error(`pid ${again.pid} (${again.path}) took the port again on an old version`);
}
