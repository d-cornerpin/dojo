// ════════════════════════════════════════════════════════════════════════════
// FIX W — THE DOJO UPGRADES THE OLLAMA IT RUNS ON, BY HOW IT WAS INSTALLED.
//
// The Dojo's own models declare the Ollama they need (`ollama-version.ts`, `local-standard.ts`). When the running
// Ollama is older, this installs the current one the way the Dojo installed it at setup (`brew install --cask
// ollama`, else the formula `brew install ollama`) and starts it again:
//   · app           only when Homebrew owns it (`brew list --cask ollama`): `brew reinstall --cask ollama` fetches the
//                   current app; the app is quit and opened again. An app installed any other way is the plain card;
//   · brew-service `brew upgrade ollama`; `brew services restart ollama`;
//   · own-serve     `brew upgrade ollama` (only when its program is a Homebrew formula's); the Dojo's `serve` is
//                   stopped and started again from the new program;
//   · other         nothing is touched: the caller shows the one card.
// The restart waits until nothing is in flight on the local Ollama and holds new calls meanwhile (`holdWhenQuiet`),
// like the model-limit restart. Every raw error goes to the log only; the words returned are the owner's.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { childFailureText } from '../update/child-failure.js';
import { type OllamaHost } from './ollama-host.js';
import { holdWhenQuiet } from './ollama-quiet.js';
import { ollamaAtLeast, readOllamaVersion } from './ollama-version.js';
import {
  BREW_FORMULA_PATH, classifyOllama, portOf, restartApp, restartBrewService, restartOwnServe, setLaunchdLimit,
} from './ollama-restart.js';

const logger = createLogger('ollama-upgrade');

export interface UpgradeResult {
  /** Ollama now meets the minimum. */
  ok: boolean;
  /** What happened, in plain words (the Settings card's progress line). */
  line: string;
}

export async function upgradeOllama(
  host: OllamaHost, local: { id: string; baseUrl: string }, need: string, residentCount: number,
): Promise<UpgradeResult> {
  const before = await readOllamaVersion(local.baseUrl);
  const tooOld = `Ollama ${before ?? '(unknown version)'} is older than the Dojo's models need (${need}).`;
  const cannot = (why: string): UpgradeResult => ({ ok: false, line: `${tooOld} ${why}` });
  const found = await classifyOllama(host, portOf(local.baseUrl));
  if (!found || found.kind === 'other' || (found.kind === 'own-serve' && !BREW_FORMULA_PATH.test(found.path))) {
    logger.info('Ollama is too old and was not installed in a way the Dojo can update', { have: before, need, kind: found?.kind ?? 'none' });
    return cannot("It was installed in a way the Dojo can't update.");
  }
  if (!await host.hasBrew()) return cannot('The Dojo needs Homebrew to update it, and Homebrew is not installed.');
  // An app Homebrew did not install (downloaded from ollama.com) is never replaced by the cask: no force over it.
  if (found.kind === 'app' && !await host.brewOwnsApp()) return cannot("It was installed in a way the Dojo can't update.");
  let did: string;
  try {
    if (found.kind === 'app') await host.brew(['reinstall', '--cask', 'ollama']);
    else await host.brew(['upgrade', 'ollama']);
    // The restart is the one step that interrupts local calls: it waits until none is in flight, then holds new ones.
    const endHold = await holdWhenQuiet(local.id);
    try {
      if (found.kind === 'app') { await setLaunchdLimit(host, residentCount); await restartApp(host, local.baseUrl, found.pid); did = 'the Ollama app'; }
      else if (found.kind === 'brew-service') { await setLaunchdLimit(host, residentCount); await restartBrewService(host, local.baseUrl); did = 'Ollama (installed with Homebrew)'; }
      else { await restartOwnServe(host, local.baseUrl, found.pid, residentCount); did = 'Ollama'; }
    } finally { endHold(); }
  } catch (err) {
    logger.warn('The Ollama upgrade did not complete', { kind: found.kind, error: childFailureText(err) });
    return cannot("The Dojo tried to update it, but that did not work.");
  }
  const after = await readOllamaVersion(local.baseUrl);
  if (!ollamaAtLeast(after, need)) {
    logger.warn('Ollama is still too old after the upgrade', { before, after, need, kind: found.kind });
    return cannot(`The Dojo updated it but it is still on ${after ?? 'an unknown version'}.`);
  }
  return { ok: true, line: `Updated ${did} from ${before ?? 'an older version'} to ${after} and restarted it.` };
}
