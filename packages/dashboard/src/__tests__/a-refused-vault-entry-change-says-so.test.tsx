// A REFUSED VAULT-ENTRY CHANGE SAYS SO — pin, permanent, obsolete and delete in
// `VaultEntryCard.tsx` (≈54-75) called `onUpdated()`/`onDeleted()` whatever the
// server answered, so a refused change re-fetched the untouched entry and looked
// like a slow success; and a refused delete never reset `deleting` (line 136,
// `disabled={deleting}`), so the card sat in its deleting look forever. This
// file drives the honest surface: the refusal shows as a toast, the parent is
// not told, and the card leaves its deleting state.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the card
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

import * as api from '../lib/api';
import type { VaultEntry } from '../lib/api';
import { VaultEntryCard } from '../components/VaultEntryCard';
import { ToastProvider, ToastContainer } from '../hooks/useToast';

const mocked = () => vi.mocked(api);

const ENTRY: VaultEntry = {
  id: 'entry-1',
  agentId: 'agent-1',
  agentName: 'Tracker',
  type: 'fact',
  content: 'The staging box restarts every Sunday night.',
  context: null,
  confidence: 0.9,
  isPermanent: false,
  tags: ['staging'],
  isPinned: false,
  isObsolete: false,
  supersededBy: null,
  retrievalCount: 0,
  lastRetrievedAt: null,
  sourceConversationId: null,
  source: 'chat',
  citation: null,
  createdAt: '2026-10-25T03:00:00.000Z',
  updatedAt: '2026-10-25T03:00:00.000Z',
};

// Mount the card in the real toast surface and press its body open, which is
// the only way to reach the Pin/Permanent/Obsolete/Delete row.
const mountOpen = (onUpdated = vi.fn(), onDeleted = vi.fn()) => {
  render(
    <ToastProvider>
      <VaultEntryCard entry={ENTRY} onUpdated={onUpdated} onDeleted={onDeleted} />
      <ToastContainer />
    </ToastProvider>,
  );
  fireEvent.click(screen.getByText(ENTRY.content));
  return { onUpdated, onDeleted };
};

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('a refused vault-entry change says so', () => {
  it('a refused pin shows the server\'s words and does not tell the parent', async () => {
    const REFUSAL = 'The vault is asleep; nothing can be changed right now.';
    mocked().updateVaultEntry.mockResolvedValue({ ok: false, error: REFUSAL } as never);
    const { onUpdated } = mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Pin' }));
    await waitFor(() => expect(mocked().updateVaultEntry).toHaveBeenCalledWith('entry-1', { pin: true }));
    await screen.findByText(REFUSAL);
    expect(onUpdated).not.toHaveBeenCalled();
  });

  it('a refused delete shows the server\'s words, does not tell the parent, and the card leaves its deleting look', async () => {
    const REFUSAL = 'This entry is being superseded right now; try again after the dream.';
    mocked().deleteVaultEntry.mockResolvedValue({ ok: false, error: REFUSAL } as never);
    const { onDeleted } = mountOpen();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocked().deleteVaultEntry).toHaveBeenCalledWith('entry-1'));
    await screen.findByText(REFUSAL);
    expect(onDeleted).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Delete' }) as HTMLButtonElement).disabled, 'the card is stuck in its deleting look').toBe(false);
  });
});
