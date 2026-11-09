// v3.5 field fix 3 (#9), owner ruling OR-FIELD3 (c): "It shouldn't be a persistent notification if it doesn't
// require the intervention of the user. It also shouldn't be red." Every owner card declares its class: an
// ACTION card keeps today's sticky card and the orb's red alert; an INFORMATIONAL card is a plain toast that
// leaves by itself and never reddens the orb. (Background progress is no card: `engine:activity`.)
// Mounted on the existing surface: the real toast queue, the real frame handler, the real card stack.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { emitFrame, resetFrames } from './helpers/frames';

const orb = vi.hoisted(() => ({
  setAlert: vi.fn(), setNoteGlyph: vi.fn(), setEmotion: vi.fn(), pulse: vi.fn(), startTask: vi.fn(), endTask: vi.fn(),
}));
vi.mock('../components/orb/OrbProvider', () => ({ useDojoOrb: () => orb }));
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

import { ToastProvider } from '../hooks/useToast';
import { PLATFORM_SENDER } from '@dojo/shared';
import { Dojo3Notifications } from '../components/Dojo3Notifications';
import { GlobalAlerts } from '../App';

const mount = () => render(
  <ToastProvider>
    <GlobalAlerts />
    <Dojo3Notifications />
  </ToastProvider>,
);
const card = (words: string, cardClass?: 'action' | 'informational') => act(() => {
  emitFrame('chat:error', { agentId: PLATFORM_SENDER, error: words, severity: 'warning', retryable: false, ...(cardClass ? { cardClass } : {}) });
});
const redAlertHeld = (): boolean => orb.setAlert.mock.calls.some((c) => c[0] === 1);

const LESSONS = "2 lessons from yesterday's rough tasks. They are in the Dreamer's report.";
const BLOCKER = 'An account connection expired. Sign in again on the Accounts page.';

beforeEach(() => {
  resetFrames();
  vi.useFakeTimers();
  for (const f of Object.values(orb)) f.mockClear();
});
afterEach(() => { vi.useRealTimers(); });

describe('an informational owner card', () => {
  it('shows its words, never reddens the orb, and leaves by itself', () => {
    mount();
    card(LESSONS, 'informational');
    expect(screen.getByText(LESSONS)).toBeTruthy();
    expect(redAlertHeld(), 'a card that needs nothing from him is never red').toBe(false);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.queryByText(LESSONS), 'it is not a persistent notification').toBeNull();
  });
});

describe('an action owner card (CONTROL: today\'s card, unchanged)', () => {
  it('declared or absent, it holds the red alert and stays', () => {
    mount();
    card(BLOCKER, 'action');
    card('A watcher has been failing.');   // a frame from before the class existed reads as action
    expect(redAlertHeld()).toBe(true);
    act(() => { vi.advanceTimersByTime(60 * 60_000); });
    expect(screen.getByText(BLOCKER)).toBeTruthy();
    expect(screen.getByText('A watcher has been failing.')).toBeTruthy();
  });
});
