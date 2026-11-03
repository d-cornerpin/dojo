// ════════════════════════════════════════════════════════════════════════════
// FIX W — THE DOJO UPGRADES THE OLLAMA IT RUNS ON, BY HOW IT WAS INSTALLED.
//
// The Dojo's own models declare the Ollama they need (`ollama-version.ts`, `local-standard.ts`). When the running
// Ollama is older, this installs the current one the way the Dojo installed it at setup (Homebrew) and starts it again:
//   · app           only when Homebrew owns it (`brew list --cask`, under whichever token it holds: `ollama-app`, or `ollama`
//                   before the rename): inside the quiet hold the Dojo quits the app (its own TERM), `brew upgrade --cask <token>`
//                   fetches the current app (never `reinstall`), and the app is opened again. An app installed any other way
//                   is never replaced: the plain card;
//   · brew-service  `brew upgrade ollama`; `brew services restart ollama`;
//   · own-serve     `brew upgrade ollama`; the Dojo's `serve` is stopped and started again from the new program;
//   · formula       a Homebrew program the Dojo did not start: `brew upgrade ollama` is safe, the restart is not the Dojo's to do,
//                   so the owner is told to restart it (never to download the app);
//   · other         nothing is touched: the caller shows the one card.
// The restart waits until nothing is in flight on the local Ollama and holds new calls meanwhile (`holdWhenQuiet`), like the
// model-limit restart; the two never run at once (`inUpkeep`). Every raw error goes to the log only; the words are the owner's.
// A listener that is not there at this moment is not a verdict (`transient`): nothing is held or told for it.
// ════════════════════════════════════════════════════════════════════════════

import { createLogger } from '../logger.js';
import { childFailureText } from '../update/child-failure.js';
import { type OllamaHost } from './ollama-host.js';
import { holdWhenQuiet } from './ollama-quiet.js';
import { ollamaAtLeast, readOllamaVersion } from './ollama-version.js';
import {
  BREW_FORMULA_PATH, classifyOllama, portOf, restartBrewService, restartOwnServe, setConfig, setLaunchdLimit, startApp, stopApp,
} from './ollama-restart.js';

const logger = createLogger('ollama-upgrade');

export interface UpgradeResult {
  /** Ollama now meets the need. */
  ok: boolean;
  /** Nothing could be judged now (no listener): not a failure to hold or to tell the owner about. */
  transient?: boolean;
  /** Which card the owner gets when it failed: update it himself, or restart the copy the Dojo did not start. */
  card?: 'update' | 'restart';
  /** What happened, in plain words (the Settings card's progress line). */
  line: string;
}

/** `need` is the declared minimum, or null when the registry refused a model and named none: then "newer than now" is the need. */
export async function upgradeOllama(
  host: OllamaHost, local: { id: string; baseUrl: string }, need: string | null, residentCount: number,
): Promise<UpgradeResult> {
  const before = await readOllamaVersion(local.baseUrl);
  const tooOld = `Ollama ${before ?? '(unknown version)'} is older than the Dojo's models need${need ? ` (${need})` : ''}.`;
  const cannot = (why: string, card: 'update' | 'restart' = 'update'): UpgradeResult => ({ ok: false, card, line: `${tooOld} ${why}` });
  const found = await classifyOllama(host, portOf(local.baseUrl));
  if (!found) return { ok: false, transient: true, line: `${tooOld} Ollama was not answering at that moment.` };
  const homebrewFormula = found.kind === 'brew-service' || found.kind === 'formula' || (found.kind === 'own-serve' && BREW_FORMULA_PATH.test(found.path));
  if (found.kind === 'other' || (found.kind === 'own-serve' && !homebrewFormula)) {
    logger.info('Ollama is too old and was not installed in a way the Dojo can update', { have: before, need, kind: found.kind });
    return cannot("It was installed in a way the Dojo can't update.");
  }
  if (!await host.hasBrew()) return cannot('The Dojo needs Homebrew to update it, and Homebrew is not installed.');
  // An app Homebrew did not install (downloaded from ollama.com) is never replaced by the cask: no force over it.
  const token = found.kind === 'app' ? await host.brewCaskToken() : null;
  if (found.kind === 'app' && token === null) return cannot("It was installed in a way the Dojo can't update.");
  let did: string;
  try {
    if (found.kind === 'app') {
      // Nothing may be in flight, and new calls wait, while the app is down. The Dojo quits the app itself (its own TERM path, no
      // AppleScript: a cask's uninstall quits with osascript, which raises the macOS Automation prompt), and only then runs
      // `brew upgrade --cask <token>` — never `reinstall`: upgrade carries the old app's Gatekeeper approval over, and naming the
      // cask makes it greedy, so a cask that updates itself (`auto_updates`) is not skipped. Then the app is opened again.
      const endHold = await holdWhenQuiet(local.id);
      try {
        await stopApp(host, found.pid);
        try { await host.brew(['upgrade', '--cask', token as string]); await setLaunchdLimit(host, residentCount); }
        finally { await startApp(host, local.baseUrl); }   // the app is opened again whether brew worked or not
      } finally { endHold(); }
      setConfig('ollama_limit_restart_owed', null);   // the restart carried the limit
      did = 'the Ollama app';
    } else {
      await host.brew(['upgrade', 'ollama']);
      if (found.kind === 'formula') {
        // The copy running now was not started by the Dojo: it keeps running the old program until its owner restarts it.
        return cannot('The Dojo updated the Homebrew copy, but the one running now was started another way.', 'restart');
      }
      const endHold = await holdWhenQuiet(local.id);   // the restart is the one step that interrupts local calls
      try {
        if (found.kind === 'brew-service') { await setLaunchdLimit(host, residentCount); await restartBrewService(host, local.baseUrl); setConfig('ollama_limit_restart_owed', null); did = 'Ollama (installed with Homebrew)'; }
        else { await restartOwnServe(host, local.baseUrl, found.pid, residentCount); did = 'Ollama'; }
      } finally { endHold(); }
    }
  } catch (err) {
    logger.warn('The Ollama upgrade did not complete', { kind: found.kind, error: childFailureText(err) });
    return cannot('The Dojo tried to update it, but that did not work.');
  }
  const after = await readOllamaVersion(local.baseUrl);
  if (need ? !ollamaAtLeast(after, need) : after === null || after === before) {
    logger.warn('Ollama is still too old after the upgrade', { before, after, need, kind: found.kind });
    return cannot(after === before ? 'Homebrew has no newer Ollama to install.' : `The Dojo updated it but it is still on ${after ?? 'an unknown version'}.`);
  }
  return { ok: true, line: `Updated ${did} from ${before ?? 'an older version'} to ${after} and restarted it.` };
}
