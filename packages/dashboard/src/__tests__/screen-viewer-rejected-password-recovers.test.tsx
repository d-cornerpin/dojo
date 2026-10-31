// noVNC does not ask for credentials a second time after a wrong password: it reports a security
// failure and closes. The screen viewer must therefore forget a rejected SAVED password on that
// signal, say so, and show the password box again on Reconnect; a rejected TYPED password must
// say so and let the owner type again.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { FakeRfb } from './helpers/fake-rfb';

vi.mock('@novnc/novnc/core/rfb.js', async () => ({ default: (await import('./helpers/fake-rfb')).FakeRfb }));
vi.mock('../components/RightDockProvider', () => ({ useRightDock: () => ({ close: vi.fn() }) }));
vi.mock('../lib/api', () => ({
  getSavedVncPassword: vi.fn(),
  saveVncPassword: vi.fn(),
  forgetVncPassword: vi.fn(),
}));

import * as api from '../lib/api';
import { ScreenShareViewer } from '../components/ScreenShareViewer';

const mocked = () => vi.mocked(api);
const passwordOnly = { types: ['password'] };

beforeEach(() => {
  FakeRfb.reset();
  mocked().getSavedVncPassword.mockReset().mockResolvedValue({ ok: true, data: { password: null } } as never);
  mocked().saveVncPassword.mockReset().mockResolvedValue({ ok: true, data: {} } as never);
  mocked().forgetVncPassword.mockReset().mockResolvedValue({ ok: true, data: {} } as never);
});

const connectedRfb = async () => { await waitFor(() => expect(FakeRfb.instances.length).toBeGreaterThan(0)); return FakeRfb.last; };

describe('a rejected saved VNC password', () => {
  it('is forgotten, said so, and Reconnect shows the password box instead of re-sending it', async () => {
    mocked().getSavedVncPassword.mockResolvedValue({ ok: true, data: { password: 'old-secret' } } as never);
    render(<ScreenShareViewer />);
    const first = await connectedRfb();
    act(() => first.fire('credentialsrequired', passwordOnly));
    expect(first.sent).toEqual([{ password: 'old-secret' }]);

    act(() => first.fire('securityfailure', { reason: 'Authentication failed' }));
    await waitFor(() => expect(mocked().forgetVncPassword).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText(/saved password no longer works/i).length).toBeGreaterThan(0);

    // The vault no longer holds it, so the next connect finds nothing to auto-fill.
    mocked().getSavedVncPassword.mockResolvedValue({ ok: true, data: { password: null } } as never);
    fireEvent.click(screen.getByText('Reconnect'));
    await waitFor(() => expect(FakeRfb.instances.length).toBe(2));
    act(() => FakeRfb.last.fire('credentialsrequired', passwordOnly));
    expect(FakeRfb.last.sent).toEqual([]);
    expect(screen.getByPlaceholderText('VNC password')).toBeTruthy();
  });
});

describe('a rejected typed VNC password', () => {
  it('says it was incorrect and lets the owner type again', async () => {
    render(<ScreenShareViewer />);
    const first = await connectedRfb();
    act(() => first.fire('credentialsrequired', passwordOnly));
    fireEvent.change(await screen.findByPlaceholderText('VNC password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByText('Connect'));
    expect(first.sent).toEqual([{ password: 'wrong' }]);

    act(() => first.fire('securityfailure', { reason: 'Authentication failed' }));
    expect(screen.getAllByText(/incorrect password/i).length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Reconnect'));
    await waitFor(() => expect(FakeRfb.instances.length).toBe(2));
    act(() => FakeRfb.last.fire('credentialsrequired', passwordOnly));
    expect(await screen.findByPlaceholderText('VNC password')).toBeTruthy();
    expect(screen.getAllByText(/incorrect password/i).length).toBeGreaterThan(0);
  });
});

describe('the error screen', () => {
  it('offers "Forget password" while a saved password is still held', async () => {
    mocked().getSavedVncPassword.mockResolvedValue({ ok: true, data: { password: 'kept' } } as never);
    render(<ScreenShareViewer />);
    const first = await connectedRfb();
    await waitFor(() => expect(mocked().getSavedVncPassword).toHaveBeenCalled());
    act(() => first.fire('disconnect', { clean: false }));
    expect(await screen.findByText('Forget password')).toBeTruthy();
  });
});
