// ════════════════════════════════════════════════════════════════════════════
// v3.5 — THE DOJO RAISES OLLAMA'S LOADED-MODEL LIMIT ON THE MAC (owner decision 2026-10-24,
// "Dojo raises the limit"). Fix W: for EVERY Ollama the Dojo can restart, and never by asking the owner.
//
// Ollama keeps at most OLLAMA_MAX_LOADED_MODELS models loaded — by default 3 per GPU, and Apple Silicon is
// one GPU (docs.ollama.com/faq; `server/sched.go`: `defaultModelsPerGPU = 3`) — and at that limit it unloads
// an idle model to load the next. The embedder and the Dojo's resident pair are three by themselves, so an
// agent's local model and one of them would unload each other turn after turn.
//
// THE VALUE: 1 (the embedder) + the Dojo's two standard models + the Ollama lock's agent slots
// (`ollama_max_concurrent_models`, the agent models the lock lets load at once). It only ever RAISES: an
// owner's own higher value is left exactly as it is (fix round 4, NB-3).
//
// WHEN: at setup and at EVERY Dojo start — `launchctl setenv` does not survive a reboot.
// WHERE (the kind is read from the listener's REAL program, `ollama-restart.ts`):
//   · the Ollama app, or Homebrew's service → `launchctl setenv` (launchd's environment is what they start with:
//     docs, "If Ollama is run as a macOS application, environment variables should be set using launchctl"), and
//     the running one is restarted ONCE;
//   · anything else (a serve nothing supervises, a plain binary), nothing serving while Ollama is installed, or an Ollama
//     older than the Dojo's models need → the one upkeep routine (`ollama-upgrade.ts ensureOllamaCurrent`) takes it over:
//     current, started as the app or Homebrew's service, with the limit in launchd first (owner ruling OR-UPKEEP-AUTOMATIC);
//   · a source build (version 0.0.0) nothing supervises → left as it is, and nothing is told;
//   · no local Ollama, or none installed → nothing at all.
// What the Dojo did is a log line; the owner is told only when it could not (OLLAMA_LIMIT_FAILED_WORDS).
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { STANDARD_DECISION_MODEL, STANDARD_TAGS, STANDARD_WRITER_MODEL, localOllamaProvider } from './local-standard.js';
import { ownerCardFrame } from './owner-card-frames.js';
import { holdWhenQuiet } from './ollama-quiet.js';
import { type OllamaHost, getOllamaHost, makeRealDeps } from './ollama-host.js';
import {
  LIMIT_VAR, classifyOllama, desiredLoaded, inUpkeep, portOf, raisedLoadedLimit, readConfig, restartApp, setConfig, setLaunchdLimit, startLasting,
} from './ollama-restart.js';
import { ensureOllamaCurrent } from './ollama-upgrade.js';
import { isUnknownBuild, ollamaAtLeast, readOllamaVersion, requiredOllamaVersion } from './ollama-version.js';
import { childFailureText } from '../update/child-failure.js';
import { tellOwnerOnce, ownerConditionCleared, OLLAMA_LIMIT_FAILED_WORDS } from '../healer/owner-notices.js';

export { OLLAMA_LIMIT_FAILED_WORDS, raisedLoadedLimit, makeRealDeps };
export type OllamaLimitDeps = OllamaHost;
const logger = createLogger('ollama-model-limit');

const restartOwed = (): boolean => readConfig('ollama_limit_restart_owed') !== null;

/** The limit the Dojo needs: the embedder + the pair + the lock's agent slots (see the header). */
export const desiredOllamaMaxLoaded = (): number => desiredLoaded(STANDARD_TAGS.length);

let restarting: Promise<void> | null = null;
/** Resolves when no restart is pending (tests; never awaited by a boot or a request). */
export function ollamaRestartSettled(): Promise<void> { return restarting ?? Promise.resolve(); }

