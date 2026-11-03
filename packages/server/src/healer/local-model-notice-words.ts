// v3.5 — the owner-card words for the Dojo's own local models (split from `owner-notices.ts`, which keys the
// cards: `standard-models`, `fitunchecked:<model>`, `ollama-limit-set|failed`, `ollama-limit-manual:<n>`).

/** v3.5: the Dojo's own two local models could not be installed (condition `standard-models`; it ends
 *  when both are in). Platform trouble, so a dashboard card; the install is retried by itself. */
export const STANDARD_MODELS_MISSING_WORDS = "The Dojo's own two local models could not be installed yet. The Dojo keeps trying "
  + 'whenever Ollama is running; Settings → Dojo → Ollama (Local Models) shows what is missing and why.';
/** v3.5: a local model picked while Ollama could not size it (condition `fitunchecked:<model id>`; it ends
 *  when the fit is checked at the model's first load, `agent/local-model-fit.ts`). */
export const uncheckedFitWords = (name: string): string =>
  `${name} was selected, but its memory fit could not be checked then (Ollama was not answering, or the model was not downloaded yet). `
  + "It will be checked when the model first loads, and refused then if it does not fit this box's memory.";
/** v3.5 (owner decision 2026-10-24): the Dojo set Ollama's loaded-model limit on the Mac, or could not. */
export const OLLAMA_LIMIT_SET_WORDS = "The Dojo raised Ollama's limit on loaded models so its own two models, the embedder and an agent's "
  + 'local model can stay loaded together. The Ollama app picks it up when it starts; if it is running, the Dojo restarts it once, '
  + 'when no local model is answering and no download is running.';
export const OLLAMA_LIMIT_FAILED_WORDS = "The Dojo could not raise Ollama's limit on loaded models, so an agent's local model and the Dojo's "
  + 'own models may unload each other and answer more slowly. Everything else keeps working; the Dojo tries again at its next start.';
/** Fix round 4 (NB-2): this box's Ollama is not the Ollama app, so the Dojo changes nothing (condition `ollama-limit-manual:<n>`). */
export const ollamaLimitManualWords = (n: number): string =>
  "This box's Ollama is not run by the Ollama app, so the Dojo did not change it. For the Dojo's own two models, the embedder "
  + `and an agent's local model to stay loaded together, start Ollama with OLLAMA_MAX_LOADED_MODELS=${n} (nothing is needed if it already has that or more).`;
