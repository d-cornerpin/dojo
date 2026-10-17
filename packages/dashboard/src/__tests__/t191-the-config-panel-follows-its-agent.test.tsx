// ════════════════════════════════════════════════════════════════════════════
// GITHUB #14 (v3.4 lane t191), THE CONFIG PANEL'S SHARE: `agents/:id` reuses one
// `AgentConfigPanel` for every id, and it neither reset its `loading` nor cancelled a
// slow fetch when the id changed. The old agent's card stayed on screen under the new
// id, and a late answer for the old agent could overwrite the new one.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import type { ReactElement } from 'react';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  return stub;
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value, ToastProvider: ({ children }: { children: ReactElement }) => children, ToastContainer: () => null };
});

import * as api from '../lib/api';
import { AgentConfigPanel } from '../pages/AgentConfigPanel';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function defer<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const detail = (id: string, name: string) => ({
  ok: true, data: { id, name, classification: 'worker', status: 'idle', modelId: 'auto', inFlight: { turn: 0, background: 0 } },
});

function Go() {
  const nav = useNavigate();
  return <><button onClick={() => nav('/agents/b')}>go-b</button><button onClick={() => nav('/agents/a')}>go-a</button></>;
}
const tree = () => (
  <MemoryRouter initialEntries={['/agents/a']}>
    <ActiveAgentProvider>
      <Routes><Route path="agents/:id" element={<AgentConfigPanel />} /></Routes>
      <Go />
    </ActiveAgentProvider>
  </MemoryRouter>
);

afterEach(() => { vi.resetAllMocks(); });

describe('the config panel follows its agent', () => {
  it('the old agent is gone the moment the id changes, and a late answer for it never lands', async () => {
    const slowA = defer<unknown>();
    const slowB = defer<unknown>();
    vi.mocked(api).getAgent.mockImplementation((async (id: string) => {
      if (id === 'a') return detail('a', 'Agent-Aye');
      await slowB.promise;
      return detail('b', 'Agent-Bee');
    }) as unknown as typeof api.getAgent);
    void slowA;
    render(tree());
    await waitFor(() => expect(screen.queryAllByText('Agent-Aye').length).toBeGreaterThan(0));

    act(() => { screen.getByText('go-b').click(); });
    expect(screen.queryAllByText('Agent-Aye').length, 'A\'s card stayed up under B\'s id').toBe(0);

    await act(async () => { slowB.resolve(undefined); await Promise.resolve(); });
    await waitFor(() => expect(screen.queryAllByText('Agent-Bee').length).toBeGreaterThan(0));
    expect(screen.queryAllByText('Agent-Aye').length).toBe(0);
  });
});
