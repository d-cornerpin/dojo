// ════════════════════════════════════════════════════════════════════════════
// A REFUSED BUDGET IS NOT SAVED — the page says "Saved" even when the server
// refused the value.
//
// Four save handlers on `Costs.tsx` throw the server's answer away and flash the
// success word: the OpenRouter/DeepSeek warning thresholds (`handleSaveThreshold`),
// `BudgetConfigTile.handleSaveGlobal` and `AgentBudgetRow.handleSave`. The server
// refuses a budget of 0 or less (`packages/server/src/gateway/routes/costs.ts`:
// 400 "limitUsd (positive number) is required"), but the page only blocks values
// below 0, so typing 0 shows "Saved" and nothing is stored. This file drives the
// honest surface: the server's error is shown, "Saved" is withheld, and a value
// that cannot be saved is refused client-side.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
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
    data: { totalSpend: 99, dailyAvg: 3, byModel: [], byAgent: [], byTier: [] },
  } as never);
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

const globalSave = () => {
  const input = screen.getByLabelText('Daily budget');
  return within(input.closest('.srow') as HTMLElement).getByRole('button', { name: 'Save' });
};

describe('a refused budget is not saved', () => {
  it('shows the server error instead of Saved when the global budget is refused', async () => {
    mocked().setGlobalBudget.mockResolvedValue({
      ok: false,
      error: 'limitUsd (positive number) is required',
    } as never);
    await renderCosts();

    fireEvent.change(screen.getByLabelText('Daily budget'), { target: { value: '20' } });
    fireEvent.click(globalSave());

    await waitFor(() => expect(screen.getByText('limitUsd (positive number) is required')).toBeTruthy());
    expect(screen.queryByText('Saved'), 'the success word is withheld on refusal').toBeNull();
  });

  it('shows Saved and sends the value when the global budget is accepted', async () => {
    mocked().setGlobalBudget.mockResolvedValue({ ok: true, data: undefined } as never);
    await renderCosts();

    fireEvent.change(screen.getByLabelText('Daily budget'), { target: { value: '20' } });
    fireEvent.click(globalSave());

    await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
    expect(mocked().setGlobalBudget).toHaveBeenCalledWith(20);
  });

  it('shows the server error instead of Saved when the threshold is refused', async () => {
    mocked().request.mockImplementation((async (
      url: string,
      opts?: { method?: string },
    ) => {
      if (url === '/config/openrouter/credits') {
        return { ok: true, data: { total_credits: 5, total_usage: 1, balance: 4 } } as never;
      }
      if (url === '/config/openrouter/threshold') {
        if (opts?.method?.toUpperCase() === 'POST') {
          return { ok: false, error: 'nope' } as never;
        }
        return { ok: true, data: { value: '5' } } as never;
      }
      return { ok: false, error: 'x' } as never;
    }) as never);
    await renderCosts();

    const input = await screen.findByLabelText('Warning threshold');
    fireEvent.click(within(input.closest('.srow') as HTMLElement).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.getByText('nope')).toBeTruthy());
    expect(screen.queryByText('Saved'), 'the success word is withheld on refusal').toBeNull();
  });
});
