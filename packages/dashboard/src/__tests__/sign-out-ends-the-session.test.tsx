// The Sign out button in Settings, Security asks the server to clear its cookies, deletes the
// stored token and leaves the dashboard signed out.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AuthProvider, useAuth } from '../hooks/useAuth';
import { SecurityTab } from '../components/settings/SecurityTab';

const Shows = () => <div>{useAuth().isAuthenticated ? 'signed in' : 'signed out'}</div>;

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('sign out ends the session', () => {
  it('clears the token and the server session', async () => {
    localStorage.setItem('dojo_token', 'a-token');
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ ok: true, data: { authenticated: true, userId: 'admin' } }), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    render(<AuthProvider><Shows /><SecurityTab /></AuthProvider>);
    await screen.findByText('signed in');

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('signed out')).toBeTruthy();
    expect(localStorage.getItem('dojo_token')).toBeNull();
    expect(fetch.mock.calls.some(([url, init]) => url === '/api/auth/logout' && init?.method === 'POST')).toBe(true);
  });
});
