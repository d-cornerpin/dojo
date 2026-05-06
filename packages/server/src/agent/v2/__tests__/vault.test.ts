import { describe, it, expect } from 'vitest';
import { vaultPrefetchClassifier } from '../classifiers/vault.js';

describe('vaultPrefetchClassifier', () => {
  const base = {
    query: '',
    isSessionStart: false,
    recentlyUsedVault: false,
    isSystemTrigger: false,
  };

  it('always fetches at session start', () => {
    const r = vaultPrefetchClassifier({ ...base, isSessionStart: true, query: 'hi' });
    expect(r.shouldFetch).toBe(true);
    expect(r.reason).toContain('session start');
  });

  it('uses fallback terms at session start with empty query', () => {
    const r = vaultPrefetchClassifier({ ...base, isSessionStart: true, query: '' });
    expect(r.shouldFetch).toBe(true);
    expect(r.queryTerms.length).toBeGreaterThan(0);
  });

  it('skips for system triggers', () => {
    const r = vaultPrefetchClassifier({ ...base, isSystemTrigger: true, query: 'whatever' });
    expect(r.shouldFetch).toBe(false);
    expect(r.reason).toContain('system trigger');
  });

  it('skips for empty query', () => {
    const r = vaultPrefetchClassifier(base);
    expect(r.shouldFetch).toBe(false);
  });

  it('fetches on "do you remember" patterns', () => {
    const r = vaultPrefetchClassifier({ ...base, query: 'do you remember when we discussed the api refactor' });
    expect(r.shouldFetch).toBe(true);
    expect(r.reason).toContain('recall pattern');
  });

  it('fetches on "what is my preference" patterns', () => {
    const r = vaultPrefetchClassifier({ ...base, query: 'what is my preferred deployment workflow' });
    expect(r.shouldFetch).toBe(true);
  });

  it('fetches on "my project" / personal context patterns', () => {
    const r = vaultPrefetchClassifier({ ...base, query: 'tell me about my project Aurora' });
    expect(r.shouldFetch).toBe(true);
  });

  it('skips when recently used vault and no strong signal', () => {
    const r = vaultPrefetchClassifier({ ...base, query: 'how does this work', recentlyUsedVault: true });
    expect(r.shouldFetch).toBe(false);
  });

  it('still fetches on strong signal even when recently used vault', () => {
    const r = vaultPrefetchClassifier({ ...base, query: 'do you remember the deployment plan', recentlyUsedVault: true });
    expect(r.shouldFetch).toBe(true);
  });

  it('extracts substantive terms (no stop words, length >= 3)', () => {
    const r = vaultPrefetchClassifier({ ...base, query: 'tell me about deployment workflow' });
    expect(r.queryTerms).toContain('deployment');
    expect(r.queryTerms).toContain('workflow');
    expect(r.queryTerms).not.toContain('me');  // stop word
    expect(r.queryTerms).not.toContain('the'); // stop word
  });

  it('skips when no substantive terms', () => {
    const r = vaultPrefetchClassifier({ ...base, query: 'is it' });
    expect(r.shouldFetch).toBe(false);
  });
});
