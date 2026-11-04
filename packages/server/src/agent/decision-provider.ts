// v3.5 B1 — WHO ANSWERS `decide()`: the local Ollama provider row and the Dojo's standard decision
// model, when it is installed. Local only (owner, 2026-10-19: "Local only."). Null otherwise, and
// then every caller's rule runs.
import { localOllamaProvider, standardModelRowId, STANDARD_DECISION_MODEL } from '../services/local-standard.js';
import { reconcileWhenOllamaAnswers } from '../services/ollama-pair-gate.js';
import { decisionTagWindow } from '../services/dojo-working-memory.js';

export interface DecisionProvider { baseUrl: string; model: string; providerId: string; modelId: string }

export function getDecisionProvider(): DecisionProvider | null {
  const provider = localOllamaProvider();
  const modelId = standardModelRowId('decision');
  // Round 6 (LOW-D): a local Ollama but no registered decision model: ask Ollama once (single-flight), so a model it lists is
  // registered by its answer even with no dashboard open; this judgment keeps its rule.
  if (provider && !modelId) void reconcileWhenOllamaAnswers(provider.baseUrl, false).catch(() => undefined);
  if (!provider || !modelId) return null;
  // t268 ruling 2: the derived tag that carries the window the Dojo reserves, once install has made it.
  const model = decisionTagWindow() === null ? STANDARD_DECISION_MODEL.tag : STANDARD_DECISION_MODEL.windowTag;
  return { baseUrl: provider.baseUrl, model, providerId: provider.id, modelId };
}
