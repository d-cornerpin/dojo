// v3.5 B1 — WHO ANSWERS `decide()`: the local Ollama provider row and the Dojo's standard decision
// model, when it is installed. Local only (owner, 2026-10-19: "Local only."). Null otherwise, and
// then every caller's rule runs.
import { localOllamaProvider, standardModelRowId, STANDARD_DECISION_MODEL } from '../services/local-standard.js';

export interface DecisionProvider { baseUrl: string; model: string; providerId: string; modelId: string }

export function getDecisionProvider(): DecisionProvider | null {
  const provider = localOllamaProvider();
  const modelId = standardModelRowId('decision');
  if (!provider || !modelId) return null;
  return { baseUrl: provider.baseUrl, model: STANDARD_DECISION_MODEL.tag, providerId: provider.id, modelId };
}
