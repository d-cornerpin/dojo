// Two quick catalog searches: the slower, older answer must not replace the
// results of the newer search (otherwise "Add" adds a model the box did not ask for).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return { ...actual, browseProviderModels: vi.fn() };
});

import * as api from '../lib/api';
import { BrowseModels } from '../components/settings/ModelsTab';
import { SetupBrowseModels } from '../pages/Setup';

const rows = (name: string) => ({
  ok: true,
  data: [{ apiModelId: `x/${name}`, name, contextWindow: null, maxOutputTokens: null, inputCostPerM: 0, outputCostPerM: 0, priceAvailable: true }],
});

const slowThenFast = async (ui: React.ReactElement) => {
  let releaseClaude: (v: unknown) => void = () => {};
  vi.mocked(api.browseProviderModels).mockReset();
  vi.mocked(api.browseProviderModels).mockImplementation((_p: string, q: string) =>
    (q === 'claude' ? new Promise((res) => { releaseClaude = res; }) : Promise.resolve(rows('Llama Row'))) as never);
  render(ui);
  const box = screen.getByPlaceholderText(/Search models/);
  fireEvent.change(box, { target: { value: 'claude' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  fireEvent.change(box, { target: { value: 'llama' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await screen.findByText('Llama Row');
  await act(async () => { releaseClaude(rows('Claude Row')); });
  expect(screen.queryByText('Claude Row')).toBeNull();
  expect(screen.getByText('Llama Row')).toBeTruthy();
};

describe('an older catalog search cannot replace a newer one', () => {
  it('Settings > Models browse box', async () => {
    await slowThenFast(<BrowseModels providerId="p" providerName="Agg" onModelAdded={() => {}} />);
  });
  it('setup wizard browse step', async () => {
    await slowThenFast(<SetupBrowseModels providerId="p" providerName="Agg" onModelsAdded={() => {}} />);
  });
});
