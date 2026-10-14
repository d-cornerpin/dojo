// t148 round 3 (ruling 2) — THE DASHBOARD MUST NOT SAY "READY" FOR AN AGENT THE PLATFORM HAS
// PARKED. An agent held by the spending limit or by "no model fits" is `paused`, and the status pill
// said "Ready" for `paused`. It now says what the status is, and the pill's tooltip carries the true
// cause from the agent's `parkedCause` (the server's owner-facing words). The pill is the
// existing one; the only new thing on it is its `title`.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { AgentDetail } from '@dojo/shared';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.getSetting = vi.fn(async () => ({ ok: true, data: { key: 'setting', value: '' } }));
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});

import { AgentCard } from '../components/AgentCard';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { AuthProvider } from '../hooks/useAuth';

const WORDS = 'Today\'s spending limit is reached ($2.00 of $1.00), so this agent\'s turn was not run. Your message is kept.';

const agent = (status: string, parkedCause: string | null): AgentDetail => ({
  id: 'a1', name: 'Dock Desk', modelId: 'auto', status, parkedCause, config: {}, agentType: 'standard', classification: 'ronin',
  createdAt: '', updatedAt: '', model: null, messageCount: 0, uptime: 0, permissions: null, toolsPolicy: null, equippedTechniques: [],
} as unknown as AgentDetail);

const show = (a: AgentDetail) => render(
  <MemoryRouter><AuthProvider><ActiveAgentProvider>
    <AgentCard agent={a} models={[]} providerNameById={{}} onModelChanged={() => undefined} />
  </ActiveAgentProvider></AuthProvider></MemoryRouter>,
);

describe('t148 r3 — the status pill of a parked agent', () => {
  it('says Paused, not Ready, and its tooltip carries the true cause without the lock\'s tag', () => {
    show(agent('paused', WORDS));
    const pill = document.querySelector('.status') as HTMLElement;
    expect(pill.textContent).toContain('Paused');
    expect(pill.textContent).not.toContain('Ready');
    expect(pill.getAttribute('title')).toBe(WORDS);
  });

  it('a no-fit park reads the same way', () => {
    show(agent('paused', 'None of this agent\'s models can hold its instructions and tools, so its turn was not run.'));
    const pill = document.querySelector('.status') as HTMLElement;
    expect(pill.textContent).toContain('Paused');
    expect(pill.getAttribute('title')).toMatch(/^None of this agent's models/);
  });

  it('CONTROLS: a ready agent still says Ready with no tooltip; an error-loop pause says Paused with no invented cause', () => {
    const { unmount } = show(agent('idle', null));
    expect((document.querySelector('.status') as HTMLElement).textContent).toContain('Ready');
    expect((document.querySelector('.status') as HTMLElement).getAttribute('title')).toBeNull();
    unmount();
    show(agent('paused', null));
    const pill = document.querySelector('.status') as HTMLElement;
    expect(pill.textContent).toContain('Paused');
    expect(pill.getAttribute('title')).toBeNull();
    expect(screen.queryByText('Ready')).toBeNull();
  });
});

// ── the live frame: the pill's tooltip updates without a reload (review minor 5) ──
import { waitFor, act } from '@testing-library/react';
import * as api from '../lib/api';
import { Agents } from '../pages/Agents';
import { ThemeProvider } from '../themes/ThemeProvider';
import { emitFrame, resetFrames } from './helpers/frames';

describe('t148 r4 — the Agents page follows a park live', () => {
  it('a `paused` frame carrying the cause puts it on the pill; a later frame without it takes it off', async () => {
    resetFrames();
    (api.getAgents as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, data: [agent('idle', null)] });
    render(<MemoryRouter><AuthProvider><ThemeProvider><ActiveAgentProvider><Agents /></ActiveAgentProvider></ThemeProvider></AuthProvider></MemoryRouter>);
    await waitFor(() => expect(document.querySelector('.status')).not.toBeNull());
    expect(document.querySelector('.status')!.textContent).toContain('Ready');

    act(() => emitFrame('agent:status', { agentId: 'a1', status: 'paused', parkedCause: WORDS }));
    await waitFor(() => expect(document.querySelector('.status')!.getAttribute('title')).toBe(WORDS));
    expect(document.querySelector('.status')!.textContent).toContain('Paused');

    act(() => emitFrame('agent:status', { agentId: 'a1', status: 'idle' }));
    await waitFor(() => expect(document.querySelector('.status')!.textContent).toContain('Ready'));
    expect(document.querySelector('.status')!.getAttribute('title')).toBeNull();
  });
});
