// t148 round 3 (ruling 2) — THE DASHBOARD MUST NOT SAY "READY" FOR AN AGENT THE PLATFORM HAS
// PARKED. An agent held by the spending limit or by "no model fits" is `paused`, and the status pill
// said "Ready" for `paused`. It now says what the status is, and the pill's tooltip carries the true
// cause from the agent's `lastError` (the owner's words, the lock's tag stripped). The pill is the
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
  stub.getSetting = vi.fn(async () => ({ ok: true, data: null }));
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

const agent = (status: string, lastError: string | null): AgentDetail => ({
  id: 'a1', name: 'Dock Desk', modelId: 'auto', status, lastError, config: {}, agentType: 'standard', classification: 'ronin',
  createdAt: '', updatedAt: '', model: null, messageCount: 0, uptime: 0, permissions: null, toolsPolicy: null, equippedTechniques: [],
} as unknown as AgentDetail);

const show = (a: AgentDetail) => render(
  <MemoryRouter><AuthProvider><ActiveAgentProvider>
    <AgentCard agent={a} models={[]} providerNameById={{}} onModelChanged={() => undefined} />
  </ActiveAgentProvider></AuthProvider></MemoryRouter>,
);

describe('t148 r3 — the status pill of a parked agent', () => {
  it('says Paused, not Ready, and its tooltip carries the true cause without the lock\'s tag', () => {
    show(agent('paused', `[budget_stop] ${WORDS}`));
    const pill = document.querySelector('.status') as HTMLElement;
    expect(pill.textContent).toContain('Paused');
    expect(pill.textContent).not.toContain('Ready');
    expect(pill.getAttribute('title')).toBe(WORDS);
  });

  it('a no-fit park reads the same way', () => {
    show(agent('paused', '[no_model_fits] None of this agent\'s models can hold its instructions and tools, so its turn was not run.'));
    const pill = document.querySelector('.status') as HTMLElement;
    expect(pill.textContent).toContain('Paused');
    expect(pill.getAttribute('title')).toMatch(/^None of this agent's models/);
  });

  it('CONTROLS: a ready agent still says Ready with no tooltip; an error-loop pause says Paused with no invented cause', () => {
    const { unmount } = show(agent('idle', null));
    expect((document.querySelector('.status') as HTMLElement).textContent).toContain('Ready');
    expect((document.querySelector('.status') as HTMLElement).getAttribute('title')).toBeNull();
    unmount();
    show(agent('paused', 'repeated errors: boom'));
    const pill = document.querySelector('.status') as HTMLElement;
    expect(pill.textContent).toContain('Paused');
    expect(pill.getAttribute('title')).toBeNull();
    expect(screen.queryByText('Ready')).toBeNull();
  });
});
