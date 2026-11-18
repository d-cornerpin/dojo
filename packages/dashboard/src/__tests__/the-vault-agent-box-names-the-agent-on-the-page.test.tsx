import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { resetFrames } from './helpers/frames';

// The permissive factory the smoke floor uses, every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real, so the page
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
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: unknown }) => children };
});
// The Entries tab renders `VaultStats`, which calls `useToast()`.
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: unknown }) => children };
});

import * as api from '../lib/api';
import { Memory } from '../pages/Memory';

const mocked = () => vi.mocked(api);
const MAIN = { id: 'main-1', name: 'Agent A' };
const OTHER = { id: 'beta', name: 'Agent B' };

beforeEach(() => {
  resetFrames();
  mocked().getAgents.mockResolvedValue({ ok: true, data: [MAIN, OTHER] } as never);
  mocked().getMemoryDag.mockResolvedValue({ ok: true, data: { summaries: [], links: [] } } as never);
  mocked().getVaultStats.mockResolvedValue({ ok: true, data: { totalEntries: 0, byType: {}, permanentCount: 0, pinnedCount: 0, avgConfidence: 0, retrievedToday: 0, unprocessedArchives: 0, lastDreamAt: null } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

const openTree = async () => {
  render(<Memory />);
  fireEvent.click(await screen.findByRole('tab', { name: 'DAG' }));
};

describe('the vault agent box names the agent on the page', () => {
  it('the box and the tree both name the main agent', async () => {
    mocked().getSetting.mockResolvedValue({ ok: true, data: { key: 'primary_agent_id', value: 'beta' } } as never);
    await openTree();
    await waitFor(() => expect(mocked().getMemoryDag).toHaveBeenCalledWith('beta'));
    expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe('beta');
  });

  it('with no main agent setting, the first agent is named by both', async () => {
    mocked().getSetting.mockResolvedValue({ ok: false, error: 'x' } as never);
    await openTree();
    await waitFor(() => expect(mocked().getMemoryDag).toHaveBeenCalledWith('main-1'));
    expect((screen.getByLabelText('Agent') as HTMLSelectElement).value).toBe('main-1');
  });
});
