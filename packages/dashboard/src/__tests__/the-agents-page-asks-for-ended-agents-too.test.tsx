// THE AGENTS PAGE IS THE ONE PAGE THAT SHOWS ENDED AGENTS, SO IT ASKS THE SERVER FOR ALL OF THEM.
// The list endpoint now answers with live agents only unless asked with `?all=1`; every other page
// keeps that default, and this page's "ended" section is the sole caller that must ask for more.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  return stub;
});
const toast = vi.hoisted(() => ({ calls: [] as Array<{ level: string; message: string }> }));
vi.mock('../hooks/useToast', () => {
  const record = (level: string) => (message: string) => { toast.calls.push({ level, message }); };
  const value = { toasts: [], addToast: () => {}, addActionToast: () => {}, removeToast: () => {}, removeToastByKey: () => {}, info: record('info'), success: record('success'), warning: record('warning'), error: record('error') };
  return { useToast: () => value, ToastProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { AuthProvider } from '../hooks/useAuth';
import { Agents } from '../pages/Agents';

beforeEach(() => {
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { key: 'setting', value: '' } } as never);
  vi.mocked(api.getAgents).mockResolvedValue({ ok: true, data: [] } as never);
  vi.mocked(api.getGroups).mockResolvedValue({ ok: true, data: [] } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the Agents page', () => {
  it('asks for every agent, ended ones included', async () => {
    render(<MemoryRouter><AuthProvider><ActiveAgentProvider><Agents /></ActiveAgentProvider></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(api.getAgents).toHaveBeenCalledWith({ all: true }));
  });
});
