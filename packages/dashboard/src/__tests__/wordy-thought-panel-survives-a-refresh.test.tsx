// In Wordy mode an answer that came with the model's thinking shows a "Thought" panel above it.
// A refresh loads the chat from the server, which sends the thinking with the message, so the
// panel is still there after a reload or a new conversation.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
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

const ANSWER = 'The shorter route is the coast road.';
const THINKING = 'I compared the coast road with the hill road.';

const rows = [
  { id: 'm1', role: 'user', content: 'Which route is shorter?', createdAt: '2020-01-01T00:00:10.000Z' },
  { id: 'm2', role: 'assistant', content: ANSWER, createdAt: '2020-01-01T00:00:11.000Z', reasoningContent: THINKING },
];

const open = async () => {
  localStorage.setItem('dojo_wordy_mode', 'true');
  vi.mocked(api.getChatHistory).mockImplementation((async (_a: string, _l?: number, before?: string) => (
    { ok: true, data: before === undefined ? rows : [] })) as never);
  vi.mocked(api.getAgent).mockResolvedValue({ ok: true, data: { id: 'a-0001', name: 'the agent', status: 'idle' } } as never);
  const view = render(
    <MemoryRouter><OrbProvider><ActiveAgentProvider><RightDockProvider><TechniqueSessionProvider>
      <Chat />
    </TechniqueSessionProvider></RightDockProvider></ActiveAgentProvider></OrbProvider></MemoryRouter>,
  );
  await waitFor(() => expect(view.container.textContent).toContain(ANSWER));
  return view;
};

beforeEach(() => {
  resetFrames();
  vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"ok":false}', { status: 503, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { vi.clearAllMocks(); });

describe('wordy thought panel survives a refresh', () => {
  it('opening the panel shows the thinking the server sent', async () => {
    const view = await open();
    fireEvent.click(view.getByText('Thought'));
    expect(view.container.textContent).toContain(THINKING);
  });
});
