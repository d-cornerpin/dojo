// A REFUSED OPENER-MODEL WRITE SAYS SO — the `VoiceOpenerModelConfig` card (RouterConfig.tsx)
// awaits `api.setSetting('voice.opener_model', …)`, threw the answer away and always flashed
// "Saved!", so a refused write (setting rejected, server down) reported success; Clear even
// moved the picker to Auto while the stored value stayed put. This file drives the honest
// surface: a refusal shows the server's sentence as a toast, never says "Saved!", and leaves
// the picker on the model that is actually stored.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

// The permissive factory the costs test uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the card
// mounts on its own terms and `setSetting` is the only override that matters.
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
import { VoiceOpenerModelConfig } from '../components/RouterConfig';
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket };
});
import { ToastProvider } from '../hooks/useToast';
import { Dojo3Notifications } from '../components/Dojo3Notifications';

const REFUSAL = 'That model cannot speak the opener.';

// Real fields of `getAvailableRouterModels` (lib/api.ts).
const routerModel = (id: string) => ({
  id, name: id, api_model_id: `${id}-api`, provider_name: 'Provider', provider_type: 'openai-compatible',
});

// Rendered inside the real toast provider with the real container, so the
// asserted toast text is the one the person actually sees.
const renderOpener = async () => {
  render(
    <ToastProvider>
      <VoiceOpenerModelConfig />
      <Dojo3Notifications />
    </ToastProvider>,
  );
  // Loaded: the card is up and the picker shows the stored model.
  await screen.findByText('Voice Opener Model');
  await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('m1'));
};

beforeEach(() => {
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { key: 'voice.opener_model', value: 'm1' } } as never);
  vi.mocked(api.getAvailableRouterModels).mockResolvedValue({ ok: true, data: [routerModel('m1'), routerModel('m2')] } as never);
  vi.mocked(api.setSetting).mockResolvedValue({ ok: false, error: REFUSAL } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('a refused opener model says so', () => {
  it('a refused Save shows the server sentence and never says "Saved!"', async () => {
    await renderOpener();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
    expect(screen.queryByText('Saved!')).toBeNull();
  });

  it('a refused Clear keeps the picker on the stored model and never says "Saved!"', async () => {
    await renderOpener();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    // Wait out the refused write: the button stops saying "Saving...".
    await screen.findByRole('button', { name: 'Save' });
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('m1');
    expect(screen.queryByText('Saved!')).toBeNull();
  });

  it('an accepted Save still says "Saved!"', async () => {
    vi.mocked(api.setSetting).mockResolvedValue({ ok: true, data: { key: 'voice.opener_model', value: 'm2' } } as never);
    await renderOpener();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'm2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Saved!')).toBeTruthy();
  });
});
