// v3.5 A2 — THE DOJO'S TWO MODELS INSTALL THEMSELVES. The setup screen shows their progress and offers
// no choice; the agents' own models are pulled below it. The Ollama tile in Settings → Platform shows
// the pair's state and a Repair button. The tags shown are the ones the server sends (the dashboard
// names neither model itself), so the fixture uses made-up tags.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  return stub;
});

import * as api from '../lib/api';
import { SetupDeps } from '../components/SetupDeps';
import { StandardModels } from '../components/settings/StandardModels';

const TAGS = { decision: 'decider-tag:1', writer: 'writer-tag:1' };
const standard = { current: {} as Record<string, unknown> };
const posts: string[] = [];

beforeEach(() => {
  posts.length = 0;
  standard.current = {
    decision: 'pulling', writer: 'missing', ollama: 'running', residentBytes: 0,
    note: "Installing the Dojo's two models.", tags: TAGS,
    lines: ['Downloading the decision model (decider-tag:1): 40%', 'Downloading the writer (writer-tag:1): 0%'],
  };
  vi.mocked(api.request).mockImplementation((async (path: string, init?: { method?: string }) => {
    if (init?.method === 'POST') posts.push(path);
    if (path === '/setup/deps/check') {
      const yes = { installed: true };
      return { ok: true, data: { node: { installed: true, version: 'v22' }, brew: yes, ollama: { installed: true, running: true }, cliclick: yes, playwright: yes, nomic: yes, gws: yes, gcloud: yes } };
    }
    if (path === '/setup/ollama/standard') return { ok: true, data: standard.current };
    if (path === '/setup/ollama/models') return { ok: true, data: [] };
    return { ok: true, data: {} };
  }) as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('setup: the Dojo\'s two models', () => {
  it('shows both progress lines and never offers a choice for them', async () => {
    render(<SetupDeps />);
    await waitFor(() => expect(screen.getByText("Dojo's two models")).toBeTruthy());
    await waitFor(() => expect(screen.getByText('Downloading the decision model (decider-tag:1): 40%')).toBeTruthy());
    expect(screen.getByText('Downloading the writer (writer-tag:1): 0%')).toBeTruthy();
    expect(screen.queryByText('Choose a Local Model')).toBeNull();
    expect(screen.queryByText('Recommended')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.getByText('Models for your agents')).toBeTruthy();
  });
});

describe('Settings → Platform: the Ollama tile', () => {
  it('names the pair from the server, says what is missing, and Repair asks the server to install', async () => {
    standard.current = { ...standard.current, decision: 'installed', writer: 'missing', lines: [], note: 'Not installed yet: the writer (writer-tag:1). Use Repair to install it.' };
    render(<StandardModels repair />);
    await waitFor(() => expect(screen.getByText(/Dojo's own models:/)).toBeTruthy());
    const line = screen.getByText(/Dojo's own models:/).textContent ?? '';
    expect(line).toContain('decider-tag:1 (decision)');
    expect(line).toContain('writer-tag:1 (writer)');
    expect(screen.getByText(/Not installed yet: the writer/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Repair' }));
    await waitFor(() => expect(posts).toContain('/setup/ollama/standard'));
  });

  it('offers no Repair when both are installed', async () => {
    standard.current = { ...standard.current, decision: 'installed', writer: 'installed', lines: [], note: 'Both standard models are installed (6.2 GB).' };
    render(<StandardModels repair />);
    await waitFor(() => expect(screen.getByText('Both standard models are installed (6.2 GB).')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Repair' })).toBeNull();
  });
});
