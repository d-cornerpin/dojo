// Per-token price text as price per million tokens; pure, so the price refresh and the validate route share it.
export const parsePrice = (s: string | undefined | null): number | null => {
  if (s === undefined || s === null || s === '') return null;
  const n = parseFloat(s) * 1_000_000;
  // "-1" (OpenRouter's variable-priced router models) means "price varies": reject it like the sibling
  // litellm-pricing-sync.ts, since a negative would overwrite a known row via COALESCE. 0 ("free") is accepted.
  return Number.isFinite(n) && n >= 0 ? n : null;
};
