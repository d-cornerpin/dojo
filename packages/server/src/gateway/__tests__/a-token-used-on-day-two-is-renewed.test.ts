// A token in use is replaced once it is a day old, so the owner stays signed in while he uses the
// dashboard and is signed out only after 30 idle days.

import { describe, it, expect, vi, afterAll } from 'vitest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const hash = bcrypt.hashSync('a-test-password', 4);
vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getJwtSecret: () => 'test-secret-for-renewal',
  getDashboardPasswordHash: () => hash,
}));

const { createServer } = await import('../server.js');
const app = createServer().app;
const DAY = 24 * 3600_000;

const me = (token: string) => app.request('/api/auth/me', { headers: { Authorization: `Bearer ${token}` } });

afterAll(() => { vi.useRealTimers(); });

describe('a token used on day two is renewed', () => {
  it('renews a day-old token and lets a used session outlive its first 30 days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T09:00:00Z'));
    const login = await app.request('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'a-test-password' }),
    });
    const first = ((await login.json()) as { data: { token: string } }).data.token;

    vi.setSystemTime(Date.now() + 3600_000);
    const fresh = await me(first);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('x-dojo-token')).toBeNull();

    vi.setSystemTime(Date.now() + DAY);
    const dayTwo = await me(first);
    expect(dayTwo.status).toBe(200);
    const renewed = dayTwo.headers.get('x-dojo-token');
    expect(renewed).toBeTruthy();
    expect(renewed).not.toBe(first);
    expect(dayTwo.headers.get('set-cookie')).toContain(`token=${renewed}`);

    vi.setSystemTime(Date.now() + 29 * DAY);
    expect((await me(first)).status).toBe(401);
    expect((await me(renewed!)).status).toBe(200);

    vi.setSystemTime(Date.now() + 31 * DAY);
    expect((await me(renewed!)).status).toBe(401);
  });

  it('renews a 24-hour token from before the update on its first use', async () => {
    const old = jwt.sign({ userId: 'admin' }, 'test-secret-for-renewal', { expiresIn: '24h' });
    vi.setSystemTime(Date.now() + 2 * 3600_000);
    const res = await me(old);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-dojo-token')).toBeTruthy();
  });
});
