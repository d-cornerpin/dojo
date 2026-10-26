// v3.5 B2 — THE DECISION SHADOW SCORE MATH. The three pure-arithmetic helpers the per-question score
// and the decision policy lean on: verdictOf (a model answer in the truth's own terms), wilson (the 95 %
// interval the policy compares) and inWeakestBand (the tenth where the model was right least often). Pure,
// so none of them opens the database: getDb is mocked to throw, so nothing can reach the real one.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ getDb: () => { throw new Error('no db'); } }));

import { wilson, verdictOf, inWeakestBand, type QuestionScore } from '../decision-shadow.js';
import type { Answer } from '../decide.js';

describe('wilson — the 95 % score interval (z = 1.96)', () => {
  // [successes, n, [lower, upper]] — the lower bound clamps to 0, the upper to 1.
  const cases: Array<[number, number, [number, number]]> = [
    [0, 0, [0, 1]],
    [0, 10, [0, 0.277540]],
    [10, 10, [0.722460, 1]],
    [8, 10, [0.490157, 0.943319]],
    [50, 100, [0.403830, 0.596170]],
    [1, 1, [0.206543, 1]],
  ];
  for (const [successes, n, [lo, hi]] of cases) {
    it(`wilson(${successes}, ${n}) is [${lo}, ${hi}] and stays in [0, 1]`, () => {
      const [gotLo, gotHi] = wilson(successes, n);
      expect(gotLo).toBeCloseTo(lo, 6);
      expect(gotHi).toBeCloseTo(hi, 6);
      expect(gotLo).toBeGreaterThanOrEqual(0);
      expect(gotHi).toBeLessThanOrEqual(1);
    });
  }
});

describe('verdictOf — the model verdict in the truth\'s own terms, and the probability it gave', () => {
  it('a noul answer cuts at >= 0.5', () => {
    expect(verdictOf({ type: 'noul', noul: 0.5 } as Answer)).toEqual({ said: 'true', p: 0.5 });
    expect(verdictOf({ type: 'noul', noul: 0.49 } as Answer).said).toBe('false');
  });

  it('a choice is JSON-quoted, so it compares equal to a stored JSON truth', () => {
    expect(verdictOf({ type: 'choice', choice: 'a', probabilities: {}, confidence: 0.7 } as Answer))
      .toEqual({ said: '"a"', p: 0.7 });
  });

  it('a score is rounded, then JSON-quoted', () => {
    expect(verdictOf({ type: 'score', score: 2.5, probabilities: {}, confidence: 0.3 } as Answer))
      .toEqual({ said: '3', p: 0.3 });
    expect(verdictOf({ type: 'score', score: 2.4, probabilities: {}, confidence: 0.3 } as Answer).said).toBe('2');
  });
});

describe('inWeakestBand — is p inside the score\'s band, the tenth the model was right least often?', () => {
  const band = (b: [number, number]): QuestionScore => ({ band: b } as unknown as QuestionScore);

  it('a band of [0.5, 0.6] (decile 5) holds its own tenth and no other', () => {
    expect(inWeakestBand(band([0.5, 0.6]), 0.55)).toBe(true);
    for (const p of [0, 0.05, 0.09, 0.1, 0.99, 1.0]) expect(inWeakestBand(band([0.5, 0.6]), p)).toBe(false);
  });

  it('the top decile [0.9, 1.0] (decile 9) holds 0.9, 0.95 and 1.0', () => {
    expect(inWeakestBand(band([0.9, 1.0]), 0.9)).toBe(true);
    expect(inWeakestBand(band([0.9, 1.0]), 0.95)).toBe(true);
    expect(inWeakestBand(band([0.9, 1.0]), 1.0)).toBe(true);
  });
});
