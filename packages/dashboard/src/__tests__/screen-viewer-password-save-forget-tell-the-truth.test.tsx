// "Save this password" and "Forget password" must report the server's answer: a refused forget
// keeps the button and says why; a refused save says the password was not saved.
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

beforeEach(() => {
  FakeRfb.reset();
  mocked().getSavedVncPassword.mockReset().mockResolvedValue({ ok: true, data: { password: null } } as never);
  mocked().saveVncPassword.mockReset().mockResolvedValue({ ok: true, data: {} } as never);
  mocked().forgetVncPassword.mockReset().mockResolvedValue({ ok: true, data: {} } as never);
});

const connectWithSaved = async () => {
  mocked().getSavedVncPassword.mockResolvedValue({ ok: true, data: { password: 'kept' } } as never);
  render(<ScreenShareViewer />);
  await waitFor(() => expect(FakeRfb.instances.length).toBe(1));
  act(() => FakeRfb.last.fire('connect'));
  return screen.findByText('Forget password');
};

describe('Forget password', () => {
  it('stays, with the reason, when the server refuses', async () => {
    mocked().forgetVncPassword.mockResolvedValue({ ok: false, error: 'vault locked' } as never);
    fireEvent.click(await connectWithSaved());
    expect(await screen.findByText(/vault locked/)).toBeTruthy();
    expect(screen.getByText('Forget password')).toBeTruthy();
  });
  it('goes away when the server agrees', async () => {
    fireEvent.click(await connectWithSaved());
    await waitFor(() => expect(screen.queryByText('Forget password')).toBeNull());
  });
});

describe('Save this password', () => {
  it('says so when the save was refused, and does not offer Forget', async () => {
    mocked().saveVncPassword.mockResolvedValue({ ok: false, error: 'disk full' } as never);
    render(<ScreenShareViewer />);
    await waitFor(() => expect(FakeRfb.instances.length).toBe(1));
    act(() => FakeRfb.last.fire('credentialsrequired', { types: ['password'] }));
    fireEvent.change(await screen.findByPlaceholderText('VNC password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Connect'));
    act(() => FakeRfb.last.fire('connect'));
    expect(await screen.findByText(/could not be saved: disk full/)).toBeTruthy();
    expect(screen.queryByText('Forget password')).toBeNull();
  });
});
