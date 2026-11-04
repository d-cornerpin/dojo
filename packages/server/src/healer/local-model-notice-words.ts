// v3.5 — the owner-card words for the Dojo's own local models (split from `owner-notices.ts`, which keys the
// cards: `standard-models`, `fitunchecked:<model>`, `ollama-limit-failed`, `ollama-too-old`, `ollama-down`). Owner ruling OR-UPKEEP-AUTOMATIC:
// Ollama's upkeep is the Dojo's own job, so no card asks him to download, quit or restart anything, and what the Dojo did
// by itself (the limit raised, Ollama updated) is a log line, never a card.

import { settingsPath } from '@dojo/shared';

/** v3.5: the Dojo's own two local models could not be installed (condition `standard-models`; it ends
 *  when both are in). Platform trouble, so a dashboard card; the install is retried by itself. */
export const STANDARD_MODELS_MISSING_WORDS = "Dojo: its own two local models could not be installed yet. The Dojo keeps trying "
  + `whenever Ollama is running; ${settingsPath('ollama')} shows what is missing and why.`;
/** v3.5: a local model picked while Ollama could not size it (condition `fitunchecked:<model id>`; it ends
 *  when the fit is checked at the model's first load, `agent/local-model-fit.ts`). */
export const uncheckedFitWords = (name: string): string =>
  `Dojo: ${name} was selected, but its memory fit could not be checked then (Ollama was not answering, or the model was not downloaded yet). `
  + "It will be checked when the model first loads, and refused then if it does not fit this box's memory.";
/** v3.5 (owner decision 2026-10-24): the Dojo could not set Ollama's loaded-model limit on the Mac. */
export const OLLAMA_LIMIT_FAILED_WORDS = "Dojo: it could not raise Ollama's limit on loaded models, so an agent's local model and the Dojo's "
  + 'own models may unload each other and answer more slowly. Everything else keeps working; the Dojo tries again at its next start.';
/** Fix W: the Dojo's own models need a newer Ollama than this box runs and the Dojo could not update it itself, in one of the
 *  few cases it cannot fix (another user's or the system's Ollama, no Homebrew); condition `ollama-too-old`, it ends when
 *  Ollama is new enough. The reason is the Settings line. Shown once, through the existing cards. */
export const OLLAMA_TOO_OLD_WORDS = "Dojo: its own local models need a newer Ollama, and the Dojo could not update the Ollama on this Mac by itself. "
  + `${settingsPath('ollama')} shows why. Everything else keeps working, and the Dojo tries again at its next start or when you press Repair there.`;
/** Fix W: the Dojo stopped Ollama to start the updated one, and it did not come back (condition `ollama-down`; it ends when the
 *  Dojo's upkeep has Ollama answering again). */
export const OLLAMA_DOWN_WORDS = "Dojo: Ollama stopped while the Dojo was updating it and has not come back yet, so the local models are not answering. "
  + `The Dojo tries again at its next start or when you press Repair in ${settingsPath('ollama')}.`;
