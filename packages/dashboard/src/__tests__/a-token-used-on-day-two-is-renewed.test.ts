// The dashboard keeps the fresh token the server sends when it replaces a day-old one.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { request, getToken } from '../lib/door';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('a token used on day two is renewed', () => {
  it('stores the replacement token from the answer', async () => {
    localStorage.setItem('dojo_token', 'day-one-token');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"ok":true,"data":null}', { headers: { 'X-Dojo-Token': 'day-two-token' } })));
    await request('/auth/me');
    expect(getToken()).toBe('day-two-token');
  });
});
