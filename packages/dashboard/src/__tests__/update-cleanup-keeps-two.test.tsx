// ════════════════════════════════════════════════════════════════════════════
// t201 follow-up 4 — THE UPDATE CLEAN-UP KEEPS TWO BACKUPS (owner decision 21).
//
// The owner chose two backups. The server prunes to two after every update, but Settings ->
// Platform -> "Clean up old backups" sent `keep: 1` and said so on the button, so one press
// quietly threw away the second rollback target. The dashboard now asks the server how many it
// keeps (`keepDefault`) and sends exactly that; no number of its own.
// ════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: false, error: 'not in this test' }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
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

import * as api from '../lib/api';
import { PlatformTab } from '../components/settings/PlatformTab';
import { ThemeProvider } from '../themes/ThemeProvider';

const mocked = () => vi.mocked(api);

beforeEach(() => {
  resetFrames();
  mocked().listPlatformBackups.mockResolvedValue({
    ok: true,
    data: {
      count: 3, keepDefault: 2,
      backups: [
        { name: 'platform.backup-3.3.3', version: '3.3.3', mtime: '2026-10-01T00:00:00.000Z' },
        { name: 'platform.backup-3.3.2', version: '3.3.2', mtime: '2026-09-01T00:00:00.000Z' },
        { name: 'platform.backup-3.3.1', version: '3.3.1', mtime: '2026-08-01T00:00:00.000Z' },
      ],
    },
  } as never);
  mocked().cleanupPlatformBackups.mockResolvedValue({
    ok: true, data: { status: 'noop', kept: 2, message: 'nothing to do' },
  } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the backups clean-up keeps what the server keeps', () => {
  it('the button names two, and a press asks the server to keep two', async () => {
    render(<MemoryRouter><ThemeProvider><PlatformTab /></ThemeProvider></MemoryRouter>);
    const button = await screen.findByRole('button', { name: /Clean up old backups/ });
    expect(button.textContent, 'the button says how many stay').toContain('keep most recent 2');
    fireEvent.click(button);
    await waitFor(() => expect(mocked().cleanupPlatformBackups).toHaveBeenCalledTimes(1));
    expect(mocked().cleanupPlatformBackups.mock.calls[0]![0], 'the owner chose two backups (decision 21)').toBe(2);
  });

  it('the api door has no number of its own: the caller must say how many', async () => {
    const real = await vi.importActual<typeof import('../lib/api')>('../lib/api');
    expect(real.cleanupPlatformBackups.length, 'no default parameter: a default is a second decision').toBe(1);
  });
});
