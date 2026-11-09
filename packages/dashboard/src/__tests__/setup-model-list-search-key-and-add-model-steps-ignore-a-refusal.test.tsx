// The setup wizard's model list, web-search key and browse-add steps must say so
// when the server refuses, and must not show their success state.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getSearchConfig: vi.fn(async () => ({ ok: true, data: { provider: 'brave', hasKey: false } })),
    validateSearchKey: vi.fn(async () => ({ ok: true, data: { valid: true } })),
    setSearchConfig: vi.fn(),
    getProviders: vi.fn(async () => ({ ok: true, data: [{ id: 'p1', name: 'Direct', type: 'anthropic' }] })),
    getModels: vi.fn(async () => ({ ok: true, data: [{ id: 'm1', name: 'Model One', providerId: 'p1', isEnabled: false }] })),
    enableModels: vi.fn(),
    disableModels: vi.fn(),
    browseProviderModels: vi.fn(async () => ({ ok: true, data: [{ apiModelId: 'x/one', name: 'One Browse', contextWindow: null, inputCostPerM: 0, outputCostPerM: 0 }] })),
    addProviderModel: vi.fn(async () => ({ ok: true, data: { id: 'new-id' } })),
  };
});

import * as api from '../lib/api';
import { WebSearchStep, ModelsStep, SetupBrowseModels } from '../pages/Setup';

beforeEach(() => {
  vi.mocked(api.setSearchConfig).mockReset();
  vi.mocked(api.enableModels).mockReset();
  vi.mocked(api.disableModels).mockReset();
});

describe('setup steps tell the owner about a refusal', () => {
  it('web search: a refused key save is shown and the button is not Saved', async () => {
    vi.mocked(api.setSearchConfig).mockResolvedValue({ ok: false, error: 'locked' } as never);
    render(<WebSearchStep />);
    fireEvent.change(screen.getByPlaceholderText('BSA...'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: /validate & save/i }));
    await screen.findByText(/locked/);
    expect(screen.queryByText('API key validated!')).toBeNull();
    expect(screen.queryByText(/Saved/)).toBeNull();
  });

  it('models: a refused enable is shown and the button does not say Enabled', async () => {
    vi.mocked(api.enableModels).mockResolvedValue({ ok: false, error: 'nope' } as never);
    vi.mocked(api.disableModels).mockResolvedValue({ ok: true, data: {} } as never);
    render(<ModelsStep />);
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /enable 1 model/i }));
    await screen.findByText(/nope/);
    expect(screen.queryByText(/Enabled/)).toBeNull();
    expect(screen.getByText('Model One')).toBeTruthy();
  });

  it('browse add: a refused add shows the refusal; a refused enable is not counted', async () => {
    vi.mocked(api.addProviderModel).mockResolvedValueOnce({ ok: false, error: 'add refused' } as never);
    render(<SetupBrowseModels providerId="p2" providerName="Agg" onModelsAdded={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText(/Search models/), { target: { value: 'one' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    fireEvent.click(await screen.findByRole('button', { name: /add & enable/i }));
    await screen.findByText(/add refused/);

    vi.mocked(api.enableModels).mockResolvedValue({ ok: false, error: 'enable refused' } as never);
    fireEvent.click(screen.getByRole('button', { name: /add & enable/i }));
    await screen.findByText(/could not enable: enable refused/i);
    expect(screen.queryByText(/added and enabled/)).toBeNull();
  });
});
