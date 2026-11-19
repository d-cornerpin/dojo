// A model the server marks too small for agents shows in an agent's model picker as unavailable, with the
// reason, and cannot be chosen; a big enough model stays a normal choice. The server is a scripted `api`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
import { PrimaryAgentStep } from '../pages/Setup';
import { DreamingTab } from '../components/settings/DreamingTab';
import { ModelsTab } from '../components/settings/ModelsTab';

const model = (id: string, tooSmall: boolean) =>
  ({ id, name: id, apiModelId: id, providerId: 'p', capabilities: ['chat'], isEnabled: true, inputCostPerM: 1, outputCostPerM: 1, notForAgents: tooSmall ? 'too small for an agent' : null }) as never;

beforeEach(() => {
  vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: [model('tiny-8k', true), model('roomy-200k', false)] } as never);
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { value: '' } } as never);
  vi.mocked(api.getDreamingConfig).mockResolvedValue({ ok: true, data: { modelId: '', dreamTime: '03:00', dreamMode: 'full' } } as never);
  vi.mocked(api.getLatestDream).mockResolvedValue({ ok: true, data: null } as never);
});

const optionsNamed = (name: RegExp): HTMLOptionElement[] => screen.getAllByRole('option', { name }) as HTMLOptionElement[];

describe('a model too small for agents cannot be picked', () => {
  it('the setup primary-agent step lists it as too small and disabled, and defaults to the big one', async () => {
    render(<PrimaryAgentStep />);
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('roomy-200k'));
    expect(optionsNamed(/tiny-8k.*\(too small for an agent\)/).every((o) => o.disabled)).toBe(true);
    expect(optionsNamed(/roomy-200k/).every((o) => !o.disabled && !/too small/.test(o.textContent ?? ''))).toBe(true);
  });

  it('the Dreaming tab and its Healer card do the same', async () => {
    render(<DreamingTab />);
    await waitFor(() => expect(optionsNamed(/tiny-8k/).length).toBeGreaterThanOrEqual(2));
    expect(optionsNamed(/tiny-8k/).every((o) => o.disabled && /too small for an agent/.test(o.textContent ?? ''))).toBe(true);
  });

  it('the Models tab\'s "no model assigned" picker does the same', async () => {
    render(<ModelsTab />);
    await waitFor(() => expect(optionsNamed(/tiny-8k/)).toHaveLength(1));
    expect(optionsNamed(/tiny-8k.*\(too small for an agent\)/)[0].disabled).toBe(true);
  });
});
