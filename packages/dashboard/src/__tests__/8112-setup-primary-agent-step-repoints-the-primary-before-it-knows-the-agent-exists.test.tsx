// 8112 — the Setup primary-agent step provisions the agent FIRST; settings are written only after
// the server accepted it, with the id the server answered with (the primary is never found by name).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const state = vi.hoisted(() => ({
  provision: { ok: false, error: 'refused' } as { ok: boolean; error?: string; data?: unknown },
  identity: { ok: true } as { ok: boolean; error?: string },
  settingWrites: [] as Array<[string, string]>,
}));
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  stub.getModels = vi.fn(async () => ({ ok: true, data: [{ id: 'm1', name: 'M1', apiModelId: 'm1', providerId: 'p', capabilities: ['chat'], isEnabled: true }] }));
  stub.getSetting = vi.fn(async () => ({ ok: true, data: { value: null } }));
  stub.request = vi.fn(async () => state.provision);
  stub.setSetting = vi.fn(async (k: string, v: string) => { state.settingWrites.push([k, v]); return { ok: true, data: { key: k, value: v } }; });
  stub.generateIdentity = vi.fn(async () => state.identity);
  return stub;
});

import { PrimaryAgentStep } from '../pages/Setup';

const run = async () => {
  render(<PrimaryAgentStep />);
  await waitFor(() => expect(screen.getByPlaceholderText(/Atlas/)).toBeTruthy());
  fireEvent.change(screen.getByPlaceholderText(/Atlas/), { target: { value: 'Zed' } });
  fireEvent.click(screen.getByRole('button', { name: /Configure Zed/ }));
};

beforeEach(() => { state.settingWrites.length = 0; state.identity = { ok: true }; });

describe('PrimaryAgentStep', () => {
  it('a refused provision writes no primary_agent_id and shows the error, not "configured"', async () => {
    state.provision = { ok: false, error: 'refused' };
    await run();
    await screen.findByText('refused');
    expect(state.settingWrites.some(([k]) => k === 'primary_agent_id')).toBe(false);
    expect(screen.queryByText(/is configured!/)).toBeNull();
  });

  it('writes the id the server answered with, after provisioning', async () => {
    state.provision = { ok: true, data: { id: 'stored-id', name: 'Zed', action: 'updated' } };
    await run();
    await screen.findByText(/Zed is configured!/);
    expect(state.settingWrites).toContainEqual(['primary_agent_id', 'stored-id']);
  });

  it('a failed identity write is not marked configured', async () => {
    state.provision = { ok: true, data: { id: 'zed', name: 'Zed', action: 'created' } };
    state.identity = { ok: false, error: 'x' };
    await run();
    await screen.findByText('Agent created, but its identity files could not be written: x');
    expect(screen.queryByText(/is configured!/)).toBeNull();
  });
});

describe('PrimaryAgentStep re-run soul', () => {
  it('says where the previous SOUL.md went, and sends restyle only after the owner changed the style', async () => {
    state.provision = { ok: true, data: { id: 'zed', name: 'Zed', action: 'updated' } };
    state.identity = { ok: true, data: { soulBackup: 'SOUL.md.2026.bak' } } as never;
    const api = await import('../lib/api');
    await run();
    await screen.findByText(/SOUL\.md\.2026\.bak/);
    expect((api.generateIdentity as unknown as { mock: { calls: Array<[{ restyle?: boolean }]> } }).mock.calls.at(-1)![0].restyle).toBe(false);
    fireEvent.click(screen.getByLabelText(/formal/i));
    fireEvent.click(screen.getByRole('button', { name: /Configure Zed/ }));
    await waitFor(() => expect((api.generateIdentity as unknown as { mock: { calls: Array<[{ restyle?: boolean }]> } }).mock.calls.at(-1)![0].restyle).toBe(true));
  });
});
