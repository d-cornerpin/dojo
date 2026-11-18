// THE AGENTS PAGE USES ONE SET OF WORDS: SQUAD, ENDED, PLAIN SENTENCES.
// The page's buttons already said "Form Squad" and "21 ended"; the form labels still said "Group",
// the history toggle said "terminated agents", and the form copy said the description is "injected".
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { AgentDetail } from '@dojo/shared';

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

const agent = (over: Partial<AgentDetail> = {}): AgentDetail => ({
  id: 'a1', name: 'Kite', modelId: 'auto', status: 'idle', config: { orbHue: 172 }, agentType: 'standard', classification: 'ronin',
  createdAt: '', updatedAt: '', model: null, messageCount: 0, uptime: 0, permissions: null, toolsPolicy: null, equippedTechniques: [],
  ...over,
} as unknown as AgentDetail);

beforeEach(() => {
  toast.calls.length = 0;
  vi.mocked(api.getSetting).mockResolvedValue({ ok: true, data: { key: 'setting', value: '' } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

const page = () => render(<MemoryRouter><AuthProvider><ActiveAgentProvider><Agents /></ActiveAgentProvider></AuthProvider></MemoryRouter>);
const ended = Array.from({ length: 21 }, (_, i) => agent({ id: `e${i}`, name: `Ended ${i}`, status: 'terminated' }));

describe('the Agents page words', () => {
  it('says ended, not terminated', async () => {
    vi.mocked(api.getAgents).mockResolvedValue({ ok: true, data: ended } as never);
    vi.mocked(api.getGroups).mockResolvedValue({ ok: true, data: [] } as never);
    page();
    fireEvent.click(await screen.findByRole('button', { name: /Recent History/ }));   // opens the ended section
    expect(await screen.findByText(/Show all 21 ended agents/)).toBeTruthy();
    expect(screen.queryByText(/terminated agents/)).toBeNull();
  });
  it('the Form Squad form says squad', async () => {
    vi.mocked(api.getAgents).mockResolvedValue({ ok: true, data: [] } as never);
    vi.mocked(api.getGroups).mockResolvedValue({ ok: true, data: [] } as never);
    page();
    fireEvent.click(await screen.findByRole('button', { name: '+ Form Squad' }));
    expect(screen.getByText('Squad name')).toBeTruthy();
    expect(screen.getByText(/A squad gathers agents around a shared purpose/)).toBeTruthy();
    expect(screen.queryByText(/injected/)).toBeNull();
  });
});
