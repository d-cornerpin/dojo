import { describe, it, expect } from 'vitest';
import { recallStrategyClassifier } from '../classifiers/recall.js';

describe('recallStrategyClassifier', () => {
  it('skips on empty query', () => {
    expect(recallStrategyClassifier('').strategy).toBe('skip');
  });

  it('skips on no recall signal', () => {
    expect(recallStrategyClassifier('build a dashboard').strategy).toBe('skip');
    expect(recallStrategyClassifier('what is 2 plus 2').strategy).toBe('skip');
  });

  it('chooses vault for "do you remember when"', () => {
    expect(recallStrategyClassifier('do you remember when we shipped the api').strategy).toBe('vault');
  });

  it('chooses vault for "my partner"', () => {
    expect(recallStrategyClassifier("what's my partner's name?").strategy).toBe('vault');
  });

  it('chooses vault for "what did we decide"', () => {
    expect(recallStrategyClassifier('what did we decide about pricing').strategy).toBe('vault');
  });

  it('chooses grep for filename references', () => {
    expect(recallStrategyClassifier('check the file foo.ts').strategy).toBe('grep');
  });

  it('chooses grep for quoted phrases', () => {
    expect(recallStrategyClassifier('search for "rate limit exceeded"').strategy).toBe('grep');
  });

  it('chooses grep for ISO dates', () => {
    expect(recallStrategyClassifier('what happened on 2026-04-12').strategy).toBe('grep');
  });

  it('chooses grep for "yesterday" / "this morning"', () => {
    expect(recallStrategyClassifier('what did we work on yesterday').strategy).toBe('grep');
    expect(recallStrategyClassifier('this morning we discussed something').strategy).toBe('grep');
  });

  it('chooses both when both signals appear', () => {
    const r = recallStrategyClassifier('do you remember the file we discussed yesterday called foo.ts');
    expect(r.strategy).toBe('both');
  });

  it('returns signals for debugging', () => {
    const r = recallStrategyClassifier('do you remember');
    expect(r.signals.length).toBeGreaterThan(0);
  });
});
