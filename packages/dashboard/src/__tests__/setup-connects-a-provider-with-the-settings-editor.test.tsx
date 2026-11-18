import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useWebSocket', () => ({ useWebSocket: () => ({ subscribe: () => () => {} }) }));

import * as api from '../lib/api';
import { ProviderStep } from '../pages/Setup';

const ADDED = { id: 'anthropic', name: 'Anthropic', type: 'anthropic', authType: 'api_key', isValidated: true };

beforeEach(() => {
  vi.mocked(api.getProviders).mockResolvedValueOnce({ ok: true, data: [] } as never).mockResolvedValue({ ok: true, data: [ADDED] } as never);
  vi.mocked(api.createProvider).mockResolvedValue({ ok: true, data: ADDED } as never);
  vi.mocked(api.validateProvider).mockResolvedValue({ ok: true, data: { valid: true } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('setup connects a provider with the Settings editor', () => {
  it('offers the Settings choices, the manual one included', async () => {
    render(<ProviderStep />);
    expect(await screen.findByRole('option', { name: 'Manual OpenAI API' })).toBeTruthy();
  });
  it('adds and checks a provider, and tells the page a cloud provider is ready', async () => {
    const onCloud = vi.fn();
    render(<ProviderStep onCloudProviderChange={onCloud} />);
    await screen.findByRole('option', { name: 'Manual OpenAI API' });
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add & Validate' }));
    await waitFor(() => expect(api.createProvider).toHaveBeenCalledWith(expect.objectContaining({ id: 'anthropic', type: 'anthropic', authType: 'api_key', credential: 'sk-test' })));
    expect(api.validateProvider).toHaveBeenCalledWith('anthropic');
    await waitFor(() => expect(onCloud).toHaveBeenCalledWith(true), { timeout: 3000 });
  });
});
