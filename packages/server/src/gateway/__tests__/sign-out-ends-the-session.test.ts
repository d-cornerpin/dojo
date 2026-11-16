// Signing out clears the browser's session cookies, so the next request carrying them is refused.

import { describe, it, expect, vi } from 'vitest';
import bcrypt from 'bcrypt';

const hash = bcrypt.hashSync('a-test-password', 4);
vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getJwtSecret: () => 'test-secret-for-sign-out',
  getDashboardPasswordHash: () => hash,
}));

const { createServer } = await import('../server.js');
const app = createServer().app;

/** A browser's cookie jar: later Set-Cookie lines replace earlier ones, Max-Age=0 deletes. */
const jar = new Map<string, string>();
const keep = (res: Response) => {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    const [name, value] = pair.split('=');
    if (/Max-Age=0/.test(line)) jar.delete(name); else jar.set(name, value);
  }
};
const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');

describe('sign out ends the session', () => {
  it('leaves the browser with no session cookie', async () => {
    keep(await app.request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-test-password' }),
    }));
    expect((await app.request('/api/auth/me', { headers: { Cookie: cookie() } })).status).toBe(200);

    const out = await app.request('/api/auth/logout', { method: 'POST', headers: { Cookie: cookie(), 'X-CSRF-Token': jar.get('csrf')! } });
    expect(out.status).toBe(200);
    keep(out);

    expect(jar.has('token')).toBe(false);
    expect((await app.request('/api/auth/me', { headers: { Cookie: cookie() } })).status).toBe(401);
  });
});
