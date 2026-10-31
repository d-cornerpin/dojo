// A failed check of the remembered agent on page load (network blip, server restarting) keeps the
// selection and the device's memory of it, and retries once; only a definite "not found" (or a
// successful answer saying the agent is gone) drops it. A failed read of the primary agent id is
// retried too, rather than treated as "there is no primary".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../lib/api', () => ({
  getAgent: vi.fn(),
  getSetting: vi.fn(),
}));

import * as api from '../lib/api';
import { ActiveAgentProvider, useActiveAgent } from '../components/ActiveAgentProvider';
import { ACTIVE_AGENT_STORAGE_KEY } from '../lib/active-agent-memory';

const getAgent = api.getAgent as unknown as ReturnType<typeof vi.fn>;
const getSetting = api.getSetting as unknown as ReturnType<typeof vi.fn>;

const Probe = () => {
  const a = useActiveAgent();
  return <div data-testid="id">{a.agentId}</div>;
};
const mount = () => render(<MemoryRouter><ActiveAgentProvider><Probe /></ActiveAgentProvider></MemoryRouter>);
const settle = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const stored = () => localStorage.getItem(ACTIVE_AGENT_STORAGE_KEY);
const live = { ok: true, data: { id: 'a7', name: 'Dock Desk', status: 'idle', agentType: 'standard' } };

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  localStorage.setItem(ACTIVE_AGENT_STORAGE_KEY, JSON.stringify({ id: 'a7', name: 'Dock Desk' }));
  getSetting.mockImplementation(async (key: string) => ({ ok: true, data: { key, value: key === 'primary_agent_id' ? 'p1' : 'Main' } }));
});
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('verifying the remembered agent on load', () => {
  it('keeps the selection and the memory through a network failure, then confirms on the retry', async () => {
    getAgent.mockResolvedValueOnce({ ok: false, error: 'network' }).mockResolvedValue(live);
    mount();
    await settle();
    expect(screen.getByTestId('id').textContent).toBe('a7');
    expect(stored()).not.toBeNull();
    await settle(3000);
    expect(getAgent).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('id').textContent).toBe('a7');
    expect(stored()).not.toBeNull();
  });

  it('drops the selection when the server says the agent is not found', async () => {
    getAgent.mockResolvedValue({ ok: false, error: 'Agent not found' });
    mount();
    await settle();
    expect(screen.getByTestId('id').textContent).toBe('p1');
    expect(stored()).toBeNull();
  });
});

describe('reading the primary agent id on load', () => {
  it('retries a failed read once instead of settling on "no primary"', async () => {
    localStorage.clear();
    getSetting.mockImplementation(async (key: string) => (key === 'primary_agent_id' ? { ok: false, error: 'network' } : { ok: true, data: { key, value: 'Main' } }));
    mount();
    await settle();
    getSetting.mockImplementation(async (key: string) => ({ ok: true, data: { key, value: key === 'primary_agent_id' ? 'p1' : 'Main' } }));
    await settle(3000);
    expect(screen.getByTestId('id').textContent).toBe('p1');
  });
});
