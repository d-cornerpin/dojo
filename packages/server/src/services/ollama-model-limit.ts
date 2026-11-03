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
//   · a `serve` the Dojo started → restarted with the variable in its own environment, once;
//   · anything else (a plain binary, the owner's own launchd job) → the Dojo changes nothing and tells the owner
//     nothing. The pair still works: the engine's calls on it are pinned and take no lock slot, the lock keeps an
//     agent's model to its own slots, and a model Ollama unloaded is loaded again by its next call (`ollama-lock.ts`).
//   · no local Ollama → nothing at all.
// THE RESTART (NB-1, NB-5): only when no call on the local Ollama and no pull is in flight (`ollama-quiet.ts
// holdWhenQuiet`); calls that arrive meanwhile wait for it. A restart that did not happen stays owed and is
// tried again at the next start.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { STANDARD_TAGS, localOllamaProvider } from './local-standard.js';
import { ownerCardFrame } from './owner-card-frames.js';
import { holdWhenQuiet } from './ollama-quiet.js';
import { type OllamaHost, getOllamaHost, makeRealDeps } from './ollama-host.js';
import {
  LIMIT_VAR, OWN_SERVE_LIMIT_KEY, classifyOllama, desiredLoaded, limitFor, portOf, raisedLoadedLimit, readConfig, restartApp,
  restartBrewService, restartOwnServe, setConfig, setLaunchdLimit,
} from './ollama-restart.js';
import { childFailureText } from '../update/child-failure.js';
import {
  tellOwnerOnce, ownerConditionCleared, retireOllamaLimitManualCards, OLLAMA_LIMIT_SET_WORDS, OLLAMA_LIMIT_FAILED_WORDS,
} from '../healer/owner-notices.js';

export { OLLAMA_LIMIT_SET_WORDS, OLLAMA_LIMIT_FAILED_WORDS, raisedLoadedLimit, makeRealDeps };
export type OllamaLimitDeps = OllamaHost;
const logger = createLogger('ollama-model-limit');

const toldValue = (): string | null => readConfig('ollama_limit_told');
const restartOwed = (): boolean => readConfig('ollama_limit_restart_owed') !== null;

/** The limit the Dojo needs: the embedder + the pair + the lock's agent slots (see the header). */
export const desiredOllamaMaxLoaded = (): number => desiredLoaded(STANDARD_TAGS.length);

/** Told once per value (fix round 3): a reboot loses the variable and every start re-applies it silently. */
function tellOncePerValue(key: string, told: string, words: string): void {
  if (toldValue() === told) return;
  ownerConditionCleared('ollama-limit-set');
  if (tellOwnerOnce(key)) ownerCardFrame(words, 'warning');
  setConfig('ollama_limit_told', told);
}

let restarting: Promise<void> | null = null;
/** Resolves when no restart is pending (tests; never awaited by a boot or a request). */
export function ollamaRestartSettled(): Promise<void> { return restarting ?? Promise.resolve(); }

export async function ensureOllamaModelLimit(
  host: OllamaHost | null = getOllamaHost(), platform: NodeJS.Platform = process.platform,
): Promise<'already' | 'set' | 'unmanaged' | 'failed' | 'skipped'> {
  if (platform !== 'darwin') return 'skipped';
  if (!host) return 'skipped';                         // a test run's real launchctl and real app are never touched
  retireOllamaLimitManualCards();
  const local = localOllamaProvider();
  if (!local) return 'skipped';                        // NB-2: no local Ollama — nothing, no card
  const want = desiredOllamaMaxLoaded();
  try {
    const found = await classifyOllama(host, portOf(local.baseUrl));
    if (found?.kind === 'other') {
      logger.info('The local Ollama is not one the Dojo restarts; its loaded-model limit is left as it is', { program: found.path });
      return 'unmanaged';
    }
    if (found?.kind === 'own-serve') {
      if (readConfig(OWN_SERVE_LIMIT_KEY) === `${found.pid}:${limitFor(want)}`) { ownerConditionCleared('ollama-limit-failed'); return 'already'; }
      restarting ??= restartWhenQuiet(host, local).finally(() => { restarting = null; });
      return 'set';
    }
    const appRunning = !!found || (await host.appPids()).length > 0;
    if (!appRunning && !(await host.appInstalled())) return 'skipped';   // nothing serves and no app: tried again next start
    const raised = raisedLoadedLimit(await host.getenv(LIMIT_VAR), want);
    if (raised === null && !(appRunning && restartOwed())) {
      if (!appRunning) setConfig('ollama_limit_restart_owed', null);   // a stopped app reads the value when it starts
      ownerConditionCleared('ollama-limit-failed');
      return 'already';
    }
    if (raised !== null) {
      await host.setenv(LIMIT_VAR, raised);
      tellOncePerValue('ollama-limit-set', raised, OLLAMA_LIMIT_SET_WORDS);
      logger.info('Raised Ollama\'s loaded-model limit', { value: raised });
    }
    if (appRunning) {
      setConfig('ollama_limit_restart_owed', '1');   // owed until the restart has really happened (NB-5)
      restarting ??= restartWhenQuiet(host, local).finally(() => { restarting = null; });
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
  logger.warn('Could not raise Ollama\'s loaded-model limit (non-fatal)', { error: childFailureText(err) });
  if (tellOwnerOnce('ollama-limit-failed')) ownerCardFrame(OLLAMA_LIMIT_FAILED_WORDS, 'warning');
}

/** NB-1: deferred until nothing is in flight on the local Ollama; new calls wait while it runs. */
async function restartWhenQuiet(host: OllamaHost, local: { id: string; baseUrl: string }): Promise<void> {
  const endHold = await holdWhenQuiet(local.id);
  try {
    const found = await classifyOllama(host, portOf(local.baseUrl));
    if (found?.kind === 'own-serve') {
      await restartOwnServe(host, local.baseUrl, found.pid, STANDARD_TAGS.length);
    } else if (found?.kind === 'brew-service') {
      await setLaunchdLimit(host, STANDARD_TAGS.length);
      await restartBrewService(host, local.baseUrl);
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