export async function ensureOllamaModelLimit(
  host: OllamaHost | null = getOllamaHost(), platform: NodeJS.Platform = process.platform,
): Promise<'already' | 'set' | 'unmanaged' | 'failed' | 'skipped'> {
  if (platform !== 'darwin') return 'skipped';
  if (!host) return 'skipped';                         // a test run's real launchctl and real app are never touched
  const local = localOllamaProvider();
  if (!local) return 'skipped';                        // NB-2: no local Ollama — nothing, no card
  const want = desiredOllamaMaxLoaded();
  try {
    const found = await classifyOllama(host, portOf(local.baseUrl));
    const need = requiredOllamaVersion([STANDARD_DECISION_MODEL, STANDARD_WRITER_MODEL]);
    const have = found ? await readOllamaVersion(local.baseUrl) : null;
    const lasts = found?.kind === 'app' || found?.kind === 'brew-service';
    if (found && !lasts && (found.kind === 'not-ollama' || isUnknownBuild(have))) {   // review H1: never another program
      logger.info('The local Ollama is not one the Dojo takes over (not Ollama, or a source build); its limit is left as it is', { program: found.path });
      return 'unmanaged';
    }
    if (!lasts || (need !== null && have !== null && !isUnknownBuild(have) && !ollamaAtLeast(have, need))) {
      if (!found && !(await host.appInstalled()) && !(await host.brewFormulaInstalled()) && !(await host.cliRuns())) return 'skipped';   // nothing to start
      restarting ??= inUpkeep(() => ensureOllamaCurrent(host, local, need, STANDARD_TAGS.length)).then(() => undefined).finally(() => { restarting = null; });
      return 'set';
    }
    const raised = raisedLoadedLimit(await host.getenv(LIMIT_VAR), want);
    if (raised === null && !restartOwed()) {
      ownerConditionCleared('ollama-limit-failed');
      return 'already';
    }
    if (raised !== null) {
      await host.setenv(LIMIT_VAR, raised);
      logger.info('Raised Ollama\'s loaded-model limit; the running Ollama is restarted once to pick it up', { value: raised });
    }
    setConfig('ollama_limit_restart_owed', '1');   // owed until the restart has really happened (NB-5)
    restarting ??= inUpkeep(() => restartWhenQuiet(host, local)).finally(() => { restarting = null; });
    return 'set';
  } catch (err) {
    failed(err);
    return 'failed';
  }
}

function failed(err: unknown): void {
  logger.warn('Could not raise Ollama\'s loaded-model limit (non-fatal)', { error: childFailureText(err) });
  if (tellOwnerOnce('ollama-limit-failed')) ownerCardFrame(OLLAMA_LIMIT_FAILED_WORDS, 'warning');
}

/** NB-1: deferred until nothing is in flight on the local Ollama; new calls wait while it runs. */
async function restartWhenQuiet(host: OllamaHost, local: { id: string; baseUrl: string }): Promise<void> {
  const endHold = await holdWhenQuiet(local.id);
  try {
    const found = await classifyOllama(host, portOf(local.baseUrl));
    if (!restartOwed()) return;   // queued behind an upgrade? Its restart carried the limit already: nothing is owed any more
    if (found?.kind === 'brew-service') {
      await setLaunchdLimit(host, STANDARD_TAGS.length);
      // review H2: the service, or the program on disk as the detached serve when the service cannot start
      if (await startLasting(host, local.baseUrl, STANDARD_TAGS.length) === 'dead') throw new Error('Ollama did not start again after the limit restart');
    } else {
      await restartApp(host, local.baseUrl, found?.kind === 'app' ? found.pid : undefined);
    }
    setConfig('ollama_limit_restart_owed', null);
    ownerConditionCleared('ollama-limit-failed');
    logger.info('Restarted the local Ollama to apply its loaded-model limit', { kind: found?.kind ?? 'app' });
  } catch (err) {
    // The restart stays owed (the next start tries it again) and the hold is released below: a waiting call
    // proceeds into the platform's ordinary Ollama-down path.
    failed(err);
  } finally {
    endHold();
  }
}
