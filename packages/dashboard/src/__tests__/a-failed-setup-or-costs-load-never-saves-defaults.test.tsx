// The setup wizard steps and the cost warning thresholds follow the same rule as every other editor:
// a failed read of the saved value shows a plain message with Retry, and no Save.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const fns = vi.hoisted(() => ({
  getSetting: vi.fn(), setSetting: vi.fn(), getModels: vi.fn(), getDreamingConfig: vi.fn(), updateDreamingConfig: vi.fn(),
  request: vi.fn(), getAgent: vi.fn(),
}));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, ...fns };
});
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));

import { PMAgentStep, DreamerStep, IMessageStep } from '../pages/Setup';
import { OpenRouterBudget, DeepSeekBudget } from '../pages/Costs';

const FAIL = { ok: false, error: 'down' };
const ok = (data: unknown) => ({ ok: true, data });

beforeEach(() => {
  for (const f of Object.values(fns)) f.mockReset();
  fns.getModels.mockResolvedValue(ok([]));
  fns.request.mockResolvedValue(ok({}));
});

describe('setup steps', () => {
  it('PM step: a failed read of the saved name/model offers Retry and no Save', async () => {
    fns.getSetting.mockResolvedValue(FAIL);
    render(<PMAgentStep />);
    await screen.findByText('Retry');
    expect(screen.queryByText(/Save/)).toBeNull();
    expect(fns.setSetting).not.toHaveBeenCalled();
  });
  it('Dreamer step: a failed config read offers Retry and no Save', async () => {
    fns.getDreamingConfig.mockResolvedValue(FAIL);
    render(<DreamerStep />);
    await screen.findByText('Retry');
    expect(fns.updateDreamingConfig).not.toHaveBeenCalled();
  });
  it('iMessage step: a failed read offers Retry and writes nothing', async () => {
    fns.getSetting.mockResolvedValue(FAIL);
    render(<MemoryRouter><IMessageStep /></MemoryRouter>);
    await screen.findByText('Retry');
    expect(fns.setSetting).not.toHaveBeenCalled();
  });
});

describe('cost warning thresholds', () => {
  it.each([['OpenRouter', OpenRouterBudget, '/config/openrouter/credits', '/config/openrouter/threshold', { total_credits: 10, total_usage: 1, balance: 9 }],
    ['DeepSeek', DeepSeekBudget, '/config/deepseek/balance', '/config/deepseek/threshold', { currency: 'USD', balance: 9, granted_balance: 0, topped_up_balance: 9, is_available: true }]])(
    '%s: a failed threshold read is not shown as 5',
    async (_n, Comp, balancePath, thresholdPath, balance) => {
      fns.request.mockImplementation(async (path: string) => path === balancePath ? ok(balance) : path === thresholdPath ? FAIL : ok({}));
      const C = Comp as () => JSX.Element;
      render(<C />);
      await screen.findByText(/Could not load the warning threshold/);
      expect(screen.queryByLabelText('Warning threshold')).toBeNull();
    });
});
