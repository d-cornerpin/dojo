// ════════════════════════════════════════════════════════════════════════════
// A PROVIDER THAT FAILS ITS FIRST CHECK IS STILL A PROVIDER — THE LIST MUST SAY SO.
//
// `AddProviderForm` stores the provider FIRST and validates after. Only the valid
// branch reloads the list, so a wrong key left the new provider in the database and
// invisible in the list behind the form — until a page reload. Only the network door
// is replaced; the tab is mounted for real.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const list = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const added = {
    id: 'openai', name: 'OpenAI', type: 'openai', baseUrl: null, authType: 'api_key',
    behavesLike: null, firstChunkTimeoutMs: null, streamIdleTimeoutMs: null,
    prefillTokensPerSec: null, measuredPrefillTokensPerSec: null, isValidated: false,
  };
  return {
    ...actual,
    // The first read sees an empty setup; every read after the create sees the row
    // the fake server stored.
    getProviders: vi.fn(async () => (++list.calls === 1 ? { ok: true, data: [] } : { ok: true, data: [added] })),
    createProvider: vi.fn(async () => ({ ok: true, data: {} })),
    validateProvider: vi.fn(async () => ({ ok: true, data: { valid: false } })),
  };
});
vi.mock('../components/settings/PlatformTab', () => ({ AgentSdkSetup: () => null }));

import * as api from '../lib/api';
import { ToastProvider } from '../hooks/useToast';
import { ProvidersTab } from '../components/settings/ProvidersTab';

// The tab names refusals through the toast, so it needs the provider the app gives it.
const renderTab = () => render(
  <ToastProvider>
    <ProvidersTab />
  </ToastProvider>,
);

// Fill the add form the way the owner does: the openai preset, a key the fake
// server will refuse, and submit.
const addOpenaiThatFailsItsCheck = (container: HTMLElement) => {
  fireEvent.click(screen.getByRole('button', { name: 'Add Provider' }));
  const typeSelect = container.querySelector('select') as HTMLSelectElement;
  fireEvent.change(typeSelect, { target: { value: 'openai' } });
  const keyBox = container.querySelector('input[type="password"]') as HTMLInputElement;
  fireEvent.change(keyBox, { target: { value: 'sk-not-a-real-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add & Validate' }));
};

beforeEach(() => {
  list.calls = 0;
  vi.mocked(api.getProviders).mockClear();
});

describe('a provider that fails its first check', () => {
  it('the form says the add worked but the check did not', async () => {
    const { container } = renderTab();
    await screen.findByText('No providers configured.');
    addOpenaiThatFailsItsCheck(container);
    await screen.findByText(/Provider added but validation failed/);
  });

  it('the provider is listed behind the form even though the check failed', async () => {
    const { container } = renderTab();
    await screen.findByText('No providers configured.');
    addOpenaiThatFailsItsCheck(container);
    await waitFor(() => expect(api.getProviders).toHaveBeenCalledTimes(2));
    // The card title outside the form. The form stays open after a failed check and its
    // own preset option carries the same text, so the query names the heading element.
    await screen.findByText('OpenAI', { selector: 'h3' });
  });
});
