// ════════════════════════════════════════════════════════════════════════════
// v3.5 — THE DOJO'S OWN WORKING MEMORY ON ITS OLLAMA (fix rounds 1-2, orchestrator rulings).
//
// The KV cache the Dojo's writer holds for its largest job (a leaf summary: its chunk in, its summary
// out), and the decision model's at the window it really runs at (t268: its derived tag). This room is set aside:
// the window recommendation (`num-ctx-calculator.ts`) never sizes another local model into it, and the
// memory-fit gate (`agent/local-model-fit.ts`) never offers it to an agent model.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { fetchModelArchInfo } from './num-ctx-calculator.js';
import { kvBytesPerTokenOf } from './kv-bytes.js';
import { STANDARD_WRITER_MODEL, STANDARD_DECISION_MODEL, standardModelRowId } from './local-standard.js';
import { utilityDial, utilityNumCtx, utilityOutputCap, MIN_UTILITY_NUM_CTX } from '../agent/utility-dial.js';
import { CHARS_PER_TOKEN } from '../memory/budget.js';
import { writerCharsPerToken } from './token-density.js';
import { standardTierModels } from '../router/tier-chain.js';

/** The window, in tokens, of the Dojo writer's largest job (a leaf summary: its chunk plus its output),
 *  sized by the same `utilityNumCtx` the call itself is sized by. */
export async function writerJobWindowTokens(configuredNumCtx: number | null, charsPerToken = writerCharsPerToken()): Promise<number> {
  const { getLeafChunkTokens, getLeafTargetTokens } = await import('../memory/compaction.js');
  // t268 ruling 3: the chunk's characters (counted in the stored /4 dialect) are read at this box's density.
  return utilityNumCtx({ inputChars: getLeafChunkTokens() * CHARS_PER_TOKEN, configuredNumCtx, charsPerToken,
    outputTokens: utilityOutputCap(utilityDial('memory_summarize')!, getLeafTargetTokens()) });
}

/** Where the derived decision tag's window is recorded (`services/decision-window.ts` writes it, at install). */
export const DECISION_WINDOW_KEY = 'decision_model_window';
/** MEASURED (B5, `overhaul-plans/v35-writer-measure.md` → "The num_ctx question"): `/v1/systemone` ignores
 *  `num_ctx` in every form; the decision model's runner stays at its model file's own `-c 8192`. */
export const BUILTIN_DECISION_WINDOW = 8_192;

/** The derived decision tag's recorded window, or null while it has not been created on this box. */
export function decisionTagWindow(): number | null {
  try {
    const v = Number((getDb().prepare("SELECT value FROM config WHERE key = 'decision_model_window'").get() as { value: string } | undefined)?.value);
    return Number.isInteger(v) && v > 0 ? v : null;
  } catch { return null; }
}

/** The decision model's window, in tokens: the window it REALLY runs at (t268 ruling 2) — the derived tag's
 *  `PARAMETER num_ctx`, else the base tag's built-in one. The ONE number the memory set aside for it (below),
 *  the derived tag and `decide()`'s sizing all are. */
export async function decisionWindowTokens(): Promise<number> {
  return decisionTagWindow() ?? BUILTIN_DECISION_WINDOW;
}

/**
 * Are summaries ASSIGNED to the Dojo's writer on this box's configuration (t268 fix round 2, ruling; owner
 * 2026-10-24, "The agents model."; v3.5 field fix 3: there is no Summarization setting)? Yes when it is an
 * agent's FIXED model, or (fix round 4, N-E) it is placed in a router tier a standard-tier request walks and some
 * agent is auto-routed (fix round 3: an auto-routed agent writes with its router's standard-tier pick,
 * `summaryWriterCandidates`). A FALLBACK (an agent's model not answering) is not an assignment: it is sized to the
 * memory free when it runs (`memory/writer-fallback-room.ts`), never reserved.
 */
export function writerAssignedSummaries(): boolean {
  const writerId = standardModelRowId('writer');
  if (!writerId) return false;
  const db = getDb();
  if (db.prepare('SELECT 1 FROM agents WHERE model_id = ? LIMIT 1').get(writerId)) return true;
  return standardTierModels().includes(writerId)
    && !!db.prepare("SELECT 1 FROM agents WHERE model_id IS NULL OR model_id IN ('', 'auto', '__auto__') LIMIT 1").get();
}

/**
 * THE WRITER'S RESERVED ROOM, in tokens: the jobs ASSIGNED to it here, deterministic from the configuration. Its
 * summary job's window when summaries are assigned to it (above); otherwise its system jobs only (titles, the
 * voice opener, the multi-step check), each a short call at the smallest window any job asks for — a longer one
 * is given its own window for that call (`utilityNumCtx`), never a standing reserve.
 */
export async function writerReservedWindowTokens(configuredNumCtx: number | null): Promise<number> {
  return writerAssignedSummaries() ? writerJobWindowTokens(configuredNumCtx) : MIN_UTILITY_NUM_CTX;
}

/** The KV bytes the Dojo's writer holds for its reserved room on this Ollama; 0 when no writer is installed or
 *  its architecture cannot be read (nothing is set aside for what cannot be sized). */
export async function writerWorkingBytes(baseUrl: string): Promise<number> {
  try {
    const row = getDb().prepare(`SELECT m.num_ctx_override AS o, m.num_ctx_recommended AS r FROM models m JOIN providers p ON p.id = m.provider_id
      WHERE p.type = 'ollama' AND m.api_model_id = ? AND m.is_enabled = 1`).get(STANDARD_WRITER_MODEL.tag) as { o: number | null; r: number | null } | undefined;
    const arch = row ? await fetchModelArchInfo(baseUrl, STANDARD_WRITER_MODEL.tag) : null;
    const kv = arch ? kvBytesPerTokenOf(arch.modelInfo, arch.archField) : null;
    return typeof kv === 'number' ? kv * await writerReservedWindowTokens(row?.o ?? row?.r ?? null) : 0;
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
