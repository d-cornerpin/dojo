// The Dojo's own working memory on its Ollama: the writer's largest-job KV cache plus the decision model's. This room
// is set aside: `num-ctx-calculator.ts` never sizes another local model into it and `agent/local-model-fit.ts`
// never offers it to an agent model.

import { getDb } from '../db/connection.js';
import { fetchModelArchInfo } from './num-ctx-calculator.js';
import { kvBytesPerTokenOf } from './kv-bytes.js';
import { STANDARD_WRITER_MODEL, STANDARD_DECISION_MODEL, standardModelRowId } from './local-standard.js';
import { utilityDial, utilityNumCtx, utilityOutputCap, MIN_UTILITY_NUM_CTX } from '../agent/utility-dial.js';
import { CHARS_PER_TOKEN } from '../memory/budget.js';
import { MEASURED_CHARS_PER_TOKEN } from './token-density.js';
import { standardTierModels } from '../router/tier-chain.js';

export async function writerJobWindowTokens(configuredNumCtx: number | null): Promise<number> {
  const { getLeafChunkTokens, getLeafTargetTokens } = await import('../memory/compaction.js');
  return utilityNumCtx({ inputChars: getLeafChunkTokens() * CHARS_PER_TOKEN, configuredNumCtx, charsPerToken: MEASURED_CHARS_PER_TOKEN,
    outputTokens: utilityOutputCap(utilityDial('memory_summarize')!, getLeafTargetTokens()) });
}

export const DECISION_WINDOW_KEY = 'decision_model_window';
/** `/v1/systemone` ignores `num_ctx`: the decision model's runner stays at its model file's own `-c 8192`. */
export const BUILTIN_DECISION_WINDOW = 8_192;

export function decisionTagWindow(): number | null {
  try {
    const v = Number((getDb().prepare("SELECT value FROM config WHERE key = 'decision_model_window'").get() as { value: string } | undefined)?.value);
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch { return null; }
}

export async function decisionWindowTokens(): Promise<number> {
  return decisionTagWindow() ?? BUILTIN_DECISION_WINDOW;
}

/**
 * Summaries assigned to the writer: an agent's fixed model, or a standard router tier while an agent is auto-routed.
 * A fallback is sized to the memory free when it runs (`memory/writer.ts`), never reserved.
 */
export function writerAssignedSummaries(): boolean {
  const writerId = standardModelRowId('writer');
  if (!writerId) return false;
  const db = getDb();
  if (db.prepare('SELECT 1 FROM agents WHERE model_id = ? LIMIT 1').get(writerId)) return true;
  return standardTierModels().includes(writerId)
    && !!db.prepare("SELECT 1 FROM agents WHERE model_id IS NULL OR model_id IN ('', 'auto', '__auto__') LIMIT 1").get();
}

/** The writer's reserved room in tokens: the summary window if summaries are assigned to it, else the smallest. */
export async function writerReservedWindowTokens(configuredNumCtx: number | null): Promise<number> {
  return writerAssignedSummaries() ? writerJobWindowTokens(configuredNumCtx) : MIN_UTILITY_NUM_CTX;
}

export async function writerWorkingBytes(baseUrl: string): Promise<number> {
  try {
    const row = getDb().prepare(`SELECT m.num_ctx_override AS o, m.num_ctx_recommended AS r FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE p.type = 'ollama' AND m.api_model_id = ? AND m.is_enabled = 1`).get(STANDARD_WRITER_MODEL.tag) as { o: number | null; r: number | null } | undefined;
    const arch = row ? await fetchModelArchInfo(baseUrl, STANDARD_WRITER_MODEL.tag) : null;
    const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
    return typeof kv === 'number' ? kv * await writerReservedWindowTokens(row?.o ?? row?.r ?? null) : 0;
  } catch { return 0; }
}

export async function dojoWorkingBytes(baseUrl: string): Promise<number> {
  let decision = 0;
  try {
    const arch = await fetchModelArchInfo(baseUrl, STANDARD_DECISION_MODEL.tag);
    const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
    if (typeof kv === 'number') decision = kv * await decisionWindowTokens();
  } catch { /* nothing set aside for what cannot be sized */ }
  return await writerWorkingBytes(baseUrl) + decision;
}
