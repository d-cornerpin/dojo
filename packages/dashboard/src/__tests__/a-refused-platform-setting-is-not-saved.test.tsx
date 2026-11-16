// ── A REFUSED PLATFORM SETTING IS NOT "Saved!" ────────────────────────────────
//
// The Ollama card and the Dojo Capacity card each wrote their settings without ever asking how
// the server answered, and lit "Saved!" anyway — a refused value looked stored. Both cards now
// read the answer: "Saved!" only on `ok`, the server's own sentence otherwise, and Capacity
// stops at the first rejection with the failing field's label on it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  return {
    ...actual,
    getSetting: vi.fn(async () => ({ ok: true, data: { key: 'k', value: '2' } })),
    setSetting: vi.fn(),
  };
});

import * as api from '../lib/api';
import { OllamaSettings, AgentLimitsSettings } from '../components/settings/PlatformTab';

beforeEach(() => {
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { key: 'k', value: '2' } });
  vi.mocked(api.setSetting).mockReset();
});

describe('the Ollama card', () => {
  it('a refused value shows the server\'s reason and does not say Saved!', async () => {
    vi.mocked(api.setSetting).mockResolvedValue({ ok: false, error: 'must be 1 to 8' });
    render(<OllamaSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('must be 1 to 8')).toBeTruthy());
    expect(screen.queryByText('Saved!')).toBeNull();
  });

  it('field failure 2: the card says what the number really controls today, with no stale sizing advice', async () => {
    render(<OllamaSettings />);
    await screen.findByRole('button', { name: 'Save' });
    expect(screen.queryByText(/Set to 1 for 16GB/)).toBeNull();
    expect(screen.getByText(/How many different agent models each Ollama may keep loaded at once/)).toBeTruthy();
    expect(screen.getByText(/The Dojo's own two models and the embedder always stay loaded beside them/)).toBeTruthy();
  });

  it('an accepted value says Saved!', async () => {
    vi.mocked(api.setSetting).mockResolvedValue({ ok: true, data: { key: 'k', value: '2' } });
    render(<OllamaSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByText('Saved!')).toBeTruthy());
  });
});

describe('the Dojo Capacity card', () => {
  it('stops at the first rejected limit, names the field, and does not say Saved!', async () => {
    vi.mocked(api.setSetting).mockImplementation(async (key) =>
      key === 'spawn_max_depth'
        ? { ok: false, error: 'too high' }
        : { ok: true, data: { key, value: '2' } });
    render(<AgentLimitsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Save Limits' }));
    await waitFor(() => expect(screen.getByText('Max Spawn Depth: too high')).toBeTruthy());
    expect(screen.queryByText('Saved!')).toBeNull();
    expect(api.setSetting).toHaveBeenCalledTimes(2);
  });
});
