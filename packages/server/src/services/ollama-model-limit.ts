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
// (`ollama_max_concurrent_models`, the agent models the lock lets load at once). The setup "start" fallback
// that runs `ollama serve` itself passes the same value (`gateway/routes/setup-deps.ts`).
//
// WHEN (fix round 3 ruling): at setup and at EVERY Dojo start — `launchctl setenv` does not survive a reboot.
// HOW: the Ollama app reads its environment from launchd (docs: "If Ollama is run as a macOS application,
// environment variables should be set using launchctl" and the app restarted). So: `launchctl setenv`, and the
// app is restarted ONCE when the value changed — never when it is already right. The owner is told on a card
// (the existing owner-notice system). A failure never fails setup or an update: it says so on the card.
// ════════════════════════════════════════════════════════════════════════════

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from '../logger.js';
import { getDb } from '../db/connection.js';
import { isTestRun } from '../home.js';
import { STANDARD_TAGS } from './local-standard.js';
import { getOllamaLock, getOllamaMaxConcurrent } from './ollama-lock.js';
import { ownerCardFrame } from './owner-card-frames.js';
import { tellOwnerOnce, ownerConditionCleared, OLLAMA_LIMIT_SET_WORDS, OLLAMA_LIMIT_FAILED_WORDS } from '../healer/owner-notices.js';

export { OLLAMA_LIMIT_SET_WORDS, OLLAMA_LIMIT_FAILED_WORDS };
const logger = createLogger('ollama-model-limit');
const VAR = 'OLLAMA_MAX_LOADED_MODELS';

export interface OllamaLimitDeps {
  getenv(name: string): Promise<string | null>;
  setenv(name: string, value: string): Promise<void>;
  appRunning(): Promise<boolean>;
  restartApp(): Promise<void>;
}

const run = promisify(execFile);
const REAL: OllamaLimitDeps = {
  getenv: async (name) => (await run('launchctl', ['getenv', name])).stdout.trim() || null,
  setenv: async (name, value) => { await run('launchctl', ['setenv', name, value]); },
  appRunning: async () => { try { await run('pgrep', ['-x', 'Ollama']); return true; } catch { return false; } },
  restartApp: async () => {
    await run('osascript', ['-e', 'quit app "Ollama"']);
    await run('open', ['-a', 'Ollama']);
  },
};

const toldValue = (): string | null =>
  (getDb().prepare("SELECT value FROM config WHERE key = 'ollama_limit_told'").get() as { value: string } | undefined)?.value ?? null;

/** The limit the Dojo needs: the embedder + the pair + the lock's agent slots (see the header). */
export function desiredOllamaMaxLoaded(): number {
  getOllamaLock().reloadConfig();
  return 1 + STANDARD_TAGS.length + getOllamaMaxConcurrent();
}

export async function ensureOllamaModelLimit(
  deps: OllamaLimitDeps = REAL, platform: NodeJS.Platform = process.platform,
): Promise<'already' | 'set' | 'failed' | 'skipped'> {
  if (platform !== 'darwin') return 'skipped';
  if (deps === REAL && isTestRun()) return 'skipped';   // the real launchctl and the real app are never touched by a test
  const want = String(desiredOllamaMaxLoaded());
  try {
    if ((await deps.getenv(VAR)) === want) return 'already';
    await deps.setenv(VAR, want);
    if (await deps.appRunning()) await deps.restartApp();   // ONCE: only because the value changed
    ownerConditionCleared('ollama-limit-failed');
    // Told ONCE per value (fix round 3): a reboot loses the variable and every start re-applies it, but the
    // owner hears about it only when the value is new to him, not at every boot.
    if (toldValue() !== want) {
      ownerConditionCleared('ollama-limit-set');
      if (tellOwnerOnce('ollama-limit-set')) ownerCardFrame(OLLAMA_LIMIT_SET_WORDS, 'warning');
      getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES ('ollama_limit_told', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(want);
    }
    logger.info('Raised Ollama\'s loaded-model limit', { value: want });
    return 'set';
  } catch (err) {
    logger.warn('Could not raise Ollama\'s loaded-model limit (non-fatal)', { error: err instanceof Error ? err.message : String(err) });
    if (tellOwnerOnce('ollama-limit-failed')) ownerCardFrame(OLLAMA_LIMIT_FAILED_WORDS, 'warning');
    return 'failed';
  }
}
