// The owner-card words for the Dojo's own local models. The Ollama upkeep raises one notice key (`ollama`) in the sentence
// that fits; a model picked while it could not be sized is `fitunchecked:<model>`. Ollama's upkeep is the Dojo's own job,
// so no card asks him to download, quit or restart anything, and what the Dojo did by itself is a log line, never a card.

import { settingsPath } from '@dojo/shared';

/** The Dojo's own two local models could not be installed; the upkeep retries by itself. */
export const STANDARD_MODELS_MISSING_WORDS = "Dojo: its own two local models could not be installed yet. The Dojo keeps trying "
  + `whenever Ollama is running; ${settingsPath('ollama')} shows what is missing and why.`;
/** A local model picked while Ollama could not size it (it ends when the fit is checked at the model's first load). */
export const uncheckedFitWords = (name: string): string =>
  `Dojo: ${name} was selected, but its memory fit could not be checked then (Ollama was not answering, or the model was not downloaded yet). `
  + "It will be checked when the model first loads, and refused then if it does not fit this box's memory.";
/** The Dojo could not raise Ollama's loaded-model limit on the Mac. */
export const OLLAMA_LIMIT_FAILED_WORDS = "Dojo: it could not raise Ollama's limit on loaded models, so an agent's local model and the Dojo's "
  + 'own models may unload each other and answer more slowly. Everything else keeps working; the Dojo tries again at its next start.';
/** The Dojo's own models need a newer Ollama and the Dojo could not update it (another user's or the system's Ollama, no
 *  Homebrew): the one action card, standing while the version is held. The reason is the Settings line. No card names a
 *  Repair button: the Dojo repairs Ollama itself. */
export const OLLAMA_TOO_OLD_WORDS = "Dojo: a local model needs a newer Ollama, and the Dojo could not update the Ollama on this Mac by itself. "
  + `${settingsPath('ollama')} shows why. Everything else keeps working, and the Dojo tries again at its next start.`;
/** The Dojo stopped Ollama to start the updated one, and it did not come back. */
export const OLLAMA_DOWN_WORDS = "Dojo: Ollama stopped while the Dojo was updating it and has not come back yet, so the local models are not answering. "
  + `The Dojo tries again at its next start. ${settingsPath('ollama')} shows why.`;
