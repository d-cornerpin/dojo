// WHO ANSWERS `decide()`: the local Ollama provider row and the Dojo's standard decision model, when it is
// installed. Local only. Null otherwise, and then every caller's rule runs.
import { localOllamaProvider, standardModelRowId, STANDARD_DECISION_MODEL } from '../services/local-standard.js';
import { checkOllamaHealth } from '../services/ollama.js';
import { decisionTagWindow } from '../services/dojo-working-memory.js';

let asking: Promise<boolean> | null = null;

export interface DecisionProvider { baseUrl: string; model: string; providerId: string; modelId: string }

export function getDecisionProvider(): DecisionProvider | null {
  const provider = localOllamaProvider();
  const modelId = standardModelRowId('decision');
  // A local Ollama but no registered decision model: one health check at a time (its answer runs the upkeep's door), so a
  // model Ollama lists is registered even with no dashboard open; this judgment keeps its rule.
  if (provider && !modelId) asking ??= checkOllamaHealth(provider.baseUrl).catch(() => false).finally(() => { asking = null; });
  if (!provider || !modelId) return null;
  // t268 ruling 2: the derived tag that carries the window the Dojo reserves, once install has made it.
  const model = decisionTagWindow() === null ? STANDARD_DECISION_MODEL.tag : STANDARD_DECISION_MODEL.windowTag;
  return { baseUrl: provider.baseUrl, model, providerId: provider.id, modelId };
}
