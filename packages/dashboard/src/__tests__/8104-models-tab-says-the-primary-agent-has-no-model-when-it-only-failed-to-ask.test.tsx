// Settings > Models: a failed look-up of the primary agent is not "has no model".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  return { useToast: () => t.value, ToastProvider: ({ children }: { children: ReactElement }) => children, ToastContainer: () => null };
});

import * as api from '../lib/api';
import { ModelsTab } from '../components/settings/ModelsTab';

const model = { id: 'm1', name: 'm1', apiModelId: 'm1', providerId: 'p', capabilities: ['chat'], isEnabled: true, inputCostPerM: 0, outputCostPerM: 0 } as never;

beforeEach(() => {
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { value: '' } } as never);
  vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: [model] } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the primary agent look-up', () => {
  it('says it could not read the model, not that there is none, when the look-up fails', async () => {
    vi.mocked(api.getAgent).mockResolvedValue({ ok: false, error: 'x' } as never);
    render(<ModelsTab />);
    await waitFor(() => expect(screen.getByText(/Could not read/)).toBeTruthy());
    expect(screen.queryByText(/can't respond to messages without a model/)).toBeNull();
    expect(screen.queryByRole('option', { name: 'Set Model' })).toBeNull();
  });

  it('still warns when the primary agent really has no model', async () => {
    vi.mocked(api.getAgent).mockResolvedValue({ ok: true, data: { modelId: null } } as never);
    render(<ModelsTab />);
    await waitFor(() => expect(screen.getByText(/can't respond to messages without a model/)).toBeTruthy());
  });
});
