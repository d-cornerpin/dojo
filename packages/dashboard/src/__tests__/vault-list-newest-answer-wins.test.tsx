// The Memory page's vault list shows the newest search's answer, says when a load fails,
// and "Dream now" shows a refusal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

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

const entry = (id: string, title: string) => ({ id, title, content: title, type: 'fact', tags: [] }) as never;
const mocked = () => vi.mocked(api);

beforeEach(() => {
  resetFrames();
  mocked().getAgents.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getSetting.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().getVaultStats.mockResolvedValue({ ok: false, error: 'x' } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the memory page vault list', () => {
  it('shows the newest search even when an older answer arrives last', async () => {
    let releaseA: (v: unknown) => void = () => {};
    mocked().getVaultEntries.mockImplementation(((q: { search?: string }) => {
      if (q.search === 'a') return new Promise((res) => { releaseA = res; });
      if (q.search === 'ab') return Promise.resolve({ ok: true, data: [entry('2', 'ROW-FOR-AB')] });
      return Promise.resolve({ ok: true, data: [] });
    }) as never);
    render(<Memory />);
    const box = await screen.findByLabelText('Search vault');
    fireEvent.change(box, { target: { value: 'a' } });
    await waitFor(() => expect(mocked().getVaultEntries).toHaveBeenCalledWith(expect.objectContaining({ search: 'a' })));
    fireEvent.change(box, { target: { value: 'ab' } });
    expect(await screen.findByText('ROW-FOR-AB')).toBeTruthy();
    await act(async () => { releaseA({ ok: true, data: [entry('1', 'ROW-FOR-A')] }); });
    expect(screen.queryByText('ROW-FOR-A')).toBeNull();
    expect(screen.getByText('ROW-FOR-AB')).toBeTruthy();
  });

  it('says so, with Retry and no stale rows, when a load fails', async () => {
    mocked().getVaultEntries.mockImplementation(((q: { search?: string }) =>
      Promise.resolve(q.search === 'tax'
        ? { ok: false, error: 'boom' }
        : { ok: true, data: [entry('1', 'OLD-ROW')] })) as never);
    render(<Memory />);
    expect(await screen.findByText('OLD-ROW')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Search vault'), { target: { value: 'tax' } });
    expect(await screen.findByText(/Could not load vault entries: boom/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.queryByText('OLD-ROW')).toBeNull();
    expect(screen.queryByText(/No vault entries yet/)).toBeNull();
  });
});

describe('Dream now', () => {
  it('shows the refusal', async () => {
    mocked().getVaultEntries.mockResolvedValue({ ok: true, data: [] } as never);
    mocked().triggerDream.mockResolvedValue({ ok: false, error: 'already running' } as never);
    render(<Memory />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Dreams' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dream Now' }));
    expect(await screen.findByText('already running')).toBeTruthy();
  });
});
