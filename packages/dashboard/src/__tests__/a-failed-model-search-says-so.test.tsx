// ════════════════════════════════════════════════════════════════════════════
// A FAILED MODEL SEARCH SAYS SO — the browse-models search swallows a refusal.
//
// `ModelsTab.tsx` `handleSearch` (≈29-37) answers a failed `browseProviderModels`
// by blanking the results, so the empty list draws "No models found" — a bad key,
// a network failure or a server refusal reads as "this provider has no such
// model". And the input's Enter path has no `searching` guard, so pressing Enter
// while a search runs fires a second request whose answers can land out of order.
// This file drives the honest surface: the refusal is named in coral, the "no
// models" line stays away, and a second Enter is ignored.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the box
// mounts on its own terms and the door this file is about is the only override.
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  return stub;
});

import * as api from '../lib/api';
import { BrowseModels } from '../components/settings/ModelsTab';

const mocked = () => vi.mocked(api);

const renderBrowse = () =>
  render(<BrowseModels providerId="p1" providerName="Test Router" onModelAdded={() => {}} />);

afterEach(() => { vi.clearAllMocks(); });

describe('a failed model search says so', () => {
  it('names the refusal and does not say no models were found', async () => {
    mocked().browseProviderModels.mockResolvedValue({ ok: false, error: 'key rejected' } as never);
    renderBrowse();
    const input = screen.getByPlaceholderText(/Search models/i);

    fireEvent.change(input, { target: { value: 'claude' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('key rejected')).toBeTruthy();
    expect(screen.queryByText(/No models found/)).toBeNull();
  });

  it('Enter while a search is running does not fire a second request', async () => {
    let settleSearch: ((v: unknown) => void) | null = null;
    mocked().browseProviderModels.mockImplementation(() => new Promise((res) => { settleSearch = res; }));
    renderBrowse();
    const input = screen.getByPlaceholderText(/Search models/i);

    fireEvent.change(input, { target: { value: 'claude' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(mocked().browseProviderModels).toHaveBeenCalledTimes(1);

    await act(async () => { settleSearch!({ ok: true, data: [] }); });
  });
});
