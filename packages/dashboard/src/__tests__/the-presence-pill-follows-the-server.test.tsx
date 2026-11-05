// v3.5 field fix 3, test-2 round. OWNER RULING (2026-11-04): a message typed on the dashboard is
// answered on the dashboard, and typing there while marked away flips presence back to in-dojo
// (server: `gateway/routes/chat.ts` submitUserMessage). The composer's presence pill read the
// state once, on mount, so after that flip it went on saying "away". It now follows the server's
// `system:presence` frame.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames, emitFrame } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, request: vi.fn(async () => ({ ok: true, data: { status: 'away', imessageConfigured: true } })) };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import { PresenceProvider, usePresence } from '../components/PresenceProvider';

function Probe() {
  const { presence } = usePresence();
  return <span data-testid="presence">{presence?.status ?? 'unknown'}</span>;
}

beforeEach(() => { resetFrames(); });

describe('the presence pill follows the server', () => {
  it('THE RED: loaded as away, then the server flips it to in-dojo; the pill says in-dojo', async () => {
    render(<PresenceProvider><Probe /></PresenceProvider>);
    await waitFor(() => expect(screen.getByTestId('presence').textContent).toBe('away'));
    act(() => { emitFrame('system:presence', { data: { status: 'in_dojo' } }); });
    expect(screen.getByTestId('presence').textContent).toBe('in_dojo');
  });
});
