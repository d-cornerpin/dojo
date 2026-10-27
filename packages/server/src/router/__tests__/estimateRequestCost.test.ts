// estimateRequestCost — the rough per-request cost the budget gate is judged by:
// 2k input + 1k output tokens priced at the model's per-million rates. A NULL
// price estimates as $0 (how the biller records it), so an unpriced model is not
// over-gated as if it were the premium tier.

import { describe, it, expect } from 'vitest';
import { estimateRequestCost } from '../standing-filters.js';

describe('estimateRequestCost', () => {
  it('zero prices cost nothing', () => {
    expect(estimateRequestCost({ model_id: 'm', provider_id: 'p', api_model_id: 'a', priority: 0, input_cost_per_m: 0, output_cost_per_m: 0 })).toBe(0);
  });

  it('one dollar per million, each way', () => {
    expect(estimateRequestCost({ model_id: 'm', provider_id: 'p', api_model_id: 'a', priority: 0, input_cost_per_m: 1_000_000, output_cost_per_m: 1_000_000 })).toBe(3000);
  });

  it('thirty dollars in, one-fifty out', () => {
    expect(estimateRequestCost({ model_id: 'm', provider_id: 'p', api_model_id: 'a', priority: 0, input_cost_per_m: 3_000_000, output_cost_per_m: 15_000_000 })).toBe(21000);
  });

  it('a NULL price on both ways costs nothing', () => {
    expect(estimateRequestCost({ model_id: 'm', provider_id: 'p', api_model_id: 'a', priority: 0, input_cost_per_m: null, output_cost_per_m: null })).toBe(0);
  });

  it('a NULL output price is $0, only the input counts', () => {
    expect(estimateRequestCost({ model_id: 'm', provider_id: 'p', api_model_id: 'a', priority: 0, input_cost_per_m: 1_500_000, output_cost_per_m: null })).toBe(3000);
  });

  it('a NULL input price is $0, only the output counts', () => {
    expect(estimateRequestCost({ model_id: 'm', provider_id: 'p', api_model_id: 'a', priority: 0, input_cost_per_m: null, output_cost_per_m: 2_000_000 })).toBe(2000);
  });

  it('half a dollar per million, each way', () => {
    expect(estimateRequestCost({ model_id: 'm', provider_id: 'p', api_model_id: 'a', priority: 0, input_cost_per_m: 500_000, output_cost_per_m: 500_000 })).toBe(1500);
  });

  it('two-fifty per million, each way', () => {
    expect(estimateRequestCost({ model_id: 'm', provider_id: 'p', api_model_id: 'a', priority: 0, input_cost_per_m: 2_500_000, output_cost_per_m: 2_500_000 })).toBe(7500);
  });
});
