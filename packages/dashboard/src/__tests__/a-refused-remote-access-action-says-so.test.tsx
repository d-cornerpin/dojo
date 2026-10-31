// ── A REFUSED REMOTE-ACCESS ACTION SAYS SO. ───────────────────────────────────
//
// Enable, Disable, Install and Save URL on the Remote Access card threw the server's answer
// away, so a refused one left the card unchanged with no reason. The refusal must be shown, a
// refused token save must stop the enable, and a later success clears the message. Mounted
// through the whole Platform tab (the card is not exported).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

const answers: Record<string, { ok: boolean; error?: string; data?: unknown }> = {};
const calls: string[] = [];

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  stub.request = vi.fn(async (path: string) => {
    calls.push(path);
    return answers[path] ?? { ok: false, error: 'offline' };
  });
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return {
    useWebSocket: fakeUseWebSocket,
    WebSocketProvider: ({ children }: { children: ReactElement }) => children,
  };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
    ToastContainer: () => null,
  };
});

import { PlatformTab } from '../components/settings/PlatformTab';

const stopped = {
  ok: true,
  data: { enabled: false, mode: 'quick', status: 'stopped', url: null, error: null, startedAt: null, cloudflaredInstalled: true },
};

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  calls.length = 0;
  answers['/system/tunnel'] = stopped;
});

describe('a refused remote-access action', () => {
  it('(a) shows the reason when Enable is refused', async () => {
    answers['/system/tunnel/enable'] = { ok: false, error: 'tunnel refused' };
    render(<PlatformTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enable Remote Access' }));
    expect(await screen.findByText('tunnel refused')).toBeTruthy();
  });

  it('(b) does not enable when the token save is refused, and says why', async () => {
    answers['/system/tunnel/token'] = { ok: false, error: 'token refused' };
    answers['/system/tunnel/enable'] = { ok: true, data: {} };
    render(<PlatformTab />);
    await screen.findByRole('button', { name: 'Enable Remote Access' });
    fireEvent.click(screen.getByLabelText(/Named Tunnel/));
    fireEvent.change(screen.getByPlaceholderText(/Cloudflare tunnel token/), { target: { value: 'eyJabc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save & Connect' }));
    expect(await screen.findByText('token refused')).toBeTruthy();
    expect(calls).toContain('/system/tunnel/token');
    expect(calls).not.toContain('/system/tunnel/enable');
  });

  it('(c) a later successful action clears the message', async () => {
    answers['/system/tunnel/enable'] = { ok: false, error: 'tunnel refused' };
    render(<PlatformTab />);
    const enable = await screen.findByRole('button', { name: 'Enable Remote Access' });
    fireEvent.click(enable);
    await screen.findByText('tunnel refused');
    answers['/system/tunnel/enable'] = { ok: true, data: {} };
    fireEvent.click(await screen.findByRole('button', { name: 'Enable Remote Access' }));
    await waitFor(() => expect(screen.queryByText('tunnel refused')).toBeNull());
  });
});
