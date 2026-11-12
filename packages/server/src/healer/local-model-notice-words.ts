// Owner-card words for local models: Ollama upkeep is the Dojo's job, so no card asks the owner to download,
// quit, restart or press Repair, and what the Dojo did by itself is a log line, never a card.

import { settingsPath } from '@dojo/shared';

export const STANDARD_MODELS_MISSING_WORDS = "Dojo: its own two local models could not be installed yet. The Dojo keeps trying "
  + `whenever Ollama is running; ${settingsPath('ollama')} shows what is missing and why.`;
export const uncheckedFitWords = (name: string): string =>
  `Dojo: ${name} was selected, but its memory fit could not be checked then (Ollama was not answering, or the model was not downloaded yet). `
  + "It will be checked when the model first loads, and refused then if it does not fit this box's memory.";
export const OLLAMA_LIMIT_FAILED_WORDS = "Dojo: it could not raise Ollama's limit on loaded models, so an agent's local model and the Dojo's "
  + 'own models may unload each other and answer more slowly. Everything else keeps working; the Dojo tries again at its next start.';
export const OLLAMA_TOO_OLD_WORDS = "Dojo: a local model needs a newer Ollama, and the Dojo could not update the Ollama on this Mac by itself. "
  + `${settingsPath('ollama')} shows why. Everything else keeps working, and the Dojo tries again at its next start.`;
export const OLLAMA_DOWN_WORDS = "Dojo: Ollama stopped while the Dojo was updating it and has not come back yet, so the local models are not answering. "
  + `The Dojo tries again at its next start. ${settingsPath('ollama')} shows why.`;
