// A provider's per-token price text, as a price per million tokens. Pure: the price refresh
// and the provider-validate route both read prices through it, and neither should pull the
// other's network code in to do so.
export const parsePrice = (s: string | undefined | null): number | null => {
  if (s === undefined || s === null || s === '') return null;
  const n = parseFloat(s) * 1_000_000;
  // OpenRouter tags its variable-priced router models (the auto-router) with the
  // text "-1" to mean "price varies." A negative result would overwrite a known
  // row via COALESCE and poison every later cost estimate, so reject it the same
  // way the sibling litellm-pricing-sync.ts does — 0 ("free") is still accepted.
  return Number.isFinite(n) && n >= 0 ? n : null;
};
