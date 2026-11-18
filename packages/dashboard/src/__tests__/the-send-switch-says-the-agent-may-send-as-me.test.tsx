// The one send switch on each Google and Microsoft account card says what it allows: on the owner's
// accounts "The agent may send as me", on the agent's own accounts "The agent may send from this account".

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const answers: Record<string, { ok: boolean; error?: string; data?: unknown }> = {};
const calls: string[] = [];

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.request = vi.fn(async (path: string) => {
    const bare = path.split('?')[0];
    calls.push(bare);
    return answers[bare] ?? { ok: false, error: 'offline' };
  });
  return stub;
});

import { GoogleWorkspaceSettings } from '../components/GoogleWorkspaceSettings';
import { MicrosoftWorkspaceSettings } from '../components/MicrosoftWorkspaceSettings';

const account = (kind: 'agent' | 'user', extra: Record<string, unknown> = {}) => ({
  id: `acc-${kind}`, kind, position: 1, email: `${kind}@example.test`, accountType: 'msa',
  enabled: true, connected: true, services: { gmail: true, outlook: true },
  watchEmail: false, sendEmail: false, lastVerified: null, ...extra,
});
const base = (accounts: unknown[]) => ({
  clientId: 'x', slots: { agent: {}, user: {} }, accounts, maxPerKind: 5,
  lastActivity: null, todayActivity: { reads: 0, writes: 0 },
  officeTools: { status: 'not_installed', error: null },
});

beforeEach(() => {
  for (const k of Object.keys(answers)) delete answers[k];
  calls.length = 0;
  try { window.localStorage.clear(); } catch { /* none */ }
});

describe('the send switch', () => {
  it('Google: says "The agent may send as me" on the owner\'s account', async () => {
    answers['/google/status'] = { ok: true, data: base([account('user')]) };
    render(<GoogleWorkspaceSettings />);
    fireEvent.click(await screen.findByLabelText(/Expand User's Google Accounts/));
    expect(await screen.findByRole('checkbox', { name: /The agent may send as me/ })).toBeTruthy();
  });

  it('Google: says "The agent may send from this account" on the agent\'s account', async () => {
    answers['/google/status'] = { ok: true, data: base([account('agent')]) };
    render(<GoogleWorkspaceSettings />);
    fireEvent.click(await screen.findByLabelText(/Expand Agent's Google Accounts/));
    expect(await screen.findByRole('checkbox', { name: /The agent may send from this account/ })).toBeTruthy();
  });

  it('Microsoft: says "The agent may send as me" on the owner\'s account', async () => {
    answers['/microsoft/status'] = { ok: true, data: base([account('user')]) };
    render(<MicrosoftWorkspaceSettings />);
    fireEvent.click(await screen.findByLabelText(/Expand User's Microsoft Accounts/));
    expect(await screen.findByRole('checkbox', { name: /The agent may send as me/ })).toBeTruthy();
  });

  it('Microsoft: says "The agent may send from this account" on the agent\'s account', async () => {
    answers['/microsoft/status'] = { ok: true, data: base([account('agent')]) };
    render(<MicrosoftWorkspaceSettings />);
    fireEvent.click(await screen.findByLabelText(/Expand Agent's Microsoft Accounts/));
    expect(await screen.findByRole('checkbox', { name: /The agent may send from this account/ })).toBeTruthy();
  });
});
