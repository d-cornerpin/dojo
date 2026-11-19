// ── A REFUSED WORKSPACE SWITCH SAYS SO. ───────────────────────────────────────
//
// On the Google and Microsoft settings, a refused disconnect, service switch, watch-email or
// send-email switch simply snapped back with no reason (and the Office-tools install ignored a
// refusal). The server's reason must be shown, in the card of the account that was touched.

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

describe('a refused workspace switch', () => {
  it('Google: shows the reason for a refused watch-email switch', async () => {
    answers['/google/status'] = { ok: true, data: base([account('agent')]) };
    answers['/google/watch-email'] = { ok: false, error: 'toggle refused' };
    render(<GoogleWorkspaceSettings />);
    fireEvent.click(await screen.findByLabelText(/Expand Agent's Google Accounts/));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Monitor incoming email/ }));
    expect(await screen.findByText('toggle refused')).toBeTruthy();
  });

  it('Google: a refusal on a user account is shown too', async () => {
    answers['/google/status'] = { ok: true, data: base([account('user')]) };
    answers['/google/send-email'] = { ok: false, error: 'send refused' };
    render(<GoogleWorkspaceSettings />);
    fireEvent.click(await screen.findByLabelText(/Expand User's Google Accounts/));
    fireEvent.click(await screen.findByRole('checkbox', { name: /The agent may send as me/ }));
    expect(await screen.findByText('send refused')).toBeTruthy();
  });

  it('Microsoft: shows the reason for a refused watch-email switch', async () => {
    answers['/microsoft/status'] = { ok: true, data: base([account('agent')]) };
    answers['/microsoft/watch-email'] = { ok: false, error: 'toggle refused' };
    render(<MicrosoftWorkspaceSettings />);
    fireEvent.click(await screen.findByLabelText(/Expand Agent's Microsoft Accounts/));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Monitor incoming email/ }));
    expect(await screen.findByText('toggle refused')).toBeTruthy();
  });

  it('Microsoft: shows the reason for a refused disconnect', async () => {
    answers['/microsoft/status'] = { ok: true, data: base([account('agent')]) };
    answers['/microsoft/disconnect'] = { ok: false, error: 'disconnect refused' };
    vi.stubGlobal('confirm', () => true);
    render(<MicrosoftWorkspaceSettings />);
    fireEvent.click(await screen.findByLabelText(/Expand Agent's Microsoft Accounts/));
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('disconnect refused')).toBeTruthy();
  });
});
