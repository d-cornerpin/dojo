import { describe, it, expect } from 'vitest';
import { complexityClassifier } from '../classifiers/complexity.js';

describe('complexityClassifier', () => {
  it('classifies empty as simple', () => {
    expect(complexityClassifier('').complexity).toBe('simple');
    expect(complexityClassifier('   ').complexity).toBe('simple');
  });

  it('classifies greetings as simple', () => {
    expect(complexityClassifier('hi').complexity).toBe('simple');
    expect(complexityClassifier('hey there').complexity).toBe('simple');
    expect(complexityClassifier('Good morning').complexity).toBe('simple');
  });

  it('classifies thanks as simple', () => {
    expect(complexityClassifier('thanks').complexity).toBe('simple');
    expect(complexityClassifier('Thank you!').complexity).toBe('simple');
  });

  it('classifies acknowledgments as simple', () => {
    expect(complexityClassifier('ok').complexity).toBe('simple');
    expect(complexityClassifier('got it').complexity).toBe('simple');
    expect(complexityClassifier('sounds good').complexity).toBe('simple');
  });

  it('classifies single short questions as simple', () => {
    expect(complexityClassifier('what time is it?').complexity).toBe('simple');
  });

  it('classifies "build a dashboard" as complex', () => {
    expect(complexityClassifier('build a dashboard for tracking sales').complexity).toBe('complex');
  });

  it('classifies "implement OAuth" as complex', () => {
    expect(complexityClassifier('implement OAuth flow for the new auth system').complexity).toBe('complex');
  });

  it('classifies "refactor X" as complex', () => {
    expect(complexityClassifier('refactor the user service to use the new schema').complexity).toBe('complex');
  });

  it('classifies "create a deck" as complex', () => {
    expect(complexityClassifier('create a presentation for the all-hands').complexity).toBe('complex');
  });

  it('classifies long messages as complex', () => {
    const long = 'I need you to look at all the recent commits, summarize what changed, group them by feature area, and produce a release note that explains each one to a non-technical reader. Use the existing release-notes format we use.';
    expect(complexityClassifier(long).complexity).toBe('complex');
  });

  it('classifies multi-sentence queries as complex', () => {
    expect(complexityClassifier('Hey can you check this. Then tell me what you think.').complexity).toBe('complex');
  });

  it('returns signals array for debugging', () => {
    const r = complexityClassifier('build a dashboard');
    expect(r.signals.length).toBeGreaterThan(0);
  });

  it('classifies short ambiguous as simple by default', () => {
    expect(complexityClassifier('how about now?').complexity).toBe('simple');
  });
});
