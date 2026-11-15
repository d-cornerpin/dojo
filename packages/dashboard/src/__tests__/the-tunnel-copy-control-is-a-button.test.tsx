// ── THE TUNNEL COPY CONTROL IS A BUTTON, SO KEYBOARD CAN REACH IT. ────────────
//
// `RemoteAccessSettings` drew "Copy" as a `<span className="link" onClick=…>`. A span is not
// focusable and has no key handling, so a keyboard-only owner could not copy the tunnel address
// at all — the mouse was the only way in. The control must be a real `<button>`. Mounted through
// the whole Platform tab (the card is not exported); the tunnel door is the only one that answers,
// and answers ACTIVE with a URL so the Copy control is on screen.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';

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
  // The tunnel door answers ACTIVE with a URL; every other door answers failure, exactly as in
  // the failed-load smoke, so the only thing this tab is showing that matters is the Copy control.
  stub.request = vi.fn(async (path: string) =>
    path === '/system/tunnel'
      ? {
          ok: true,
          data: {
            enabled: true, mode: 'quick', status: 'active',
            url: 'https://dojo-a.trycloudflare.com', error: null,
            startedAt: 1, cloudflaredInstalled: true,
          },
        }
      : { ok: false, error: 'offline' },
  );
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
  };
});

import { PlatformTab } from '../components/settings/PlatformTab';

describe('the tunnel copy control', () => {
  it('is a real button, so a keyboard-only owner can reach it', async () => {
    render(<PlatformTab />);
    // The card starts on "Loading…" and shows the active state once the door answers.
    const copy = await screen.findByRole('button', { name: 'Copy' });
    expect(copy).toBeTruthy();
  });
});
