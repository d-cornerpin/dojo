// When a dream finishes, the Memory page's Entries list reloads with the search words
// and type filter that are on screen now, not the ones from an earlier render.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames, emitFrame } from './helpers/frames';

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
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  // The real hook hands out ONE stable `subscribe` (a useCallback); the stock fake makes
  // a new one every render, which would re-subscribe the page each time and hide the defect.
  const stable = fakeUseWebSocket();
  return { useWebSocket: () => stable, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
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
import { Memory } from '../pages/Memory';

beforeEach(() => {
  resetFrames();
  vi.mocked(api).getAgents.mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(api).getSetting.mockResolvedValue({ ok: false, error: 'x' } as never);
  vi.mocked(api).getVaultStats.mockResolvedValue({ ok: false, error: 'x' } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the memory page dream refresh', () => {
  it('reloads the entries with the search words now on screen', async () => {
    render(<Memory />);
    fireEvent.change(await screen.findByLabelText('Search vault'), { target: { value: 'abc' } });
    await waitFor(() => expect(vi.mocked(api).getVaultEntries).toHaveBeenCalledWith(expect.objectContaining({ search: 'abc' })));

    vi.mocked(api).getVaultEntries.mockClear();
    await act(async () => { emitFrame('dream:complete'); });

    await waitFor(() => expect(vi.mocked(api).getVaultEntries).toHaveBeenCalled());
    expect(vi.mocked(api).getVaultEntries).toHaveBeenLastCalledWith(expect.objectContaining({ search: 'abc' }));
  });

  it('reloads the entries with the type filter now on screen', async () => {
    render(<Memory />);
    fireEvent.change(await screen.findByLabelText('Type filter'), { target: { value: 'fact' } });
    await waitFor(() => expect(vi.mocked(api).getVaultEntries).toHaveBeenCalledWith(expect.objectContaining({ type: 'fact' })));

    vi.mocked(api).getVaultEntries.mockClear();
    await act(async () => { emitFrame('dream:complete'); });

    await waitFor(() => expect(vi.mocked(api).getVaultEntries).toHaveBeenCalled());
    expect(vi.mocked(api).getVaultEntries).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'fact' }));
  });
});
