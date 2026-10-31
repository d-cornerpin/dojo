// Money is printed in one place, so a negative balance can't lose its sign, a
// thousand can't lose its comma, and a sub-cent spend can't read as $0.00.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, type ReactElement } from 'react';
import { render, screen } from '@testing-library/react';
import { resetFrames } from './helpers/frames';
import { formatUsd } from '../lib/money';

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

describe('formatUsd', () => {
  it('puts the sign before the dollar sign for a negative balance', () => {
    expect(formatUsd(-3.2)).toBe('-$3.20');
  });
  it('groups thousands with a comma', () => {
    expect(formatUsd(12345.678)).toBe('$12,345.68');
  });
  it('shows a sub-cent spend as <$0.01, not $0.00', () => {
    expect(formatUsd(0.004)).toBe('<$0.01');
  });
  it('shows no spend or an absent value as $0.00', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(null)).toBe('$0.00');
  });
  it('keeps an ordinary amount to two decimals', () => {
    expect(formatUsd(1.5)).toBe('$1.50');
  });
});

// The OpenRouter balance tile is already mounted by 8102 and a-refused-budget, so
// the render case below drives that same tile with a negative balance.
describe('the OpenRouter balance tile prints a negative balance', () => {
  beforeEach(() => {
    resetFrames();
    mocked().getCostSummary.mockResolvedValue({
      ok: true,
      data: { totalSpend: 1, dailyAvg: 1, byModel: [], byAgent: [], byTier: [] },
    } as never);
    mocked().getAgents.mockResolvedValue({ ok: true, data: [] } as never);
    mocked().getPricingSyncStatus.mockResolvedValue({ ok: false, error: 'x' } as never);
    mocked().getBudgets.mockResolvedValue({ ok: true, data: { global: null, agents: [] } } as never);
    mocked().runPricingSync.mockResolvedValue({ ok: false, error: 'x' } as never);
    mocked().request.mockImplementation((async (url: string) => {
      if (url === '/config/openrouter/credits') {
        return { ok: true, data: { total_credits: 1, total_usage: 1, balance: -3.2 } } as never;
      }
      if (url === '/config/openrouter/threshold') {
        return { ok: true, data: { value: '5' } } as never;
      }
      return { ok: false, error: 'x' } as never;
    }) as never);
  });
  afterEach(() => { vi.clearAllMocks(); });

  it('prints a negative balance as -$3.20, not $-3.20', async () => {
    render(createElement(Costs));
    expect(await screen.findByText('-$3.20')).toBeTruthy();
  });
});
