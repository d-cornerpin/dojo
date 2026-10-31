// A REFUSED COLOUR SAVE AND A REFUSED DROP ON "UNASSIGNED" BOTH SAY SO AND PUT BACK WHAT THEY TOOK.
// The card's pickColor and the ungrouped section's drop awaited the server and threw its answer away:
// a refusal left the new colour showing as if saved, and a refused move-out of a squad passed in
// silence. No new UX — the server's words ride the existing toast, the way RouterTab's save does.
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
  return { useToast: () => value, ToastProvider: ({ children }: { children: ReactElement }) => children, ToastContainer: () => null };
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import * as api from '../lib/api';
import { AgentCard } from '../components/AgentCard';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { AuthProvider } from '../hooks/useAuth';
import { Agents } from '../pages/Agents';
import { ThemeProvider } from '../themes/ThemeProvider';

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

const show = (a: AgentDetail) => render(
  <MemoryRouter><AuthProvider><ActiveAgentProvider>
    <AgentCard agent={a} models={[]} providerNameById={{}} onModelChanged={() => undefined} />
  </ActiveAgentProvider></AuthProvider></MemoryRouter>,
);

// Which palette swatch the open picker marks as current — the colour the card itself is showing.
const activeSwatch = () => document.querySelector('.agent-color-swatch.is-active')?.getAttribute('aria-label') ?? null;

describe('the card colour picker', () => {
  it('a refused colour says why and the old one is shown again', async () => {
    vi.mocked(api.updateAgentConfig).mockResolvedValue({ ok: false, error: 'denied' } as never);
    show(agent());
    fireEvent.click(screen.getByTitle("Set Kite's colour"));
    expect(activeSwatch()).toBe('Teal');   // the stored colour is the active swatch to begin with
    fireEvent.click(screen.getByRole('button', { name: 'Rose' }));
    await waitFor(() => expect(toast.calls).toContainEqual({ level: 'error', message: 'denied' }));
    fireEvent.click(screen.getByTitle("Set Kite's colour"));
    expect(activeSwatch()).toBe('Teal');   // the refusal put the old colour back, not the one it rejected
  });
});

describe('the Unassigned drop zone', () => {
  it('a refused move out of a squad says so', async () => {
    vi.mocked(api.getAgents).mockResolvedValue({ ok: true, data: [agent({ groupId: 'g1' })] } as never);
    vi.mocked(api.getGroups).mockResolvedValue({
      ok: true,
      data: [{ id: 'g1', name: 'Research', description: null, createdBy: 'me', color: '', memberCount: 1, createdAt: '' }],
    } as never);
    vi.mocked(api.assignAgentToGroupApi).mockResolvedValue({ ok: false, error: 'denied' } as never);
    render(<MemoryRouter><AuthProvider><ThemeProvider><ActiveAgentProvider><Agents /></ActiveAgentProvider></ThemeProvider></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Unassigned')).toBeTruthy());
    const ungrouped = screen.getByText('Unassigned').closest('section') as HTMLElement;
    fireEvent.drop(ungrouped, { dataTransfer: { getData: () => 'a1' } });
    await waitFor(() => expect(toast.calls).toContainEqual({ level: 'error', message: 'denied' }));
  });
});
