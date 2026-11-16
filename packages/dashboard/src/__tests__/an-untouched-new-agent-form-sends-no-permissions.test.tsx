// The owner recruits a helper on the Agents page without opening its permissions: the form sends no
// permissions of its own, so the server's one helper default applies.
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
  return createAgent().mock.calls[0][0] as { permissions?: unknown };
};

describe('an untouched new-agent form sends no permissions', () => {
  it('sends none', async () => {
    await openForm();
    const sent = await submit();
    expect(sent.permissions).toBeUndefined();
  });
});
