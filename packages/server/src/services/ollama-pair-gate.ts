// ════════════════════════════════════════════════════════════════════════════
// FIX W — OLLAMA MUST BE NEW ENOUGH BEFORE THE DOJO'S OWN MODELS ARE PULLED.
//
// `local-standard.ts` asks this before every install of the pair — setup, the first boot of an update, the Repair
// button, and the retry when Ollama answers with a model missing — so all four run the same upkeep-then-pull:
//   · nothing answers → what is installed is started (`ollama-upgrade.ts ensureOllamaCurrent`, the one upkeep routine);
//   · the running Ollama's version (`/api/version`) against the minimum the missing models declare: the same routine
//     updates and restarts whatever Ollama runs, whoever started it, and what it did is a plain progress line;
//   · cannot be updated → the routine tells ONE owner card, and the pull is NOT retried at every health check: the hold
//     below ends only when Ollama's version changes, or when the owner presses Repair (`releasePairHold`).
// The registry's own raw refusal ("pull model manifest: 412 …") stays in the log; no owner text carries it, and no text
// tells the owner to download or restart anything (owner ruling OR-UPKEEP-AUTOMATIC).
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { type OllamaHost, getOllamaHost } from './ollama-host.js';
import { ensureOllamaCurrent, tellOllamaTooOld, type UpgradeResult } from './ollama-upgrade.js';
import { inUpkeep } from './ollama-restart.js';
import { isUnknownBuild, ollamaAtLeast, readOllamaVersion, requiredOllamaVersion } from './ollama-version.js';
import { ownerConditionCleared, ownerToldOf } from '../healer/owner-notices.js';

const logger = createLogger('ollama-pair-gate');

/** The Ollama version the Dojo could not improve, while it still runs; null when nothing is held. */
let heldAt: string | null = null;
let line: string | null = null;

/** What the Dojo did about Ollama's version in the last install, for the Settings card's progress lines. */
export const pairOllamaLines = (): string[] => (line ? [line] : []);
/** The Settings note while an Ollama the Dojo could not update blocks the pair (what it tried and why it could not); null when nothing does. */
export const pairHeldNote = (): string | null => (heldAt === null ? null : line);
/** Held, or the upkeep's one card stands (it outlives a restart; review L1: never a second card beside it). */
export const pairHeld = (): boolean => heldAt !== null || ownerToldOf('ollama-too-old') || ownerToldOf('ollama-down');
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
const cardsEnd = (): void => { ownerConditionCleared('ollama-too-old'); ownerConditionCleared('ollama-down'); };
/** A test run with no fake host: nothing on the Mac can be run, so a too-old Ollama is the one card. */
const noHost = (line: string): UpgradeResult => { tellOllamaTooOld(); return { ok: false, line }; };

/** The upkeep ran: fixed (nothing is held), judged for nothing (nothing answers: nothing is held), or could not (held; the routine told the card). */
async function afterUpgrade(done: UpgradeResult, baseUrl: string, have: string | null): Promise<boolean> {
  line = done.line ?? null;
  if (done.ok) { heldAt = null; return true; }
  if (done.starting) { heldAt = 'starting'; return false; }   // held until it first answers (any version differs from this): no card meanwhile
  if (done.transient) { logger.info('Ollama was not answering when the upkeep looked; nothing is held', { line: done.line }); return false; }
  heldAt = (await readOllamaVersion(baseUrl)) ?? have ?? 'unknown';
  logger.warn('Ollama is too old for the Dojo\'s models and was not updated', { have, line: done.line });
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
    let installed = await installedNames(provider.baseUrl);
    if (!installed && host) { await ensureOllamaCurrent(host, provider, null, models.length); installed = await installedNames(provider.baseUrl); }
    if (!installed) return true;
    const need = requiredOllamaVersion(models.filter((m) => !installed.includes(m.tag)));
    const have = need ? await readOllamaVersion(provider.baseUrl) : null;
    if (need && isUnknownBuild(have)) logger.info('Ollama reports a development build version; the pull decides', { have });
    if (!host && (!need || have === null || isUnknownBuild(have) || ollamaAtLeast(have, need))) { heldAt = null; line = null; cardsEnd(); return true; }
    const done = host ? await ensureOllamaCurrent(host, provider, need, models.length) : noHost(`Ollama ${have} is older than the Dojo's models need (${need}).`);
    return (await afterUpgrade(done, provider.baseUrl, have)) || !!done.transient;
  });
}

/** The owner's own pull (setup's model list: an agent's model) was refused as needing a newer Ollama: the same upkeep as
 *  Repair makes Ollama current, then the caller pulls again (owner ruling OR-UPKEEP-AUTOMATIC: never "download it yourself").
 *  Nothing of the pair is held; when it could not, the routine told its one card and its line says why. */
export function ollamaCurrentForModel(
  provider: { id: string; baseUrl: string } | null, residentCount: number, host: OllamaHost | null = getOllamaHost(),
): Promise<UpgradeResult> {
  if (!host || !provider) return Promise.resolve(noHost('Ollama is too old for this model.'));
  return inUpkeep(() => ensureOllamaCurrent(host, provider, 'newer', residentCount));
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
    const need = declared && have !== null && !ollamaAtLeast(have, declared) ? declared : 'newer';   // declared and not met, else "newer than now"; unreadable: newer
    const done = host ? await ensureOllamaCurrent(host, provider, need, models.length) : noHost('Ollama is too old for this model.');
    return afterUpgrade(done, provider.baseUrl, have);
  });
}
