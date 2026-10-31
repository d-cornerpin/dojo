// ════════════════════════════════════════════════════════════════════════════
// A FAILED MEMORY INJECT SAYS SO — the vault's inject panel swallows a refusal.
//
// `Memory.tsx` `handleInject` (≈187-197) calls `api.injectMemory` and acts only
// when `result.ok`. When the server refuses, the button drops back from
// "Injecting…" to "Inject", the typed text stays, and nothing appears — so a
// refused memory reads as one that silently did nothing. The Compact button right
// above already shows its `Error: …` (`compactResult`, ≈174-182). This file drives
// the honest surface: a refused inject names itself under the textarea, and the
// owner's words stay put.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the page
// mounts on its own terms and the doors this file is about are the only overrides.
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
// The vault-stats bar calls useToast; this keeps it happy without a provider.
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
import { Memory } from '../pages/Memory';

const mocked = () => vi.mocked(api);

beforeEach(() => {
  resetFrames();
  // One agent so the agent selector has something; the inject door is per-test.
  mocked().getAgents.mockResolvedValue({ ok: true, data: [{ id: 'a1', name: 'Primary' }] } as never);
  // The DAG tab is where the Inject button lives, so the graph door answers its
  // real shape rather than the permissive `data: []`.
  mocked().getMemoryDag.mockResolvedValue({ ok: true, data: { summaries: [], links: [] } } as never);
  // The vault-stats bar would render on the default Entries tab and read fields
  // the permissive `data: []` has none of; a refusal keeps it on its loading line.
  mocked().getVaultStats.mockResolvedValue({ ok: false, error: 'x' } as never);
});
afterEach(() => { vi.clearAllMocks(); });

// Mount the page, move to the DAG tab, and open the inject panel; return its textarea.
const openInjectPanel = () => {
  render(<Memory />);
  fireEvent.click(screen.getByRole('tab', { name: 'DAG' }));
  fireEvent.click(screen.getByRole('button', { name: 'Inject Memory' }));
  return screen.getByPlaceholderText(/Enter memory content/i);
};

describe('a failed memory inject says so', () => {
  it('names the refusal under the textarea and keeps the owner\'s words', async () => {
    mocked().injectMemory.mockResolvedValue({ ok: false, error: 'nope' } as never);
    const textarea = openInjectPanel();

    fireEvent.change(textarea, { target: { value: 'remember this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inject' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('nope');
    expect(textarea.value).toBe('remember this');
  });

  it('a successful inject closes the panel and shows no alert', async () => {
    mocked().injectMemory.mockResolvedValue({ ok: true, data: {} } as never);
    const textarea = openInjectPanel();

    fireEvent.change(textarea, { target: { value: 'remember this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Inject' }));

    await waitFor(() => expect(screen.queryByPlaceholderText(/Enter memory content/i)).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
