// An agent's model pickers never list a model the server says is not for agents with a reason that
// removes it from the list ('not a chat model'). The server is a scripted `api`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  return stub;
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const t = fakeToast();
  return { useToast: () => t.value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { DreamingTab } from '../components/settings/DreamingTab';
import { ModelsTab } from '../components/settings/ModelsTab';

const model = (id: string, caps: string[], notForAgents: string | null) =>
  ({ id, name: id, apiModelId: id, providerId: 'p', capabilities: caps, isEnabled: true, inputCostPerM: 1, outputCostPerM: 1, notForAgents }) as never;

beforeEach(() => {
  vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: [model('clip-maker', ['video_generation'], 'not a chat model'), model('roomy-200k', ['chat'], null)] } as never);
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { value: '' } } as never);
  vi.mocked(api.getDreamingConfig).mockResolvedValue({ ok: true, data: { modelId: '', dreamTime: '03:00', dreamMode: 'full' } } as never);
  vi.mocked(api.getLatestDream).mockResolvedValue({ ok: true, data: null } as never);
});

const optionsNamed = (name: RegExp): HTMLOptionElement[] => screen.getAllByRole('option', { name }) as HTMLOptionElement[];

describe('a video model is not offered for an agent', () => {
  it('the Dreaming tab does not list a video model', async () => {
    render(<DreamingTab />);
    await waitFor(() => expect(optionsNamed(/roomy-200k/).length).toBeGreaterThanOrEqual(1));
    expect(screen.queryAllByRole('option', { name: /clip-maker/ })).toHaveLength(0);
  });

  it('the Models tab picker does not list a video model', async () => {
    render(<ModelsTab />);
    await waitFor(() => expect(optionsNamed(/roomy-200k/).length).toBeGreaterThanOrEqual(1));
    // Every picker that offers the agent's model (it lists the chat model) must not offer the video model.
    // The tab's Video Generation card is a capability picker, not an agent-model picker: it must list video models.
    for (const o of optionsNamed(/roomy-200k/)) {
      expect(within(o.closest('select') as HTMLElement).queryAllByRole('option', { name: /clip-maker/ })).toHaveLength(0);
    }
  });
});
