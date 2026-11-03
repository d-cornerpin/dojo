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
import { upgradeOllama, type UpgradeResult } from './ollama-upgrade.js';
import { inUpkeep } from './ollama-restart.js';
import { isUnknownBuild, ollamaAtLeast, readOllamaVersion, requiredOllamaVersion } from './ollama-version.js';
import { OLLAMA_TOO_OLD_WORDS, OLLAMA_RESTART_NEEDED_WORDS, tellOwnerOnce, ownerConditionCleared } from '../healer/owner-notices.js';
import { ownerCardFrame } from './owner-card-frames.js';

const logger = createLogger('ollama-pair-gate');

/** The Ollama version the Dojo could not improve, while it still runs; null when nothing is held. */
let heldAt: string | null = null;
let line: string | null = null;

/** What the Dojo did about Ollama's version in the last install, for the Settings card's progress lines. */
export const pairOllamaLines = (): string[] => (line ? [line] : []);
/** The Settings note while a too-old Ollama blocks the pair; null when nothing does. */
export const pairHeldNote = (): string | null => (heldAt === null ? null : `${line ?? ''} Download the latest from ollama.com, then press Repair.`.trim());
export const pairHeld = (): boolean => heldAt !== null;
/** Both models are in: nothing is held and the card (if it stands) ends. */
export function pairModelsAllIn(): void { heldAt = null; line = null; cardsEnd(); }
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

type Models = ReadonlyArray<{ tag: string; minOllama: string | null }>;
/** Read when used, never at load: this module sits in an import cycle with the owner-notices words (a module-scope read was a dead zone). */
const TOLD = (): { [k in 'update' | 'restart']: readonly [string, string] } => ({ update: ['ollama-too-old', OLLAMA_TOO_OLD_WORDS], restart: ['ollama-restart-needed', OLLAMA_RESTART_NEEDED_WORDS] });
const cardsEnd = (): void => { for (const [key] of Object.values(TOLD())) ownerConditionCleared(key); };

/** The upgrade ran: fixed (nothing is held), judged for nothing (no listener now: nothing is held or told), or failed (held, ONE card). */
async function afterUpgrade(done: UpgradeResult, baseUrl: string, have: string | null): Promise<boolean> {
  line = done.line;
  if (done.ok) { heldAt = null; cardsEnd(); return true; }
  if (done.transient) { logger.info('Ollama was not answering when the upgrade looked; nothing is held', { line: done.line }); return false; }
  heldAt = (await readOllamaVersion(baseUrl)) ?? have ?? 'unknown';
  const [key, words] = TOLD()[done.card ?? 'update'];
  for (const [other] of Object.values(TOLD())) if (other !== key) ownerConditionCleared(other);
  logger.warn('Ollama is too old for the Dojo\'s models and was not updated', { have, line: done.line });
  if (tellOwnerOnce(key)) ownerCardFrame(words, 'warning');
  return false;
}

/**
 * Is the local Ollama new enough for the models of `models` that are not installed yet? True also when it does not
 * answer (the install reports that itself), does not say its version, or is a source build (0.0.0: its number says nothing)
 * — the pull goes ahead and the registry's own refusal is handled by `pullRefusedForVersion`. False: too old and the
 * Dojo could not fix it — the card is told, the models that need the newer Ollama are not pulled. Runs in the Ollama
 * upkeep queue (`inUpkeep`), after any restart already under way.
 */
export function ollamaReadyForPair(
  provider: { id: string; baseUrl: string } | null, models: Models, host: OllamaHost | null = getOllamaHost(),
): Promise<boolean> {
  if (!provider) return Promise.resolve(true);
  return inUpkeep(async () => {
    const installed = await installedNames(provider.baseUrl);
    if (!installed) return true;
    const need = requiredOllamaVersion(models.filter((m) => !installed.includes(m.tag)));
    const have = need ? await readOllamaVersion(provider.baseUrl) : null;
    if (need && isUnknownBuild(have)) logger.info('Ollama reports a development build version; the pull decides', { have });
    if (!need || have === null || isUnknownBuild(have) || ollamaAtLeast(have, need)) { heldAt = null; line = null; cardsEnd(); return true; }
    const done = host ? await upgradeOllama(host, provider, need, models.length) : { ok: false, card: 'update' as const, line: `Ollama ${have} is older than the Dojo's models need (${need}).` };
    return (await afterUpgrade(done, provider.baseUrl, have)) || !!done.transient;
  });
}

/** The registry refused a pull as "needs a newer Ollama": the authoritative signal, whatever the version check said (it was
 *  unreadable, or a minimum is not declared or was too low). The same upgrade runs; true = Ollama was updated, pull again.
 *  Only a failed upgrade holds the pull and tells the card. */
export function pullRefusedForVersion(
  provider: { id: string; baseUrl: string }, models: Models, error: string, host: OllamaHost | null = getOllamaHost(),
): Promise<boolean> {
  logger.warn('The registry refused a model: Ollama is too old', { error });
  return inUpkeep(async () => {
    const have = await readOllamaVersion(provider.baseUrl);
    const declared = requiredOllamaVersion(models);
    const need = declared && !ollamaAtLeast(have, declared) ? declared : null;   // declared and not met, else "newer than now"
    const done = host ? await upgradeOllama(host, provider, need, models.length) : { ok: false, card: 'update' as const, line: 'Ollama is too old for this model.' };
    return afterUpgrade(done, provider.baseUrl, have);
  });
}
