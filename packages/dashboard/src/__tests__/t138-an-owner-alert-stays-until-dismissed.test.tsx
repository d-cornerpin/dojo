// ════════════════════════════════════════════════════════════════════════════
// t138 round 2 — AN OWNER ALERT STAYS ON THE DASHBOARD UNTIL HE DISMISSES IT.
//
// Owner, 2026-10-13: "we should have dashboard banners but use our existing
// alert/notification system." Every text the Dojo sends him (`sendAlert`, the
// server's owner-notice door) also reaches the dashboard as a `chat:error` frame
// spoken by the platform rather than an agent. This file mounts the EXISTING
// notification surface — the real toast queue (`ToastProvider`), the real global
// frame handler (`GlobalAlerts`) and the real card stack (`Dojo3Notifications`) —
// pushes frames, and looks at the cards:
//
//   · the owner's card shows his words and stays — no timer takes it away, and
//     no agent recovering elsewhere sweeps it — until he presses its X;
//   · the same words while the card is up are one card; after he dismissed it,
//     the same words again are a new alert and a new card;
//   · an agent's own chat error is that agent's chat's business, not a card here;
//   · the budget's old second copy (a `cost:alert` toast that faded in 10-15 s at
//     50% and 75%) is gone: the owner card is the one budget notification.
//
// The speaker id is read from the server's own source, so the two sides cannot
// drift apart silently.
// ════════════════════════════════════════════════════════════════════════════

// RED-FIRST at f33af0e8 (+ the GlobalAlerts export only): clauses marked
// `it.fails` are the witness, failing before the fix; the fix commit flips them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { emitFrame, resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket };
});

import { ToastProvider, useToast } from '../hooks/useToast';
import { OrbProvider } from '../components/orb/OrbProvider';
import { Dojo3Notifications } from '../components/Dojo3Notifications';
import { GlobalAlerts } from '../App';

/** The server's platform speaker (`PLATFORM_SENDER`), read from its source. */
const SPEAKER = (() => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '../../../server/src/agent/v2/outbound.ts'), 'utf8',
  );
  const m = src.match(/export const PLATFORM_SENDER = '([^']+)';/);
  if (!m) throw new Error('PLATFORM_SENDER not found in the server source');
  return m[1];
})();

/** A plain error toast, posted the way the chat page posts an agent's error. */
const PlainError = () => {
  const toast = useToast();
  return <button type="button" onClick={() => toast.error('An agent error card.')}>post plain error</button>;
};

const mount = () => render(
  <OrbProvider>
    <ToastProvider>
      <GlobalAlerts />
      <PlainError />
      <Dojo3Notifications />
    </ToastProvider>
  </OrbProvider>,
);

const ownerAlert = (words: string, severity: 'warning' | 'error' = 'warning') => act(() => {
  emitFrame('chat:error', { agentId: SPEAKER, error: words, severity, retryable: false });
});
const dismissButtons = () => screen.queryAllByRole('button', { name: 'Dismiss notification' });
const BUDGET = 'Budget alert: 50% of your daily budget is used ($5.10 of $10.00 in the last 24 hours).';

beforeEach(() => {
  resetFrames();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the owner card arrives and stays until he dismisses it', () => {
  it('a platform frame becomes a card with his words; an hour later it is still there; X takes it away', () => {
    mount();
    ownerAlert(BUDGET);
    expect(screen.getByText(BUDGET)).toBeTruthy();
    act(() => { vi.advanceTimersByTime(60 * 60_000); });
    expect(screen.getByText(BUDGET), 'no timer dismisses an owner alert').toBeTruthy();
    expect(dismissButtons()).toHaveLength(1);
    fireEvent.click(dismissButtons()[0]);
    expect(screen.queryByText(BUDGET)).toBeNull();
  });

  it('an agent recovering elsewhere sweeps its own error cards, never the owner card', () => {
    mount();
    ownerAlert('Helper has been paused after repeated errors. Open the dashboard to investigate.', 'error');
    fireEvent.click(screen.getByText('post plain error'));
    expect(screen.getByText('An agent error card.')).toBeTruthy();
    act(() => { emitFrame('chat:error', { agentId: 'a-0001', error: 'Recovered.', code: 'AGENT_RECOVERED', severity: 'info' }); });
    expect(screen.queryByText('An agent error card.'), 'the sweep is live (control)').toBeNull();
    expect(screen.getByText('Helper has been paused after repeated errors. Open the dashboard to investigate.')).toBeTruthy();
  });
});

describe('one alert = one card', () => {
  it('the same words while the card is up are ONE card; after dismissal they are a new card', () => {
    mount();
    ownerAlert(BUDGET);
    ownerAlert(BUDGET);
    expect(screen.getAllByText(BUDGET)).toHaveLength(1);
    fireEvent.click(dismissButtons()[0]);
    ownerAlert(BUDGET);
    expect(screen.getAllByText(BUDGET)).toHaveLength(1);
  });

  it('two different alerts are two cards', () => {
    mount();
    ownerAlert(BUDGET);
    ownerAlert('OpenRouter balance is $2.00, at or below your $5 warning threshold.');
    expect(dismissButtons()).toHaveLength(2);
  });
});

describe('what is NOT an owner card here', () => {
  it("an agent's own chat error is not turned into a global card", () => {
    mount();
    act(() => { emitFrame('chat:error', { agentId: 'a-0001', error: 'Agent paused after repeated errors.', severity: 'error' }); });
    expect(screen.queryByText('Agent paused after repeated errors.')).toBeNull();
  });

  it('a cost:alert frame makes no card: the old fading budget toast is gone', () => {
    mount();
    act(() => { emitFrame('cost:alert', { data: { scope: 'global', percentage: 90, currentSpend: 9.2, limitUsd: 10 } }); });
    expect(dismissButtons()).toHaveLength(0);
  });
});
