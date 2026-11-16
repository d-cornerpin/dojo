// A reply to a person's channel carries a badge in the normal view that says where it stands: waiting to
// go, delivered, not delivered with the short reason, or not sent because the owner pressed Stop. A reply
// gets a "sending" mark and later a verdict mark; the badge shows only the newest, even when other
// messages arrived in between.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { formatRoutingMarker, withRoutingState, type RoutingState } from '@dojo/shared';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function' ? vi.fn(async () => ({ ok: true, data: [] })) : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  return { useToast: () => stub.value };
});

import * as api from '../lib/api';
import { Chat } from '../pages/Chat';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';

const ASKED = 'What is the address?';
const ANSWER = 'It is 1 Example Street.';
const LABEL = 'iMessage to Sam';

let seq = 0;
const at = () => `2020-01-01T00:00:${String(10 + seq++).padStart(2, '0')}.000Z`;
const row = (role: string, content: string) => ({ id: `m${seq}`, role, content, createdAt: at() });
const mark = (state?: [RoutingState, string?]) => row('system', formatRoutingMarker(state ? withRoutingState(LABEL, ...state) : LABEL));

const feed = async (rows: Array<ReturnType<typeof row>>) => {
  localStorage.setItem('dojo_wordy_mode', 'false');
  vi.mocked(api.getChatHistory).mockImplementation((async (_a: string, _l?: number, before?: string) => (
    { ok: true, data: before === undefined ? rows : [] })) as never);
  vi.mocked(api.getAgent).mockResolvedValue({ ok: true, data: { id: 'a-0001', name: 'the agent', status: 'idle' } } as never);
  const view = render(
    <MemoryRouter><OrbProvider><ActiveAgentProvider><RightDockProvider><TechniqueSessionProvider>
      <Chat />
    </TechniqueSessionProvider></RightDockProvider></ActiveAgentProvider></OrbProvider></MemoryRouter>,
  );
  await waitFor(() => expect(view.container.textContent).toContain(ANSWER));
  return view.container.textContent ?? '';
};

beforeEach(() => {
  resetFrames();
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"ok":false}', { status: 503, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { vi.clearAllMocks(); seq = 0; });

describe('a reply badge shows where the reply stands', () => {
  it('waiting to go', async () => {
    const text = await feed([row('user', ASKED), row('assistant', ANSWER), mark(['sending'])]);
    expect(text).toContain('sending by iMessage to Sam');
  });

  it('delivered, and the earlier "sending" is gone', async () => {
    const text = await feed([row('user', ASKED), row('assistant', ANSWER), mark(['sending']), mark()]);
    expect(text).toContain('to Sam via iMessage');
    expect(text).not.toContain('sending by');
  });

  it('not delivered, with the short reason', async () => {
    const text = await feed([row('user', ASKED), row('assistant', ANSWER), mark(['sending']), mark(['not delivered', 'Messages is not signed in'])]);
    expect(text).toContain('not delivered by iMessage to Sam: Messages is not signed in');
    expect(text).not.toContain('sending by');
  });

  it('dropped by Stop after other messages arrived: the reply shows only its newest state', async () => {
    const text = await feed([
      row('user', ASKED), row('assistant', ANSWER), mark(['sending']), row('user', 'Never mind.'), mark(['not sent', 'stopped by you']),
    ]);
    expect(text).toContain('not sent to Sam: stopped by you');
    expect(text).not.toContain('sending by');
    expect(text).not.toContain('Reply routed via');
  });
});
