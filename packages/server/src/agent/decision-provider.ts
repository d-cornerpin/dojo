// Local Ollama only; null = the caller's rule. Ollama up but no decision model: one health check registers one.
import { localOllamaProvider, standardModelRowId, STANDARD_DECISION_MODEL } from '../services/local-standard.js';
import { checkOllamaHealth } from '../services/ollama.js';
import { decisionTagWindow } from '../services/dojo-working-memory.js';

let asking: Promise<boolean> | null = null;

export interface DecisionProvider { baseUrl: string; model: string; providerId: string; modelId: string }

export function getDecisionProvider(): DecisionProvider | null {
  const provider = localOllamaProvider();
  const modelId = standardModelRowId('decision');
  if (provider && !modelId) asking ??= checkOllamaHealth(provider.baseUrl).catch(() => false).finally(() => { asking = null; });
  if (!provider || !modelId) return null;
  // Once install has derived it, the tag that carries the Dojo's reserved decision window answers.
  const model = decisionTagWindow() === null ? STANDARD_DECISION_MODEL.tag : STANDARD_DECISION_MODEL.windowTag;
  return { baseUrl: provider.baseUrl, model, providerId: provider.id, modelId };
}
