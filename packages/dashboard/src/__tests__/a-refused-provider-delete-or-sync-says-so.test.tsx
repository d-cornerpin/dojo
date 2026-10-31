// ════════════════════════════════════════════════════════════════════════════
// A REFUSED PROVIDER DELETE OR SYNC SAYS SO — `ProvidersTab.handleDelete` only
// acted on `result.ok`, so a refused delete left the card on screen after the
// owner had already confirmed the dialog, without one word about why; and
// `handleSyncModels` threw the `validateProvider` answer away, so a failed sync
// just dropped the button back to "Sync Models and Pricing" as if it had worked.
// A refusal must toast the server's own words; an accepted sync reloads the list.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The permissive factory — every exported FUNCTION answers `{ ok: true, data: [] }`,
// every exported constant stays real — so the tab mounts on its own terms and the
// two doors this file is about are the only overrides.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  return stub;
});

import * as api from '../lib/api';
import { ToastProvider, ToastContainer } from '../hooks/useToast';
import { ProvidersTab } from '../components/settings/ProvidersTab';

const PROVIDER = {
  id: 'local-box',
  name: 'Local Box',
  type: 'ollama',
  authType: 'none',
  behavesLike: null,
  isValidated: true,
  firstChunkTimeoutMs: null,
  streamIdleTimeoutMs: null,
  measuredPrefillTokensPerSec: null,
} as never;

const renderTab = () => render(
  <ToastProvider>
    <ProvidersTab />
    <ToastContainer />
  </ToastProvider>,
);

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.mocked(api.getProviders).mockResolvedValue({ ok: true, data: [PROVIDER] } as never);
  vi.mocked(api.deleteProvider).mockResolvedValue({ ok: false, error: 'in use' } as never);
  vi.mocked(api.validateProvider).mockResolvedValue({ ok: false, error: 'key rejected' } as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('a refused provider delete or sync says so', () => {
  it('a refused delete toasts the server\'s words and keeps the card', async () => {
    renderTab();
    await screen.findByText('Local Box');

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByText('in use')).toBeTruthy());
    expect(screen.getByText('Local Box')).toBeTruthy();
  });

  it('a refused sync toasts the server\'s words', async () => {
    renderTab();
    await screen.findByText('Local Box');

    fireEvent.click(screen.getByRole('button', { name: 'Sync Models and Pricing' }));

    await waitFor(() => expect(screen.getByText('key rejected')).toBeTruthy());
  });
});
