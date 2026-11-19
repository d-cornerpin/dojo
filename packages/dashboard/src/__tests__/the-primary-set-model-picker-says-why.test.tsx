// v3.5 fix round 2 (d) — THE PRIMARY AGENT'S "SET MODEL" PICKER (Settings → Models) OFFERS NO DECISION
// MODEL AND SHOWS THE SERVER'S REFUSAL instead of saying nothing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
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
import { ModelsTab } from '../components/settings/ModelsTab';

const SENTENCE = 'local-9b needs about 11.3 GB of memory to run with its 32K-token window. Choose a smaller local model or a cloud model.';
const model = (id: string, caps: string[], notForAgents: string | null = null) => ({ id, name: id, apiModelId: id, providerId: 'p', capabilities: caps, isEnabled: true, inputCostPerM: 0, outputCostPerM: 0, notForAgents, notAChatModel: notForAgents === 'not a chat model' }) as never;

beforeEach(() => {
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { value: '' } } as never);
  vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: [model('local-9b', ['chat']), model('decider', ['decision'], 'not a chat model')] } as never);
  vi.mocked(api.getAgent).mockResolvedValue({ ok: true, data: { modelId: null } } as never);
  vi.mocked(api.setAgentModel).mockResolvedValue({ ok: false, error: SENTENCE } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the primary agent has no model', () => {
  it('the Set Model picker never offers the decision model, and a refusal is shown', async () => {
    render(<ModelsTab />);
    await waitFor(() => expect(screen.getByText('Primary agent has no model assigned')).toBeTruthy());
    const picker = screen.getByRole('option', { name: 'Set Model' }).closest('select') as HTMLSelectElement;
    const offered = [...picker.options].map((o) => o.value);
    expect(offered).toContain('local-9b');
    expect(offered).not.toContain('decider');
    fireEvent.change(picker, { target: { value: 'local-9b' } });
    await waitFor(() => expect(screen.getByText(SENTENCE)).toBeTruthy());
  });
});
