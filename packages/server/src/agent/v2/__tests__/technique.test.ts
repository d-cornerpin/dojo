import { describe, it, expect } from 'vitest';
import { techniqueMatcher, type Technique } from '../classifiers/technique.js';

const techniques: Technique[] = [
  {
    id: 'pitch-deck-builder',
    name: 'Pitch Deck Builder',
    description: 'Structured workflow for building investor pitch decks with consistent style and content.',
    tags: ['slides', 'presentation', 'pitch', 'deck'],
  },
  {
    id: 'bug-investigation',
    name: 'Bug Investigation',
    description: 'Systematic process for diagnosing software bugs.',
    tags: ['debug', 'troubleshoot', 'bug'],
  },
  {
    id: 'release-notes',
    name: 'Release Notes Writer',
    description: 'Generate user-facing release notes from a list of commits.',
    tags: ['release', 'changelog', 'commits'],
  },
];

describe('techniqueMatcher', () => {
  it('returns empty for no techniques', () => {
    const r = techniqueMatcher({ query: 'build a deck', techniques: [] });
    expect(r).toEqual([]);
  });

  it('returns empty for empty query', () => {
    const r = techniqueMatcher({ query: '', techniques });
    expect(r).toEqual([]);
  });

  it('matches pitch deck for "build a pitch deck"', () => {
    const r = techniqueMatcher({ query: 'build me a pitch deck for our seed round', techniques });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].technique.id).toBe('pitch-deck-builder');
  });

  it('matches bug investigation for "debug this issue"', () => {
    const r = techniqueMatcher({ query: 'help me debug this auth bug', techniques });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].technique.id).toBe('bug-investigation');
  });

  it('matches release notes for "write release notes"', () => {
    const r = techniqueMatcher({ query: 'write release notes for the last sprint', techniques });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].technique.id).toBe('release-notes');
  });

  it('returns nothing for completely unrelated query', () => {
    const r = techniqueMatcher({ query: 'what time is it', techniques });
    expect(r).toEqual([]);
  });

  it('limits results to maxMatches', () => {
    const many: Technique[] = Array.from({ length: 10 }, (_, i) => ({
      id: `tech-${i}`,
      name: `Pitch Deck Builder ${i}`,
      tags: ['pitch', 'deck'],
    }));
    const r = techniqueMatcher({ query: 'pitch deck', techniques: many, maxMatches: 2 });
    expect(r).toHaveLength(2);
  });

  it('respects custom minScore', () => {
    const r = techniqueMatcher({ query: 'deck', techniques, minScore: 0.99 });
    expect(r).toEqual([]);
  });

  it('returns reasons for debugging', () => {
    const r = techniqueMatcher({ query: 'pitch deck', techniques });
    expect(r[0].reasons.length).toBeGreaterThan(0);
  });

  it('sorts by score descending', () => {
    const r = techniqueMatcher({ query: 'pitch deck builder slides', techniques });
    if (r.length > 1) {
      for (let i = 1; i < r.length; i++) {
        expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
      }
    }
  });
});
