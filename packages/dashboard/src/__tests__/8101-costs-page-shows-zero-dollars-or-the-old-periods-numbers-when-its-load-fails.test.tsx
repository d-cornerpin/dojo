// A failed cost request is said out loud: no "$0.00" as if real, and the
// previous period's figures never stay under the new tab.


import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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

import * as api from '../lib/api';
import { Costs } from '../pages/Costs';

const mocked = () => vi.mocked(api);

const okSummary = (totalSpend: number) => ({
  ok: true,
  data: { totalSpend, dailyAvg: 3, byModel: [], byAgent: [], byTier: [] },
});

beforeEach(() => {
  resetFrames();
  mocked().getAgents.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getPricingSyncStatus.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().request.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().getBudgets.mockResolvedValue({ ok: true, data: { global: null, agents: [] } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

const totalSpendValue = () =>
  (screen.getByText('Total Spend').parentElement as HTMLElement).querySelector('.stat__value')!.textContent;

describe('the Costs page when its load fails', () => {
  it('shows the error and not $0.00 when the first load fails', async () => {
    mocked().getCostSummary.mockResolvedValue({ ok: false, error: 'db busy' } as never);
    render(<Costs />);
    await screen.findByText('Ledger');
    expect(screen.getByText(/db busy/)).toBeTruthy();
    expect(totalSpendValue()).not.toBe('$0.00');
  });

  it('drops the old period figure when the next period fails', async () => {
    mocked().getCostSummary.mockResolvedValueOnce(okSummary(7) as never);
    render(<Costs />);
    await screen.findByText('$7.00');
    mocked().getCostSummary.mockResolvedValue({ ok: false, error: 'db busy' } as never);
    fireEvent.click(screen.getByRole('tab', { name: '30D' }));
    await waitFor(() => expect(screen.getByText(/db busy/)).toBeTruthy());
    expect(screen.queryByText('$7.00')).toBeNull();
  });
});
