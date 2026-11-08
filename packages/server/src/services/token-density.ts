// How many characters make a token. The stored-row dialect counts 4 (`memory/budget.ts CHARS_PER_TOKEN`); the
// Dojo's own two local models were measured at a median 2.48 on this traffic (range 1.5 to 4.1), so a window on
// either is sized at that figure and never above 4 (`effectiveDivisor`): a measurement may only make a window larger.

import { effectiveDivisor } from '../memory/budget.js';
import { isStandardModelRow } from './local-standard.js';

export const MEASURED_CHARS_PER_TOKEN = 2.48;

/** Characters per token of this model (a `models` row id): the measured figure for the Dojo's own models, else the dialect's. */
export const modelCharsPerToken = (modelId: string | null | undefined): number =>
  effectiveDivisor(isStandardModelRow(modelId) ? MEASURED_CHARS_PER_TOKEN : null);

/** Tokens in `chars` characters at a density (absent: the dialect's). */
export const tokensAt = (chars: number, charsPerToken?: number): number => Math.ceil(Math.max(0, chars) / effectiveDivisor(charsPerToken));
