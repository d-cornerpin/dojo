// ════════════════════════════════════════════════════════════════════════════
// FIX W — OLLAMA MUST BE NEW ENOUGH BEFORE THE DOJO'S OWN MODELS ARE PULLED.
//
// `local-standard.ts` asks this before every install of the pair — setup, the first boot of an update, the Repair
// button, and the retry when Ollama answers with a model missing — so all four run the same upgrade-then-pull:
//   · the running Ollama's version (`/api/version`) against the minimum the missing models declare;
//   · too old → `ollama-upgrade.ts` upgrades it by how it was installed; what it did is a plain progress line;
//   · cannot be upgraded → ONE owner card (condition `ollama-too-old`, the existing notification path), and the
//     pull is NOT retried at every health check: the hold below ends only when Ollama's version changes, or when
//     the owner presses Repair (`releasePairHold`).
// The registry's own raw refusal ("pull model manifest: 412 …") stays in the log; no owner text carries it.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { type OllamaHost, getOllamaHost } from './ollama-host.js';
import { upgradeOllama } from './ollama-upgrade.js';
import { ollamaAtLeast, readOllamaVersion, requiredOllamaVersion } from './ollama-version.js';
import { OLLAMA_TOO_OLD_WORDS, tellOwnerOnce, ownerConditionCleared } from '../healer/owner-notices.js';
import { ownerCardFrame } from './owner-card-frames.js';

const logger = createLogger('ollama-pair-gate');
const CONDITION = 'ollama-too-old';

/** The Ollama version the Dojo could not improve, while it still runs; null when nothing is held. */
let heldAt: string | null = null;
let line: string | null = null;

/** What the Dojo did about Ollama's version in the last install, for the Settings card's progress lines. */
export const pairOllamaLines = (): string[] => (line ? [line] : []);
/** The Settings note while a too-old Ollama blocks the pair; null when nothing does. */
export const pairHeldNote = (): string | null => (heldAt === null ? null : `${line ?? ''} Download the latest from ollama.com, then press Repair.`.trim());
export const pairHeld = (): boolean => heldAt !== null;
/** Both models are in: nothing is held and the card (if it stands) ends. */
export function pairModelsAllIn(): void { heldAt = null; line = null; ownerConditionCleared(CONDITION); }
/** The owner pressed Repair: the version refusal is looked at again. */
export function releasePairHold(): void { heldAt = null; }

/** A health check found a model missing: may the install start? While held, only a changed Ollama version lets it. */
export function retryMayStart(baseUrl: string, start: () => void): boolean {
  if (heldAt === null) return true;
  void readOllamaVersion(baseUrl).then((v) => { if (v !== null && v !== heldAt) { heldAt = null; start(); } });
  return false;
}

async function installedNames(baseUrl: string): Promise<string[] | null> {
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(5000) });
    return resp.ok ? ((await resp.json()) as { models?: Array<{ name: string }> }).models?.map((m) => m.name) ?? [] : null;
  } catch { return null; }
}

/**
 * Is the local Ollama new enough for the models of `models` that are not installed yet? True also when it does not
 * answer (the install reports that itself) or does not say its version (the pull goes ahead; a refusal is held below).
 * False: too old and the Dojo could not fix it — the card is told, the models that need the newer Ollama are not pulled.
 */
export async function ollamaReadyForPair(
  provider: { id: string; baseUrl: string } | null, models: ReadonlyArray<{ tag: string; minOllama: string | null }>,
  host: OllamaHost | null = getOllamaHost(),
): Promise<boolean> {
  if (!provider) return true;
  const installed = await installedNames(provider.baseUrl);
  if (!installed) return true;
  const need = requiredOllamaVersion(models.filter((m) => !installed.includes(m.tag)));
  const have = need ? await readOllamaVersion(provider.baseUrl) : null;
  if (!need || have === null || ollamaAtLeast(have, need)) { heldAt = null; line = null; ownerConditionCleared(CONDITION); return true; }
  const done = host ? await upgradeOllama(host, provider, need, models.length) : { ok: false, line: `Ollama ${have} is older than the Dojo's models need (${need}).` };
  line = done.line;
  if (done.ok) { heldAt = null; ownerConditionCleared(CONDITION); return true; }
  heldAt = (await readOllamaVersion(provider.baseUrl)) ?? have;
  logger.warn('Ollama is too old for the Dojo\'s models and was not updated', { have, need });
  if (tellOwnerOnce(CONDITION)) ownerCardFrame(OLLAMA_TOO_OLD_WORDS, 'warning');
  return false;
}

/** A pull was refused by the registry as "needs a newer Ollama" though the version check let it through (the version
 *  was unreadable, or a minimum is not declared): held like a failed upgrade, so it is not pulled again at every health check. */
export async function pullRefusedForVersion(baseUrl: string, error: string): Promise<void> {
  logger.warn('The registry refused a model: Ollama is too old', { error });
  heldAt = (await readOllamaVersion(baseUrl)) ?? 'unknown';
  line = 'The Dojo could not download this model because this Ollama is too old for it.';
  if (tellOwnerOnce(CONDITION)) ownerCardFrame(OLLAMA_TOO_OLD_WORDS, 'warning');
}
