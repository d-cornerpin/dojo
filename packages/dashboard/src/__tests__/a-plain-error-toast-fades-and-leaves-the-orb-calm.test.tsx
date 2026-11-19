// Mounted on the existing surface: the real toast queue, the real frame handler, the real card stack.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
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

import { ToastProvider, useToast } from '../hooks/useToast';
import { Dojo3Notifications } from '../components/Dojo3Notifications';

const Buttons = () => {
  const toast = useToast();
  return (
    <>
      <button type="button" onClick={() => toast.error('The save did not go through.')}>plain</button>
      <button type="button" onClick={() => toast.addActionToast({ title: '', message: 'Sign in again on the Accounts page.', actions: [], dedupeKey: 'k1', level: 'error' })}>action</button>
    </>
  );
};
const mount = () => render(<ToastProvider><Buttons /><Dojo3Notifications /></ToastProvider>);
const redAlertHeld = (): boolean => orb.setAlert.mock.calls.some((c) => c[0] === 1);

beforeEach(() => { resetFrames(); vi.useFakeTimers(); for (const f of Object.values(orb)) f.mockClear(); });
afterEach(() => { vi.useRealTimers(); });

describe('a plain error toast', () => {
  it('shows, never reddens the orb, and leaves after 15 seconds', () => {
    mount();
    fireEvent.click(screen.getByText('plain'));
    expect(screen.getByText('The save did not go through.')).toBeTruthy();
    expect(redAlertHeld()).toBe(false);
    act(() => { vi.advanceTimersByTime(15_001); });
    expect(screen.queryByText('The save did not go through.')).toBeNull();
  });
  it('is amber, not coral', () => {
    mount();
    fireEvent.click(screen.getByText('plain'));
    expect(screen.getByText('The save did not go through.').closest('.dojo3-note')!.className).toContain('dojo3-note--warning');
  });
  it('CONTROL: a card that needs him stays and holds the red', () => {
    mount();
    fireEvent.click(screen.getByText('action'));
    expect(redAlertHeld()).toBe(true);
    act(() => { vi.advanceTimersByTime(60 * 60_000); });
    expect(screen.getByText('Sign in again on the Accounts page.')).toBeTruthy();
  });
});
