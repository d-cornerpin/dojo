// ════════════════════════════════════════════════════════════════════════════
// THE VITALS TEST MESSAGE SAYS HOW IT WENT — code sweep C/s11 F20.
//
// `pages/Health.tsx`'s `handleSendTest` threw the answer away: on a failed send
// (bridge down, Automation permission denied) the owner's text was erased and
// nothing said the message did not go; on a successful one there was no
// confirmation either. The smoke floor renders the page happy-path-only, so
// neither half was ever observed. This is the clause per half: a failed send
// keeps the text and shows the bridge's reason; a sent message is confirmed and
// the box empties.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the page
// mounts on its own terms and the ONE door this file is about is the only thing
// that varies.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
    ToastContainer: () => null,
  };
});

import * as api from '../lib/api';
import { Health } from '../pages/Health';

const mocked = () => vi.mocked(api);

beforeEach(() => {
  resetFrames();
  // Every door the Vitals page and its embedded Healer/Watcher cards read
  // answers something that draws the card, so the send below is the only
  // thing under test.
  mocked().getHealth.mockResolvedValue({ ok: true, data: { uptime: 5, agents: 1, db: 'ok', memory: { used: 100, total: 1000 } } } as never);
  mocked().getLogs.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getProviderHealth.mockResolvedValue({ ok: true, data: { providers: [] } } as never);
  mocked().getWatchdogStatus.mockResolvedValue({ ok: true, data: { running: true, lastHeartbeat: null, lastAlert: null } } as never);
  mocked().getIMBridgeStatus.mockResolvedValue({ ok: true, data: { enabled: true, connected: true, ownerAddress: '+15550100' } } as never);
  mocked().getResources.mockResolvedValue({ ok: true, data: { memory: { used: 1, total: 2, percentage: 50 }, cpu: {}, ollama: null } } as never);
  mocked().getHealerProposals.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getHealerActions.mockResolvedValue({ ok: true, data: [] } as never);
  mocked().getWatcherStatus.mockResolvedValue({ ok: false, error: 'x' } as never);
  mocked().request.mockResolvedValue({ ok: false, error: 'x' } as never);
});
afterEach(() => { vi.clearAllMocks(); });

/** Mounts Vitals and hands back the bridge's test-message box once drawn. */
async function mountVitals(): Promise<HTMLInputElement> {
  render(
    <MemoryRouter>
      <Health />
    </MemoryRouter>,
  );
  return await screen.findByPlaceholderText('Test message...');
}

describe('the vitals test message says how it went', () => {
  it('⚠ a failed send keeps the text and shows the bridge’s reason', async () => {
    mocked().sendTestIMessage.mockResolvedValue({ ok: false, error: 'Messages is not allowed to be controlled' });
    const box = await mountVitals();

    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText('Messages is not allowed to be controlled');
    expect(box.value, 'the owner’s text survives the failed send').toBe('hello');
  });

  it('⚠ a sent message is confirmed and the box empties', async () => {
    mocked().sendTestIMessage.mockResolvedValue({ ok: true, data: undefined });
    const box = await mountVitals();

    fireEvent.change(box, { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await screen.findByText('Sent.');
    expect(box.value).toBe('');
    // The typed To box carries the send: it started at the owner's own address.
    expect(mocked().sendTestIMessage).toHaveBeenCalledWith('+15550100', 'hello');
  });

  it('⚠ the To box starts with the owner’s own address and the owner can change it', async () => {
    const box = await mountVitals();
    const to = await screen.findByLabelText('Send the test to');
    expect((to as HTMLInputElement).value).toBe('+15550100');

    fireEvent.change(to, { target: { value: 'friend@example.test' } });
    fireEvent.change(box, { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(mocked().sendTestIMessage).toHaveBeenCalledWith('friend@example.test', 'hi'));
  });
});
