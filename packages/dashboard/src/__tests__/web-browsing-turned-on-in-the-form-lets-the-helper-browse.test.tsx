// The owner recruits a helper on the Agents page and turns Web Browsing on: the helper is created with
// browsing granted and not denied, so it can open pages. Left untouched, the form sends no permissions and
// the server's one default applies.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  stub.getToken = vi.fn(() => null);
  stub.getSetting = vi.fn(async () => ({ ok: true, data: { key: 'setting', value: '' } }));
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { Agents } from '../pages/Agents';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { AuthProvider } from '../hooks/useAuth';

const createAgent = () => api.createAgent as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => { vi.clearAllMocks(); });

const openForm = async () => {
  render(<MemoryRouter><AuthProvider><ActiveAgentProvider><Agents /></ActiveAgentProvider></AuthProvider></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: '+ Recruit Agent' }));
  fireEvent.change(screen.getByPlaceholderText('Agent name'), { target: { value: 'Researcher' } });
  fireEvent.change(screen.getByPlaceholderText('Instructions for the agent...'), { target: { value: 'Read the docs.' } });
};
const submit = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Recruit Agent' }));
  await waitFor(() => expect(createAgent()).toHaveBeenCalled());
  return createAgent().mock.calls[0][0] as { permissions?: { system_control: string[]; network_domains: unknown }; toolsPolicy?: { deny: string[] } };
};

describe('web browsing turned on in the form lets the helper browse', () => {
  it('sends browsing granted and not denied', async () => {
    await openForm();
    fireEvent.click(screen.getByText(/^Permissions/));
    const row = screen.getByText('Web Browsing').closest('.py-3') as HTMLElement;
    fireEvent.click(row.querySelector('button') as HTMLButtonElement);
    const sent = await submit();
    expect(sent.permissions?.system_control).toContain('web_browse');
    expect(sent.permissions?.network_domains).not.toBe('none');
    expect(sent.toolsPolicy?.deny ?? []).not.toContain('web_browse');
  });

  it('an untouched form sends no permissions of its own', async () => {
    await openForm();
    const sent = await submit();
    expect(sent.permissions).toBeUndefined();
  });
});
