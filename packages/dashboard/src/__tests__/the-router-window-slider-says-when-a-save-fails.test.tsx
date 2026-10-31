// A REFUSED ROUTER WINDOW MUST SAY WHY: the slider saved through the settings door and
// threw the server's refusal away — the owner released the handle, saw neither "Saved!"
// nor a reason, and left it on a value the server never stored (the next page load
// showed the old window). This file drives the honest surface: the refusal's sentence is
// shown, "Saved!" is withheld, and the slider goes back to the stored window.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the section
// mounts on its own terms and the door this file is about is the only override.
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
import { RouterWindowSection } from '../components/settings/RouterWindowSection';

const mocked = () => vi.mocked(api);

afterEach(() => { vi.clearAllMocks(); });

const win = { tokens: 32000, floorTokens: 64000, floorModelName: 'model-a', minTokens: 16000, minAgentName: null, unmeasuredAgentNames: [] };
const slider = () => screen.getByRole('slider', { name: 'Context window for automatic choice' }) as HTMLInputElement;

describe('the router window slider', () => {
  it('a refused window shows the server sentence, withholds Saved and puts the slider back', async () => {
    mocked().setSetting.mockResolvedValue({ ok: false, error: 'model-a needs about 20 GB at that window.' } as never);
    render(<RouterWindowSection routerWindow={win} />);

    fireEvent.change(slider(), { target: { value: '48000' } });
    fireEvent.mouseUp(slider());

    await waitFor(() => expect(screen.getByText('model-a needs about 20 GB at that window.')).toBeTruthy());
    expect(screen.queryByText('Saved!'), 'the success word is withheld on refusal').toBeNull();
    expect(slider().value).toBe('32000');
    expect(mocked().setSetting).toHaveBeenCalledWith('router.context_window', '48000');
  });

  it('an accepted window shows Saved! and no error', async () => {
    mocked().setSetting.mockResolvedValue({ ok: true, data: undefined } as never);
    render(<RouterWindowSection routerWindow={win} />);

    fireEvent.change(slider(), { target: { value: '48000' } });
    fireEvent.mouseUp(slider());

    await waitFor(() => expect(screen.getByText('Saved!')).toBeTruthy());
    expect(slider().value).toBe('48000');
  });
});
