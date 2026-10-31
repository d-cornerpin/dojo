// The Plaud card must not sit on "Loading..." when its first load fails, must not claim a
// cancel that failed, and must not let an older status answer undo a newer one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', () => ({
  getPlaudStatus: vi.fn(),
  cancelPlaudConnect: vi.fn(),
  connectPlaud: vi.fn(),
  disconnectPlaud: vi.fn(),
}));
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  (globalThis as { __plaudToast?: typeof stub }).__plaudToast = stub;
  return { useToast: () => stub.value };
});

import * as api from '../lib/api';
import { PlaudSettings } from '../components/PlaudSettings';
import { emitFrame, resetFrames } from './helpers/frames';

const m = api as unknown as Record<'getPlaudStatus' | 'cancelPlaudConnect', ReturnType<typeof vi.fn>>;
const toasts = () => (globalThis as unknown as { __plaudToast: { calls: Array<{ level: string; message: string }> } }).__plaudToast.calls;
const status = (over: Record<string, unknown> = {}) => ({
  connected: false, reauthRequired: false, email: null, connectedAt: null, loginInProgress: false, loginUrl: null, ...over,
});

beforeEach(() => { resetFrames(); vi.clearAllMocks(); toasts().length = 0; });

describe('Plaud card, failed and late loads', () => {
  it('(a) a failed first load shows the reason and Retry, never "Loading..."; Retry recovers', async () => {
    m.getPlaudStatus.mockResolvedValueOnce({ ok: false, error: 'box down' });
    render(<PlaudSettings />);
    await screen.findByText(/Could not load Plaud status: box down/);
    expect(screen.queryByText('Loading…')).toBeNull();
    m.getPlaudStatus.mockResolvedValueOnce({ ok: true, data: status() });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('button', { name: 'Connect Plaud' });
  });

  it('(b) a failed cancel says so and the card stays on connecting', async () => {
    m.getPlaudStatus.mockResolvedValue({ ok: true, data: status({ loginInProgress: true, loginUrl: 'https://example.test/login' }) });
    render(<PlaudSettings />);
    const cancel = await screen.findByRole('button', { name: 'Cancel' });
    m.cancelPlaudConnect.mockResolvedValue({ ok: false, error: 'no answer' });
    fireEvent.click(cancel);
    await waitFor(() => expect(toasts().some((t) => t.level === 'error' && t.message.includes('Cancel failed: no answer'))).toBe(true));
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeNull();
    expect(toasts().some((t) => t.message.includes('cancelled'))).toBe(false);
  });

  it('(c) an older answer landing after a newer one is ignored', async () => {
    let resolveOld: (v: unknown) => void = () => {};
    m.getPlaudStatus.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    render(<PlaudSettings />);
    m.getPlaudStatus.mockResolvedValueOnce({ ok: true, data: status({ connected: true, email: 'someone@example.test' }) });
    act(() => emitFrame('plaud:connected', { email: 'someone@example.test' }));
    await screen.findByText('someone@example.test');
    await act(async () => { resolveOld({ ok: true, data: status({ loginInProgress: true, loginUrl: 'https://example.test/login' }) }); });
    expect(screen.queryByText(/Starting Plaud login/)).toBeNull();
    expect(screen.queryByText('Connected')).not.toBeNull();
  });
});
