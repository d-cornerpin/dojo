// v3.5 fix round 1 (A6) — THE SETUP WIZARD'S ROLE STEPS AND THE DREAMING TAB SHOW THE SERVER'S REFUSAL,
// NEVER "SAVED"; THE PM STEP DOES NOT DEFAULT TO A LOCAL MODEL THE SERVER REFUSES; AND NO PICKER OFFERS
// THE DOJO'S DECISION MODEL. The server is a scripted `request`.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import type { ReactElement } from 'react';

const SENTENCE = 'big-local:9b needs about 11.3 GB of memory to run with its 32K-token window. Choose a smaller local model or a cloud model.';
const server = vi.hoisted(() => ({ puts: [] as Array<{ path: string; body: string }>, refused: new Set<string>() }));
vi.mock('../lib/door', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/door');
  return {
    ...actual,
    request: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
      if (path.startsWith('/setup/model-fit/')) {
        const id = decodeURIComponent(path.slice('/setup/model-fit/'.length));
        return { ok: true, data: { refused: server.refused.has(id) ? SENTENCE : null } };
      }
      if (init?.method === 'PUT') {
        server.puts.push({ path, body: init.body ?? '' });
        const value = (JSON.parse(init.body ?? '{}') as { value: string }).value;
        return server.refused.has(value) ? { ok: false, error: SENTENCE } : { ok: true, data: {} };
      }
      return { ok: true, data: {} };
    }),
  };
});
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
import { defaultRoleModel, saveRoleAgent, isPickableAgentModel } from '../lib/role-models';
import { PMAgentStep, DreamerStep } from '../pages/Setup';
import { DreamingTab } from '../components/settings/DreamingTab';

const model = (id: string, cost: number | null, caps: string[] = ['chat'], notForAgents: string | null = null) =>
  ({ id, name: id, apiModelId: id, providerId: 'p', capabilities: caps, isEnabled: true, inputCostPerM: cost, outputCostPerM: cost, notForAgents, notAChatModel: notForAgents === 'not a chat model' }) as never;
const MODELS = [model('local-9b', 0), model('decider', 0, ['decision'], 'not a chat model'), model('cloud-small', 0.25), model('cloud-big', 3)];

beforeEach(() => {
  server.puts.length = 0;
  server.refused = new Set(['local-9b']);
  vi.mocked(api.getModels).mockResolvedValue({ ok: true, data: MODELS } as never);
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { value: '' } } as never);
  vi.mocked(api.getDreamingConfig).mockResolvedValue({ ok: true, data: { modelId: '', dreamTime: '03:00', dreamMode: 'full' } } as never);
  vi.mocked(api.getLatestDream).mockResolvedValue({ ok: true, data: null } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the helpers', () => {
  it('the decision model is not pickable for an agent', () => {
    expect(MODELS.filter(isPickableAgentModel).map((m: { id: string }) => m.id)).toEqual(['local-9b', 'cloud-small', 'cloud-big']);
  });
  it('the default is the cheapest model the server ACCEPTS, not the first free local one', async () => {
    expect(await defaultRoleModel(MODELS)).toBe('cloud-small');
  });
  it('a refused model comes back as the server\'s sentence, and nothing else is written', async () => {
    expect(await saveRoleAgent('pm', 'Tracker', 'local-9b')).toBe(SENTENCE);
    expect(server.puts.map((p) => p.path)).toEqual(['/config/settings/pm_agent_model']);
  });
});

describe('the setup PM step', () => {
  it('defaults to a model the server accepts and never offers the decision model', async () => {
    render(<PMAgentStep />);
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('cloud-small'));
    expect(screen.queryByRole('option', { name: /decider/ })).toBeNull();
  });
  it('shows the refusal instead of "saved"', async () => {
    render(<PMAgentStep />);
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('cloud-small'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tracker' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'local-9b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(SENTENCE)).toBeTruthy());
    expect(screen.queryByText(/will manage your projects/)).toBeNull();
  });
});

describe('the Dreamer: setup step and Settings tab', () => {
  it('setup step shows the refusal', async () => {
    vi.mocked(api.updateDreamingConfig).mockResolvedValue({ ok: false, error: SENTENCE } as never);
    render(<DreamerStep />);
    await waitFor(() => expect(screen.getAllByRole('combobox').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText(SENTENCE)).toBeTruthy());
    expect(screen.queryByText(/will process conversations every night/)).toBeNull();
  });
  it('the Dreaming tab shows the refusal and no "Saved!"', async () => {
    vi.mocked(api.updateDreamingConfig).mockResolvedValue({ ok: false, error: SENTENCE } as never);
    render(<DreamingTab />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Save' }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);   // the Dreamer's own (the Healer card follows)
    await waitFor(() => expect(screen.getByText(SENTENCE)).toBeTruthy());
    expect(screen.queryByText('Saved!')).toBeNull();
  });
});
