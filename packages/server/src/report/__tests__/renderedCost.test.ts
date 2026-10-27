// RENDERED COST: the exact bytes one item spends in the rendered bundle.
// Its own pretty form, plus the four spaces its lines gain at depth two, plus the
// comma and newline. Pinned here so a change to the cost model is caught.
import { describe, it, expect } from 'vitest';
import { renderedCost } from '../bounds.js';

describe('renderedCost', () => {
  it('a short string', () => {
    expect(renderedCost('hi')).toBe(10);
  });

  it('a number', () => {
    expect(renderedCost(42)).toBe(8);
  });

  it('null', () => {
    expect(renderedCost(null)).toBe(10);
  });

  it('an empty array', () => {
    expect(renderedCost([])).toBe(8);
  });

  it('a one-key object with a numeric value', () => {
    expect(renderedCost({ a: 1 })).toBe(26);
  });

  it('a one-key object with a string value', () => {
    expect(renderedCost({ a: 'x' })).toBe(28);
  });

  it('a two-key object', () => {
    expect(renderedCost({ a: 1, b: 2 })).toBe(40);
  });

  it('a two-element array', () => {
    expect(renderedCost([1, 2])).toBe(30);
  });
});
