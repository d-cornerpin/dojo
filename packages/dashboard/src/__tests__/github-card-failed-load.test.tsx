// The GitHub card must not sit on "Loading..." when its status load fails, must show a failed
// cancel, and must not let an older status answer put an old screen back.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', () => ({
  getGithubStatus: vi.fn(),
  cancelGithubConnect: vi.fn(),
  connectGithub: vi.fn(),
  disconnectGithub: vi.fn(),
}));
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  return { useToast: () => fakeToast().value };
});

import * as api from '../lib/api';
import { GitHubSettings } from '../components/GitHubSettings';
import { emitFrame, resetFrames } from './helpers/frames';

const m = api as unknown as Record<'getGithubStatus' | 'cancelGithubConnect', ReturnType<typeof vi.fn>>;
const status = (over: Record<string, unknown> = {}) => ({
  connected: false, login: null, scope: null, connectedAt: null, lastOkAt: null, lastError: null, reauthRequired: false,
  clientIdConfigured: true, loginInProgress: false, userCode: null, verificationUri: null, ...over,
});
const connecting = () => status({ loginInProgress: true, userCode: 'ABCD-1234', verificationUri: 'https://example.test/device' });

beforeEach(() => { resetFrames(); vi.clearAllMocks(); });

describe('GitHub card, failed and late loads', () => {
  it('a failed first load keeps the title, shows the reason and Retry; Retry recovers', async () => {
    m.getGithubStatus.mockResolvedValueOnce({ ok: false, error: 'box down' });
    render(<GitHubSettings />);
    await screen.findByText(/Could not load GitHub status: box down/);
    expect(screen.getByText('GitHub').className).toContain('scard__title');
    expect(screen.queryByText('Loading…')).toBeNull();
    m.getGithubStatus.mockResolvedValueOnce({ ok: true, data: connecting() });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('ABCD-1234');
  });

  it('an older answer landing after a newer one is ignored', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    m.getGithubStatus.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    render(<GitHubSettings />);
    m.getGithubStatus.mockResolvedValueOnce({ ok: true, data: status({ connected: true, login: 'someone-test', scope: 'public_repo' }) });
    act(() => emitFrame('github:connected', { login: 'someone-test' }));
    await screen.findByRole('button', { name: 'Disconnect' });
    await act(async () => { resolveOld({ ok: true, data: connecting() }); });
    expect(screen.queryByText('ABCD-1234')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeNull();
  });

  it('a failed cancel shows a problem line', async () => {
    m.getGithubStatus.mockResolvedValue({ ok: true, data: connecting() });
    render(<GitHubSettings />);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    m.cancelGithubConnect.mockResolvedValue({ ok: false, error: 'cancel refused by the box' });
    fireEvent.click(cancel);
    await waitFor(() => expect(document.querySelector('.note--warn')).not.toBeNull());
    expect(document.querySelector('.note--warn')!.textContent).toContain('cancel refused by the box');
  });
});
