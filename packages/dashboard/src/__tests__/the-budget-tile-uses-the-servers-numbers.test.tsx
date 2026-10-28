// ════════════════════════════════════════════════════════════════════════════
// THE BUDGET TILE USES THE SERVER'S NUMBERS — not the summary's period spend.
//
// `Costs.loadData` used to build the budget state from `totalSpend`, the spend
// for the selected period tab (24H/7D/30D/All). With 30D selected the Budget
// tile and "Global daily budget · spent today" showed a month of spend against a
// DAILY limit. The server now sends its own `global.spentUsd`, and per-agent
// rows carry a `spentUsd` the row renders with `toFixed(2)` — an older server
// that omits the field would throw and, with no error boundary, blank the whole
// page. This file holds both halves: the tile reads the server's figure, and a
// bare per-agent row survives.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  // The doors this file is about, and the ones the page reads alongside them.
  mocked().getCostSummary.mockResolvedValue({
    ok: true,
    data: { totalSpend: 99, dailyAvg: 3, byModel: [], byAgent: [], byTier: [] },
  } as never);
  mocked().getAgents.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getPricingSyncStatus.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().request.mockResolvedValue({ ok: false, error: 'x' } as never);
});
afterEach(() => { vi.clearAllMocks(); });

const renderCosts = async () => {
  render(<Costs />);
  await screen.findByText('Ledger');
};

describe('the budget tile uses the server’s numbers', () => {
  it('reads global spent from the server, not the summary period spend', async () => {
    mocked().getBudgets.mockResolvedValue({
      ok: true,
      data: { global: { limitUsd: 10, spentUsd: 2.5 }, agents: [] },
    } as never);
    await renderCosts();

    expect(screen.getByText('$2.50 / $10.00'), 'the server’s spent figure is shown').toBeTruthy();
    expect(
      screen.queryByText('$99.00 / $10.00'),
      'the summary’s period spend is NOT the budget',
    ).toBeNull();
  });

  it('still shows the server figure after switching to 30D', async () => {
    mocked().getBudgets.mockResolvedValue({
      ok: true,
      data: { global: { limitUsd: 10, spentUsd: 2.5 }, agents: [] },
    } as never);
    await renderCosts();

    screen.getByText('$2.50 / $10.00');
    fireEvent.click(screen.getByRole('tab', { name: '30D' }));
    await waitFor(() => expect(mocked().getBudgets.mock.calls.length).toBeGreaterThan(1));

    expect(screen.getByText('$2.50 / $10.00'), 'still the server’s figure on 30D').toBeTruthy();
    expect(screen.queryByText('$99.00 / $10.00')).toBeNull();
  });

  it('renders a named per-agent row with its own spent', async () => {
    mocked().getBudgets.mockResolvedValue({
      ok: true,
      data: {
        global: { limitUsd: 10, spentUsd: 2.5 },
        agents: [{ agentId: 'a1', agentName: 'Helper', limitUsd: 5, period: 'daily', spentUsd: 1.25 }],
      },
    } as never);
    await renderCosts();

    fireEvent.click(screen.getByRole('button', { name: '+' }));
    expect(screen.getByText('Helper')).toBeTruthy();
    expect(screen.getByText(/\$1\.25 used/)).toBeTruthy();
  });

  it('an older server that omits name/spent does not throw', async () => {
    mocked().getBudgets.mockResolvedValue({
      ok: true,
      data: {
        global: { limitUsd: 10, spentUsd: 2.5 },
        agents: [{ agentId: 'a1', limitUsd: 5, period: 'daily' }],
      },
    } as never);
    await renderCosts();

    fireEvent.click(screen.getByRole('button', { name: '+' }));
    expect(screen.getByText('a1')).toBeTruthy();
    expect(screen.getByText(/\$0\.00 used/)).toBeTruthy();
  });
});
