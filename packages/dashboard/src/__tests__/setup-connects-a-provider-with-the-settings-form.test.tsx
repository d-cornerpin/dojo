// The wizard's provider step uses the Settings form, tells the page about a cloud provider at once, and a local manual server is not one.
import { describe, it, expect, vi, beforeEach } from 'vitest';
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

const stored = (over: Record<string, unknown>) => ({ id: 'p', name: 'P', type: 'anthropic', authType: 'api_key', behavesLike: null, isValidated: true, ...over });
const created = (id: string) => ({ ok: true, data: { id, name: id, type: 'anthropic', authType: 'api_key', isValidated: true } }) as never;

beforeEach(() => {
  vi.mocked(api.getProviders).mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(api.createProvider).mockImplementation(async (b: { id: string }) => created(b.id));
  vi.mocked(api.validateProvider).mockResolvedValue({ ok: true, data: { valid: true } } as never);
});

describe('the setup provider step', () => {
  it('offers the Settings choices and tells the page about a cloud provider before the form closes', async () => {
    const onCloud = vi.fn();
    render(<ProviderStep onCloudProviderChange={onCloud} />);
    expect(await screen.findByRole('option', { name: 'Manual OpenAI API' })).toBeTruthy();
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add & Validate' }));
    await waitFor(() => expect(onCloud).toHaveBeenCalledWith(true), { timeout: 400 });
  });
  it('a validated manual server is not a cloud provider', async () => {
    const onCloud = vi.fn();
    render(<ProviderStep onCloudProviderChange={onCloud} />);
    fireEvent.change((await screen.findAllByRole('combobox'))[0], { target: { value: 'manual' } });
    fireEvent.change(screen.getByPlaceholderText('http://localhost:8000/v1'), { target: { value: 'http://localhost:8000/v1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add & Validate' }));
    await waitFor(() => expect(api.validateProvider).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(onCloud).not.toHaveBeenCalledWith(true);
  });
  it('a stored validated manual server is not a cloud provider either', async () => {
    vi.mocked(api.getProviders).mockResolvedValue({ ok: true, data: [stored({ type: 'openai-compatible', behavesLike: 'generic-openai-compatible' })] } as never);
    const onCloud = vi.fn();
    render(<ProviderStep onCloudProviderChange={onCloud} />);
    await screen.findByText('Configured providers');
    expect(onCloud).not.toHaveBeenCalledWith(true);
  });
  it('a stored validated cloud provider is', async () => {
    vi.mocked(api.getProviders).mockResolvedValue({ ok: true, data: [stored({})] } as never);
    const onCloud = vi.fn();
    render(<ProviderStep onCloudProviderChange={onCloud} />);
    await waitFor(() => expect(onCloud).toHaveBeenCalledWith(true));
  });
});
