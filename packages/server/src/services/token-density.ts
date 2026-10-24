// ════════════════════════════════════════════════════════════════════════════
// v3.5 (t268, orchestrator ruling 3) — HOW MANY CHARACTERS MAKE A TOKEN ON THIS BOX'S OLLAMA.
//
// The engine's stored-row dialect counts 4 characters per token (`memory/budget.ts CHARS_PER_TOKEN`). B5
// measured this traffic on the Dojo's own two models (`overhaul-plans/v35-writer-measure.md`): the decision
// model's tokenizer counted the median request at 2.48 characters per token (range 1.5 to 4.1), and the
// writer's traffic at about 2.5. A window sized at 4 therefore undercounts by about 1.6x, and Ollama cut the
// writer's prompt to half its window in 21 of 300 writes.
//
// So a window on Ollama is sized at the box's OWN running figure: the prose reading the ledger calibration
// keeps per provider (`costs/ledger-calibration.ts`, from Ollama's own `prompt_eval_count` on the engine's
// utility calls — `agent/model.ts` records the estimate beside it), and until a box has one, B5's measured
// value. Never above the asserted 4 (`effectiveDivisor`, the budget's bound A): a measurement may only make
// a window larger.
// ════════════════════════════════════════════════════════════════════════════

import { measuredDivisorsFor } from '../costs/estimator-divisors.js';
import { effectiveDivisor } from '../memory/budget.js';
import { localOllamaProvider } from './local-standard.js';

/** The seed: B5's measured median, `v35-writer-measure.md` → "B4's check exactly as shipped" → "Tokens per character". */
export const B5_MEASURED_CHARS_PER_TOKEN = 2.48;

/** Characters per token on this Ollama provider: its own measured reading, else B5's. */
export function ollamaCharsPerToken(providerId: string | null | undefined): number {
  return effectiveDivisor(measuredDivisorsFor(providerId).prose ?? B5_MEASURED_CHARS_PER_TOKEN);
}

/** The same figure for the box's local Ollama, where the Dojo's two models run. */
export function localCharsPerToken(): number {
  return ollamaCharsPerToken(localOllamaProvider()?.id);
}

/** Tokens in `chars` characters at a density. */
export const tokensAt = (chars: number, charsPerToken: number): number => Math.ceil(Math.max(0, chars) / charsPerToken);
