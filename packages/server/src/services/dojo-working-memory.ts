// ════════════════════════════════════════════════════════════════════════════
// v3.5 — THE DOJO'S OWN WORKING MEMORY ON ITS OLLAMA (fix rounds 1-2, orchestrator rulings).
//
// The KV cache the Dojo's writer holds for its largest job (a leaf summary: its chunk in, its summary
// out), and the decision model's for the summary check that reads that same text. This room is set aside:
// the window recommendation (`num-ctx-calculator.ts`) never sizes another local model into it, and the
// memory-fit gate (`agent/local-model-fit.ts`) never offers it to an agent model.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { fetchModelArchInfo } from './num-ctx-calculator.js';
import { kvBytesPerTokenOf } from './kv-bytes.js';
import { STANDARD_WRITER_MODEL, STANDARD_DECISION_MODEL } from './local-standard.js';
import { utilityDial, utilityNumCtx, utilityOutputCap } from '../agent/utility-dial.js';
import { CHARS_PER_TOKEN } from '../memory/budget.js';
import { localCharsPerToken } from './token-density.js';

/** The window, in tokens, of the Dojo writer's largest job (a leaf summary: its chunk plus its output),
 *  sized by the same `utilityNumCtx` the call itself is sized by. */
export async function writerJobWindowTokens(configuredNumCtx: number | null): Promise<number> {
  const { getLeafChunkTokens, getLeafTargetTokens } = await import('../memory/compaction.js');
  // t268 ruling 3: the chunk's characters (counted in the stored /4 dialect) are read at this box's density.
  return utilityNumCtx({ inputChars: getLeafChunkTokens() * CHARS_PER_TOKEN, configuredNumCtx, charsPerToken: localCharsPerToken(),
    outputTokens: utilityOutputCap(utilityDial('memory_summarize')!, getLeafTargetTokens()) });
}

/** The decision model's window, in tokens: the ONE number both the memory it is set aside (below) and the
 *  `num_ctx` `decide()` sends are (fix round 4, NB-4). The summary check hands it a job's source rows and
 *  the summary — exactly the text the writer's job window holds — so it is that window. */
export async function decisionWindowTokens(): Promise<number> {
  return writerJobWindowTokens(null);
}

/** The KV bytes the Dojo's writer holds for that job on this Ollama; 0 when no writer is installed or
 *  its architecture cannot be read (nothing is set aside for what cannot be sized). */
export async function writerWorkingBytes(baseUrl: string): Promise<number> {
  try {
    const row = getDb().prepare(`SELECT m.num_ctx_override AS o, m.num_ctx_recommended AS r FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE p.type = 'ollama' AND m.api_model_id = ? AND m.is_enabled = 1`).get(STANDARD_WRITER_MODEL.tag) as { o: number | null; r: number | null } | undefined;
    const arch = row ? await fetchModelArchInfo(baseUrl, STANDARD_WRITER_MODEL.tag) : null;
    const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
    return typeof kv === 'number' ? kv * await writerJobWindowTokens(row?.o ?? row?.r ?? null) : 0;
  } catch { return 0; }
}

/** The Dojo's whole working memory on its own Ollama: the writer's job, plus (fix round 2) the decision
 *  model's at `decisionWindowTokens()`. 0 for what Ollama cannot describe. */
export async function dojoWorkingBytes(baseUrl: string): Promise<number> {
  let decision = 0;
  try {
    const arch = await fetchModelArchInfo(baseUrl, STANDARD_DECISION_MODEL.tag);
    const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
    if (typeof kv === 'number') decision = kv * await decisionWindowTokens();
  } catch { /* nothing set aside for what cannot be sized */ }
  return await writerWorkingBytes(baseUrl) + decision;
}
