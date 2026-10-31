import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: false, error: 'x' }))
      : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { Health } from '../pages/Health';

const mocked = () => vi.mocked(api);
const goodHealth = {
  ok: true,
  data: { uptime: 100, memory: { used: 1, total: 2 }, db: 'ok' },
};

beforeEach(() => { resetFrames(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('the Vitals page does not claim all is well when it has heard nothing', () => {
  it('says it cannot reach the server when every call failed', async () => {
    render(<MemoryRouter><Health /></MemoryRouter>);
    expect(await screen.findByText("Can't reach the server")).toBeTruthy();
    expect(screen.queryByText('All systems nominal')).toBeNull();
  });

  it('says the numbers are old when a later check fails', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mocked().getHealth.mockResolvedValue(goodHealth as never);
    render(<MemoryRouter><Health /></MemoryRouter>);
    await screen.findByText('All systems nominal');
    expect(screen.queryByText(/last good reading/)).toBeNull();

    mocked().getHealth.mockResolvedValue({ ok: false, error: 'down' } as never);
    await act(async () => { await vi.advanceTimersByTimeAsync(21_000); });
    expect(await screen.findByText(/Showing the last good reading from/)).toBeTruthy();
    expect(screen.queryByText('All systems nominal')).toBeNull();
  });
});
