// ════════════════════════════════════════════════════════════════════════════
// THE COSTS PAGE IGNORES A LATE ANSWER FOR AN OLD PERIOD — switching tabs fast
// can leave the newer tab showing the older period's totals.
//
// `Costs.tsx` `loadData` (≈538-571) awaits `getCostSummary(period)` and then sets
// the totals with no check that the period is still the selected one. So a slow
// answer for an older period (7D) can land after a newer one (30D) and overdraw
// the page: the tab says 30D but every total, row and "most expensive" figure is
// the 7-day number. This file drives the honest surface: a stale answer is ignored
// so the newer period's totals stay put.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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

// The slow 7-day answer, held until the test lets it resolve.
let slow7d: ((v: unknown) => void) | null = null;

beforeEach(() => {
  resetFrames();
  slow7d = null;
  mocked().getCostSummary.mockImplementation((period: string) =>
    period === '7d'
      ? new Promise((res) => { slow7d = res; })
      : Promise.resolve({ ok: true, data: { totalSpend: period === '30d' ? 30 : 5, dailyAvg: 1, byModel: [], byAgent: [], byTier: [] } }),
  );
  mocked().getAgents.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getPricingSyncStatus.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().request.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().getBudgets.mockResolvedValue({
    ok: true,
    data: { global: { limitUsd: 10, spentUsd: 1 }, agents: [] },
  } as never);
});
afterEach(() => { vi.clearAllMocks(); });

const renderCosts = async () => {
  render(<Costs />);
  await screen.findByText('Ledger');
};

describe('the costs page ignores a late answer for an old period', () => {
  it('a slow answer for the old period does not replace the newer period\'s totals', async () => {
    await renderCosts();

    fireEvent.click(screen.getByRole('tab', { name: '7D' }));
    await waitFor(() => expect(slow7d).not.toBeNull());

    fireEvent.click(screen.getByRole('tab', { name: '30D' }));
    await waitFor(() => expect(screen.getAllByText('$30.00').length).toBeGreaterThan(0));

    await act(async () => {
      slow7d!({ ok: true, data: { totalSpend: 7, dailyAvg: 1, byModel: [], byAgent: [], byTier: [] } });
    });

    expect(screen.queryByText('$7.00'), 'the 7-day answer redrew the 30-day tab').toBeNull();
    expect(screen.getAllByText('$30.00').length).toBeGreaterThan(0);
  });
});
