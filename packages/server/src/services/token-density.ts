// ════════════════════════════════════════════════════════════════════════════
// v3.5 (t268, orchestrator ruling 3; fix round 1, I-3) — HOW MANY CHARACTERS MAKE A TOKEN, PER MODEL.
//
// The engine's stored-row dialect counts 4 characters per token (`memory/budget.ts CHARS_PER_TOKEN`). B5
// measured this traffic on the Dojo's own two models (`overhaul-plans/v35-writer-measure.md`): the decision
// model's tokenizer counted the median request at 2.48 characters per token (range 1.5 to 4.1), and the
// writer's traffic at about 2.5. A window sized at 4 therefore undercounts by about 1.6x, and Ollama cut the
// writer's prompt to half its window in 21 of 300 writes.
//
// So a window on Ollama is sized at THE MODEL'S OWN running figure — density is a property of a tokenizer, so a
// figure measured on one model never sizes another's jobs:
//   · each sample is one call's characters over the tokens Ollama itself counted (`prompt_eval_count` for the
//     writer's jobs, `agent/model.ts`; `usage.input_tokens` per question for the decision model, `decide.ts`);
//   · the figure is the MEDIAN of the model's samples in the calibration's window (`ESTIMATOR_SAMPLE_WINDOW_DAYS`):
//     a robust central figure, so one dense call does not move a memory reserve;
//   · a model with no sample uses B5's measured value if it is one of the two models B5 measured, else 4;
//   · never above 4 (`effectiveDivisor`, the budget's bound A): a measurement may only make a window larger.
// These samples are kept apart from the provider's shared readings (`costs/ledger-calibration.ts`), which
// agents' own turn estimates spend: a tokenizer's figure must not size another model's turns.
// ════════════════════════════════════════════════════════════════════════════

import { getDb } from '../db/connection.js';
import { CHARS_PER_TOKEN, effectiveDivisor } from '../memory/budget.js';
import { isLegalCharsPerToken, ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS, ESTIMATOR_SAMPLE_WINDOW_DAYS } from '../costs/ledger-calibration.js';
import { STANDARD_TAGS, standardModelRowId } from './local-standard.js';

/** The seed: B5's measured median, `v35-writer-measure.md` → "B4's check exactly as shipped" → "Tokens per character". */
export const B5_MEASURED_CHARS_PER_TOKEN = 2.48;

const WINDOW_MS = ESTIMATOR_SAMPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const keyOf = (modelId: string): string => `token_density.${modelId}`;
type Sample = [atMs: number, charsPerToken: number];

function samplesOf(modelId: string, now = Date.now()): Sample[] {
  try {
    const raw = (getDb().prepare('SELECT value FROM config WHERE key = ?').get(keyOf(modelId)) as { value: string } | undefined)?.value;
    const all = raw ? (JSON.parse(raw) as Sample[]) : [];
    return all.filter((s) => Array.isArray(s) && now - s[0] <= WINDOW_MS && isLegalCharsPerToken(s[1]));
  } catch { return []; }
}

/**
 * One call's characters against the tokens the model's own tokenizer counted. Not a sample (the calibration's
 * own guards): a call too small to read a ratio from, a count outside the legal range, and a prompt Ollama cut
 * (B5 measured the cut's shape: `prompt_eval_count` = the window ÷ 2 + 2). Best-effort; never throws.
 */
export function recordDensitySample(modelId: string | null | undefined, chars: number, tokens: number, numCtx?: number | null): void {
  if (!modelId || !(tokens > 0) || chars < ESTIMATOR_SAMPLE_MIN_ESTIMATED_TOKENS * CHARS_PER_TOKEN) return;
  if (typeof numCtx === 'number' && tokens === Math.floor(numCtx / 2) + 2) return;
  const cpt = chars / tokens;
  if (!isLegalCharsPerToken(cpt)) return;
  try {
    const now = Date.now();
    getDb().prepare(`INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run(keyOf(modelId), JSON.stringify([...samplesOf(modelId, now), [now, cpt]]));
  } catch { /* a sample is a courtesy; never break the call it rides on */ }
}

function isStandardRow(modelId: string): boolean {
  try {
    const api = (getDb().prepare('SELECT api_model_id FROM models WHERE id = ?').get(modelId) as { api_model_id: string } | undefined)?.api_model_id;
    return !!api && STANDARD_TAGS.includes(api);
  } catch { return false; }
}

/** Characters per token of this model (a `models` row id): the median of its own samples, else its seed. */
export function modelCharsPerToken(modelId: string | null | undefined): number {
  const xs = modelId ? samplesOf(modelId).map((s) => s[1]).sort((a, b) => a - b) : [];
  if (xs.length > 0) {
    const mid = Math.floor(xs.length / 2);
    return effectiveDivisor(xs.length % 2 === 1 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2);
  }
  return effectiveDivisor(modelId && isStandardRow(modelId) ? B5_MEASURED_CHARS_PER_TOKEN : null);
}

/** The Dojo's writer's figure (its jobs, the window the memory fit reserves for it); B5's before it is installed. */
export const writerCharsPerToken = (): number => {
  const id = standardModelRowId('writer');
  return id ? modelCharsPerToken(id) : B5_MEASURED_CHARS_PER_TOKEN;
};
/** The decision model's figure (its window, `decide()`'s sizing and timeout), measured on the decision model only. */
export const decisionCharsPerToken = (): number => {
  const id = standardModelRowId('decision');
  return id ? modelCharsPerToken(id) : B5_MEASURED_CHARS_PER_TOKEN;
};

/** Tokens in `chars` characters at a density. */
export const tokensAt = (chars: number, charsPerToken: number): number => Math.ceil(Math.max(0, chars) / charsPerToken);
