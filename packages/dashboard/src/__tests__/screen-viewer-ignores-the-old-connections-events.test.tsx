// noVNC reports a close on the OLD connection object some time after Reconnect has started a new
// one. That late event must not cancel the new attempt's timeout or flip the screen to an error.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FakeRfb } from './helpers/fake-rfb';

vi.mock('@novnc/novnc/core/rfb.js', async () => ({ default: (await import('./helpers/fake-rfb')).FakeRfb }));
vi.mock('../components/RightDockProvider', () => ({ useRightDock: () => ({ close: vi.fn() }) }));
vi.mock('../lib/api', () => ({
  getSavedVncPassword: vi.fn(async () => ({ ok: true, data: { password: null } })),
  saveVncPassword: vi.fn(),
  forgetVncPassword: vi.fn(),
}));

import { ScreenShareViewer } from '../components/ScreenShareViewer';

beforeEach(() => { FakeRfb.reset(); vi.useFakeTimers({ shouldAdvanceTime: true }); });
afterEach(() => { vi.useRealTimers(); });

describe('Reconnect', () => {
  it('ignores the old connection\'s late close and still times the new attempt out', async () => {
    render(<ScreenShareViewer />);
    await waitFor(() => expect(FakeRfb.instances.length).toBe(1));
    const old = FakeRfb.last;
    act(() => old.fire('connect'));
    act(() => old.fire('disconnect', { clean: true }));
    fireEvent.click(await screen.findByText('Reconnect'));
    await waitFor(() => expect(FakeRfb.instances.length).toBe(2));

    act(() => old.fire('disconnect', { clean: false }));
    act(() => old.fire('securityfailure', { reason: 'late' }));
    expect(screen.getByText('Connecting...')).toBeTruthy();
    expect(screen.queryByText(/closed before it could log in/i)).toBeNull();

    act(() => { vi.advanceTimersByTime(20_000); });
    await waitFor(() => expect(screen.getAllByText(/Could not reach the screen-sharing service/).length).toBeGreaterThan(0));
  });
});
