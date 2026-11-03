// v3.5 — the owner-card words for the Dojo's own local models (split from `owner-notices.ts`, which keys the
// cards: `standard-models`, `fitunchecked:<model>`, `ollama-limit-set|failed`, `ollama-too-old`, `ollama-restart-needed`, `ollama-down`).

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
/** v3.5 (owner decision 2026-10-24): the Dojo set Ollama's loaded-model limit on the Mac, or could not. */
export const OLLAMA_LIMIT_SET_WORDS = "Dojo: it raised Ollama's limit on loaded models so its own two models, the embedder and an agent's "
  + 'local model can stay loaded together. Ollama picks it up when it starts; if it is running, the Dojo restarts it once, '
  + 'when no local model is answering and no download is running.';
export const OLLAMA_LIMIT_FAILED_WORDS = "Dojo: it could not raise Ollama's limit on loaded models, so an agent's local model and the Dojo's "
  + 'own models may unload each other and answer more slowly. Everything else keeps working; the Dojo tries again at its next start.';
/** Fix W: the Dojo's own models need a newer Ollama than this box runs and the Dojo could not update it itself
 *  (condition `ollama-too-old`; it ends when Ollama is new enough). Shown once, through the existing cards. */
export const OLLAMA_TOO_OLD_WORDS = "Dojo: its own models need a newer Ollama, and the Dojo could not update the one on this Mac itself. "
  + 'Update Ollama (download the latest from ollama.com, or run "brew upgrade ollama" if you installed it with Homebrew), '
  + `then press Repair in ${settingsPath('ollama')}.`;
/** Fix W: the Dojo updated a Homebrew Ollama it did not start, but the copy running now was started another way, so the Dojo
 *  cannot restart it (condition `ollama-restart-needed`). Never points a Homebrew box at the app download. */
export const OLLAMA_RESTART_NEEDED_WORDS = "Dojo: it updated Ollama, but the copy running now was started another way, so the Dojo can't restart it. "
  + `Quit that Ollama and start it again, then press Repair in ${settingsPath('ollama')}.`;
/** Fix W: the Dojo stopped the Ollama server it had started, to start it from the updated program, and it did not come back
 *  (condition `ollama-down`; it ends when Ollama answers). */
export const OLLAMA_DOWN_WORDS = "Dojo: Ollama stopped while the Dojo was restarting it and did not come back. "
  + `Open the Ollama app or start Ollama again, then press Repair in ${settingsPath('ollama')}.`;
