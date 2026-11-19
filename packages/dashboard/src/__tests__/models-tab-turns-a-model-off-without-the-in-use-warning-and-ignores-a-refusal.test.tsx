// Settings > Models: turning a model off asks first when the in-use check could not run,
// and a refused on/off switch shows the server's sentence.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';

const toasts = vi.hoisted(() => ({ calls: [] as Array<{ level: string; message: string }> }));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  return stub;
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const t = fakeToast();
  toasts.calls = t.calls;
  return { useToast: () => t.value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { ModelsTab } from '../components/settings/ModelsTab';

const model = { id: 'm1', name: 'm1', apiModelId: 'm1', providerId: 'p', capabilities: ['chat'], isEnabled: true, inputCostPerM: 0, outputCostPerM: 0 } as never;

beforeEach(() => {
  toasts.calls.length = 0;
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { value: '' } } as never);
  vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: [model] } as never);
  vi.mocked(api.getProviders).mockResolvedValue({ ok: true, data: [{ id: 'p', name: 'Prov', type: 'anthropic' }] } as never);
  vi.mocked(api.getAgent).mockResolvedValue({ ok: true, data: { modelId: 'm1' } } as never);
  vi.mocked(api.checkModelUsage).mockResolvedValue({ ok: true, data: { usages: [] } } as never);
  vi.mocked(api.disableModels).mockResolvedValue({ ok: true, data: { disabled: 1, agentsMoved: 0 } } as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

const openAndFindSwitch = async () => {
  render(<ModelsTab />);
  const group = await screen.findByText('Prov');
  if (!document.querySelector('button[aria-pressed]')) fireEvent.click(group);
  return (await waitFor(() => {
    const el = document.querySelector('button[aria-pressed]');
    if (!el) throw new Error('no switch');
    return el;
  })) as HTMLElement;
};

describe('turning a model off', () => {
  it('asks the owner when the in-use check failed, and stops on no', async () => {
    vi.mocked(api.checkModelUsage).mockResolvedValue({ ok: false, error: 'x' } as never);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(await openAndFindSwitch());
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(api.disableModels).not.toHaveBeenCalled();
  });

  it('says how many agents moved to another model', async () => {
    vi.mocked(api.disableModels).mockResolvedValue({ ok: true, data: { disabled: 1, agentsMoved: 2 } } as never);
    fireEvent.click(await openAndFindSwitch());
    await waitFor(() => expect(toasts.calls).toContainEqual({ level: 'info', message: '2 agent(s) moved to another model.' }));
  });

  it('shows the server sentence when the switch is refused', async () => {
    vi.mocked(api.disableModels).mockResolvedValue({ ok: false, error: 'locked' } as never);
    fireEvent.click(await openAndFindSwitch());
    await waitFor(() => expect(toasts.calls.some((c) => c.level === 'error' && c.message === 'locked')).toBe(true));
  });
});
