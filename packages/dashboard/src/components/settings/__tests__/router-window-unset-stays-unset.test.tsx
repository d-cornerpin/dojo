// ── Settings → The Router tab: leaving the window slider at the top keeps it UNSET (v3.5 N42).
//
// The owner's rule is "unset = the top": with no `router.context_window` setting the window follows
// the floor, so raising the smallest model later raises the window with it. The server reads the
// setting as unset when it is not all digits (`router/router-window.ts`), so an empty string is unset.
// Releasing the slider must not turn that unset into a fixed number equal to today's floor.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const reply = vi.hoisted(() => ({
  window: { tokens: 128_000, floorTokens: 128_000, floorModelName: 'Dock Standard', minTokens: 21_500, minAgentName: 'Dock Desk' } as Record<string, unknown> | null,
}));
vi.mock('../../../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../../../lib/api');
  return {
    ...actual,
    getRouterConfig: vi.fn(async () => ({
      ok: true,
      data: {
        tiers: [{ id: 'light', displayName: 'Light', description: '', models: [{ modelId: 'm1', modelName: 'Dock Standard', priority: 0 }] }],
        dimensions: [],
        window: reply.window,
      },
    })),
    setSetting: vi.fn(async (key: string, value: string) => ({ ok: true, data: { key, value } })),
    testRouter: vi.fn(async () => ({ ok: false })),
  };
});

import * as api from '../../../lib/api';
import { RouterTab } from '../RouterTab';
import { ToastProvider } from '../../../hooks/useToast';

const slider = (): HTMLInputElement => screen.getByLabelText(/Context window for automatic choice/i) as HTMLInputElement;

beforeEach(() => {
  vi.mocked(api.setSetting).mockClear();
  reply.window = { tokens: 128_000, floorTokens: 128_000, floorModelName: 'Dock Standard', minTokens: 21_500, minAgentName: 'Dock Desk' };
});

describe('releasing the window slider at the top leaves the window unset', () => {
  it('a mouse release with no change does not save, so a click keeps the window unset', async () => {
    render(<ToastProvider><RouterTab /></ToastProvider>);
    await waitFor(() => expect(slider()).toBeTruthy());
    fireEvent.mouseUp(slider());
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it('a key release with no change (tabbing through) does not save either', async () => {
    render(<ToastProvider><RouterTab /></ToastProvider>);
    await waitFor(() => expect(slider()).toBeTruthy());
    fireEvent.keyUp(slider(), { key: 'Tab' });
    expect(api.setSetting).not.toHaveBeenCalled();
  });

  it('a change below the top still saves the number', async () => {
    render(<ToastProvider><RouterTab /></ToastProvider>);
    await waitFor(() => expect(slider()).toBeTruthy());
    fireEvent.change(slider(), { target: { value: '40000' } });
    fireEvent.mouseUp(slider());
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith('router.context_window', '40000'));
  });

  it('dragging back to the top saves empty, so the window keeps following the floor', async () => {
    reply.window = { tokens: 64_000, floorTokens: 128_000, floorModelName: 'Dock Standard', minTokens: 21_500, minAgentName: 'Dock Desk' };
    render(<ToastProvider><RouterTab /></ToastProvider>);
    await waitFor(() => expect(slider()).toBeTruthy());
    fireEvent.change(slider(), { target: { value: '128000' } });
    fireEvent.mouseUp(slider());
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith('router.context_window', ''));
  });

  it('dragging down and then back to the top, in one visit, saves the number and then empty', async () => {
    render(<ToastProvider><RouterTab /></ToastProvider>);
    await waitFor(() => expect(slider()).toBeTruthy());
    fireEvent.change(slider(), { target: { value: '40000' } });
    fireEvent.mouseUp(slider());
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith('router.context_window', '40000'));
    fireEvent.change(slider(), { target: { value: '128000' } });
    fireEvent.mouseUp(slider());
    await waitFor(() => expect(api.setSetting).toHaveBeenLastCalledWith('router.context_window', ''));
  });
});
