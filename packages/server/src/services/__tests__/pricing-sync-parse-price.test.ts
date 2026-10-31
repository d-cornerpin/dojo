// ════════════════════════════════════════════════════════════════════════════════════
// T86 — A NEGATIVE PRICE TEXT MUST NOT LAND IN THE COST COLUMNS.
//
// OpenRouter lists its variable-priced router models (e.g. the auto-router) with the
// price text "-1" to mean "price varies." parsePrice() multiplied that by 1e6 and,
// checking only Number.isFinite, returned -1000000. In syncOpenAiCompatibleProvider
// that flows straight into `UPDATE models SET input_cost_per_m = COALESCE(?, …)`, so a
// known row picked up input_cost_per_m = -1000000 and every later cost estimate for it
// went deeply negative. The sibling litellm-pricing-sync.ts already guards with `>= 0`;
// parsePrice must reject negatives the same way (so COALESCE keeps the existing value)
// while still accepting 0 — the legitimate "free model" price.
// ════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    throw new Error('unused');
  },
}));

vi.mock('../../config/loader.js', () => ({
  getProviderCredential: () => null,
}));

vi.mock('../../agent/model.js', () => ({
  resolveOpenAIBaseUrl: (u: string) => u,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug() {},
    info() {},
    warn() {},
    error() {},
  }),
}));

import { parsePrice } from '../price-per-million.js';

describe('parsePrice — per-token text to $/M-tokens', () => {
  it('multiplies a per-token price up to per-million', () => {
    expect(parsePrice('0.000003')).toBe(3);
    expect(parsePrice('0.0000015')).toBe(1.5);
    expect(parsePrice('0.00001')).toBe(10);
    expect(parsePrice('0.5')).toBe(500000);
  });

  it('a free model stays 0, not null', () => {
    expect(parsePrice('0')).toBe(0);
  });

  it('a negative price (OpenRouter "price varies") is rejected so COALESCE keeps the row', () => {
    expect(parsePrice('-1')).toBeNull();
    expect(parsePrice('-0.000001')).toBeNull();
  });

  it('blank, missing, or non-numeric text is null', () => {
    expect(parsePrice('')).toBeNull();
    expect(parsePrice(undefined)).toBeNull();
    expect(parsePrice(null)).toBeNull();
    expect(parsePrice('abc')).toBeNull();
    expect(parsePrice(' ')).toBeNull();
  });

  it('scientific notation is accepted', () => {
    expect(parsePrice('1e-6')).toBe(1);
  });
});
