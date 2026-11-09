// t286: the reveal route carries a decrypted secret, so every response from the credentials router
// (found, not found, failure) tells browsers, proxies and caches not to keep it. It stays a GET.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../credentials/store.js', () => ({
  listCredentials: () => [],
  getCredentialById: (id: string) => id === 'x' ? { id: 'x', serviceName: 's', description: null, credentials: { k: 'v' } } : id === 'boom' ? (() => { throw new Error('nope'); })() : null,
  addCredential: vi.fn(), updateCredential: vi.fn(), deleteCredentialById: vi.fn(),
}));

describe('credential responses are never cacheable', () => {
  for (const [label, url] of [['found', '/x/reveal'], ['not found', '/missing/reveal'], ['failure', '/boom/reveal'], ['list', '/']] as const) {
    it(`GET ${label}: no-store and no-cache`, async () => {
      const { credentialsRouter } = await import('../routes/credentials.js');
      const res = await credentialsRouter.request(url);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(res.headers.get('Pragma')).toBe('no-cache');
    });
  }
});
