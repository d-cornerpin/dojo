import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { emitFrame, resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, request: vi.fn(async () => ({ ok: true, data: { status: 'in_dojo', imessageConfigured: false } })) };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket };
});

import { PresenceProvider, usePresence } from '../components/PresenceProvider';

const Probe = () => {
  const { presence } = usePresence();
  return <div>{presence ? `status:${presence.status}` : 'status:none'}</div>;
};

beforeEach(() => { resetFrames(); });

describe('a presence change by text updates an open dashboard', () => {
  it('the frame flips the shown status without a reload', async () => {
    render(<PresenceProvider><Probe /></PresenceProvider>);
    await waitFor(() => expect(screen.getByText('status:in_dojo')).toBeTruthy());
    act(() => { emitFrame('presence:changed', { status: 'away' }); });
    expect(screen.getByText('status:away')).toBeTruthy();
  });
});
