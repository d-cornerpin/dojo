// ════════════════════════════════════════════════════════════════════════════
// A BLANK BUDGET REMOVES THE LIMIT: "Blank or 0 means no limit."
//
// The server removes a budget when it is sent `null`, but the Costs page never
// sent one: the global Save button was disabled on an empty field and both save
// handlers refused 0 client-side, so an owner could not go back to unlimited.
// This file drives the honest surface: an emptied field or a 0 sends `null`, a
// negative is refused on the page, and a missing global limit reads "No limit".
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
  mocked().setGlobalBudget.mockResolvedValue({ ok: true, data: undefined } as never);
  mocked().setAgentBudget.mockResolvedValue({ ok: true, data: undefined } as never);
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

describe('a blank budget removes the limit', () => {
  it('an emptied global limit is sent as no limit', async () => {
    await renderCosts();

    fireEvent.change(screen.getByLabelText('Daily budget'), { target: { value: '' } });
    fireEvent.click(globalSave());

    await waitFor(() => expect(mocked().setGlobalBudget).toHaveBeenCalledWith(null));
  });

  it('a zero global limit is sent as no limit', async () => {
    await renderCosts();

    fireEvent.change(screen.getByLabelText('Daily budget'), { target: { value: '0' } });
    fireEvent.click(globalSave());

    await waitFor(() => expect(mocked().setGlobalBudget).toHaveBeenCalledWith(null));
  });

  it('with no global limit the tile says No limit', async () => {
    mocked().getBudgets.mockResolvedValue({ ok: true, data: { global: null, agents: [] } } as never);
    await renderCosts();

    expect(screen.queryByText(/^Limit:/)).toBeNull();
  });

  it('an emptied agent limit is sent as no limit', async () => {
    mocked().getBudgets.mockResolvedValue({
      ok: true,
      data: {
        global: { limitUsd: 10, spentUsd: 1 },
        agents: [{ agentId: 'a1', agentName: 'Helper', limitUsd: 5, period: 'daily', spentUsd: 1 }],
      },
    } as never);
    await renderCosts();

    fireEvent.click(screen.getByRole('button', { name: '+' }));
    fireEvent.change(screen.getByLabelText('Helper budget'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set' }));

    await waitFor(() => expect(mocked().setAgentBudget).toHaveBeenCalledWith('a1', null, 'daily'));
  });

  it('a negative global limit is refused on the page', async () => {
    await renderCosts();

    fireEvent.change(screen.getByLabelText('Daily budget'), { target: { value: '-3' } });
    fireEvent.click(globalSave());

    await waitFor(() => expect(screen.getByText('Enter an amount, or leave it blank for no limit.')).toBeTruthy());
    expect(mocked().setGlobalBudget).not.toHaveBeenCalled();
  });
});
