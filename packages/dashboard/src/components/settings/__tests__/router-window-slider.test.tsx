// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 N42 (GitHub #25, the owner's design) — THE ROUTER TAB'S ONE WINDOW SLIDER.
//
// One slider for the whole router: its top is the smallest window among the router's light, standard
// and heavy models (the server's `window.floorTokens`), its readout names that model, its low end is
// the measured instructions-plus-tools of the largest automatic agent, and releasing it saves
// `router.context_window` through the existing settings door. Mounted for real (the Router tab);
// only the network door is replaced.
// ════════════════════════════════════════════════════════════════════════════════════════

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

const slider = (): HTMLInputElement => screen.getByLabelText(/Context window for automatic choice/i) as HTMLInputElement;

beforeEach(() => {
  vi.mocked(api.setSetting).mockClear();
  reply.window = { tokens: 128_000, floorTokens: 128_000, floorModelName: 'Dock Standard', minTokens: 21_500, minAgentName: 'Dock Desk' };
});

describe('the Router tab\'s window slider', () => {
  it('its top is the floor, its value is the router window, its low end is the measured one', async () => {
    reply.window = { tokens: 64_000, floorTokens: 128_000, floorModelName: 'Dock Standard', minTokens: 21_500, minAgentName: 'Dock Desk' };
    render(<RouterTab />);
    await waitFor(() => expect(slider()).toBeTruthy());
    expect(slider().max).toBe('128000');
    expect(slider().min).toBe('21500');
    expect(slider().value).toBe('64000');
  });

  it('the readout names the smallest model on the router, and which agent sets the low end', async () => {
    render(<RouterTab />);
    await waitFor(() => expect(slider()).toBeTruthy());
    expect(screen.getByText(/128k — the smallest model on the router is Dock Standard \(128k\)/)).toBeTruthy();
    expect(screen.getByText(/Dock Desk/)).toBeTruthy();
  });

  it('releasing the slider saves router.context_window through the settings door', async () => {
    render(<RouterTab />);
    await waitFor(() => expect(slider()).toBeTruthy());
    fireEvent.change(slider(), { target: { value: '40000' } });
    fireEvent.mouseUp(slider());
    await waitFor(() => expect(api.setSetting).toHaveBeenCalledWith('router.context_window', '40000'));
  });

  it('with no models on the three tiers the section says so and shows no slider', async () => {
    reply.window = null;
    render(<RouterTab />);
    await waitFor(() => expect(screen.getByText(/No models are on the light, standard or heavy tier yet/i)).toBeTruthy());
    expect(screen.queryByLabelText(/Context window for automatic choice/i)).toBeNull();
  });
});
