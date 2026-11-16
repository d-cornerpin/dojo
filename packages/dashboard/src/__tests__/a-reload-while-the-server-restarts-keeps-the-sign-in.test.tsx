// A reload while the Dojo restarts keeps the sign-in: a dead network or the 503 "starting" answer is
// waited out, and only a real 401 deletes the token.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { AuthProvider, useAuth } from '../hooks/useAuth';

const Shows = () => {
  const { isAuthenticated, isLoading } = useAuth();
  return <div>{isLoading ? 'loading' : isAuthenticated ? 'signed in' : 'signed out'}</div>;
};
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });

describe('a reload while the server restarts keeps the sign-in', () => {
  it('waits out a dead network and a long start, then is still signed in', async () => {
    vi.useFakeTimers();
    localStorage.setItem('dojo_token', 'a-token');
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('connection refused');
      if (calls < 8) return json(503, { ok: false, error: 'Dojo is starting' });
      return json(200, { ok: true, data: { authenticated: true, userId: 'admin' } });
    }));
    render(<AuthProvider><Shows /></AuthProvider>);
    for (let i = 0; i < 10; i++) await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByText('signed in')).toBeTruthy();
    expect(localStorage.getItem('dojo_token')).toBe('a-token');
  });

  it('signs out on a real 401', async () => {
    localStorage.setItem('dojo_token', 'a-stale-token');
    vi.stubGlobal('fetch', vi.fn(async () => json(401, { ok: false, error: 'Invalid or expired token' })));
    render(<AuthProvider><Shows /></AuthProvider>);
    expect(await screen.findByText('signed out')).toBeTruthy();
    expect(localStorage.getItem('dojo_token')).toBeNull();
  });
});
