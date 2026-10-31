// The pricing-index Refresh and the warning-threshold boxes say so when they fail.


import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the page
// mounts on its own terms and the doors this file is about are the only overrides.
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
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { Costs } from '../pages/Costs';

const mocked = () => vi.mocked(api);

beforeEach(() => {
  resetFrames();
  mocked().getCostSummary.mockResolvedValue({
    ok: true,
    data: { totalSpend: 1, dailyAvg: 1, byModel: [], byAgent: [], byTier: [] },
  } as never);
  mocked().getAgents.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getBudgets.mockResolvedValue({ ok: true, data: { global: null, agents: [] } } as never);
  mocked().getPricingSyncStatus.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().runPricingSync.mockResolvedValue({ ok: false, error: 'offline' } as never);
  mocked().request.mockImplementation((async (url: string) => {
    if (url === '/config/openrouter/credits') {
      return { ok: true, data: { total_credits: 10, total_usage: 2, balance: 8 } } as never;
    }
    if (url === '/config/openrouter/threshold') return { ok: true, data: { value: '5' } } as never;
    return { ok: false, error: 'x' } as never;
  }) as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('Costs page silent failures', () => {
  it('says so when the pricing refresh fails', async () => {
    render(<Costs />);
    await screen.findByText('Ledger');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByText('Refresh failed: offline')).toBeTruthy());
  });

  it('says so when the OpenRouter warning threshold is not a number of 0 or more', async () => {
    render(<Costs />);
    const input = await screen.findByLabelText('Warning threshold');
    fireEvent.change(input, { target: { value: '-3' } });
    fireEvent.click(within(input.closest('.srow') as HTMLElement).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Enter 0 or more.')).toBeTruthy());
  });
});
