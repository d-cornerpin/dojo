// X connection drops and returns, Chat asks again: replies and the working/idle
// state sent in the gap were lost. The shared reconnect signal (`reconnectCount`) drives it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../lib/api');
  const stub: Record<string, unknown> = {};
  for (const key of Object.keys(actual)) {
    stub[key] = typeof actual[key] === 'function'
      ? vi.fn(async () => ({ ok: true, data: [] }))
      : actual[key];
  }
  stub.getToken = vi.fn(() => null);
  stub.clearToken = vi.fn(() => undefined);
  return stub;
});
vi.mock('../hooks/useWebSocket', async () => {
  const { fakeUseWebSocket } = await import('./helpers/frames');
  return { useWebSocket: fakeUseWebSocket, WebSocketProvider: ({ children }: { children: ReactElement }) => children };
});
vi.mock('../hooks/useToast', async () => {
  const { fakeToast } = await import('./helpers/frames');
  const stub = fakeToast();
  (globalThis as { __toastStub?: typeof stub }).__toastStub = stub;
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
  };
});

import * as api from '../lib/api';
import { AuthProvider } from '../hooks/useAuth';
import { Chat } from '../pages/Chat';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';

const AGENT = 'primary';
const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider><OrbProvider><ActiveAgentProvider>
      <RightDockProvider><TechniqueSessionProvider>{page}</TechniqueSessionProvider></RightDockProvider>
    </ActiveAgentProvider></OrbProvider></AuthProvider>
  </MemoryRouter>
);


const toasts = () => (globalThis as unknown as { __toastStub: { calls: Array<{ level: string; message: string }> } }).__toastStub.calls;
const history = () =>
  vi.mocked(api).getChatHistory.mockImplementation((async () => ({ ok: true, data: [] })) as unknown as typeof api.getChatHistory);
const agent = () =>
  vi.mocked(api).getAgent.mockResolvedValue({
    ok: true, data: { id: AGENT, name: 'Agent', status: 'idle', inFlight: { turn: 0, background: 0 } },
  } as unknown as Awaited<ReturnType<typeof api.getAgent>>);
const typeAndSend = async (text: string) => {
  const box = await screen.findByPlaceholderText('Message the Dojo');
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: 'Enter' });
};

beforeEach(() => { resetFrames(); toasts().length = 0; vi.mocked(api).getCanvas.mockResolvedValue({ ok: true, data: null } as never); });
afterEach(() => { vi.resetAllMocks(); });

const box = () => screen.getByPlaceholderText('Message the Dojo') as HTMLTextAreaElement;
const errorToast = () => toasts().find((t) => t.level === 'error')!.message;

describe('a refused chat message', () => {
  it('leaves no sent bubble, puts the text back in the box, and the toast says so without the text', async () => {
    history(); agent();
    vi.mocked(api).sendMessage.mockResolvedValue({ ok: false, error: 'Agent is terminated' } as never);
    render(shell(<Chat />));
    await typeAndSend('hello there');
    await waitFor(() => expect(toasts().some((t) => t.level === 'error')).toBe(true));
    expect(errorToast()).toContain('Agent is terminated');
    expect(errorToast()).toContain('not sent');
    expect(errorToast()).toContain('back in the box');
    expect(errorToast()).not.toContain('hello there');
    expect(screen.queryByText('hello there', { selector: ':not(textarea)' })).toBeNull();
    await waitFor(() => expect(box().value).toBe('hello there'));
  });

  it('attachments come back too and go out with the resend', async () => {
    history(); agent();
    const att = { fileId: 'f1', filename: 'notes.txt', mimeType: 'text/plain', size: 3, path: '/x/notes.txt', category: 'text' };
    vi.mocked(api).uploadFiles.mockResolvedValue({ ok: true, data: [att] } as never);
    vi.mocked(api).sendMessage.mockResolvedValueOnce({ ok: false, error: 'Agent is terminated' } as never);
    const { container } = render(shell(<Chat />));
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['abc'], 'notes.txt', { type: 'text/plain' })] } });
    await typeAndSend('see file');
    await waitFor(() => expect(box().value).toBe('see file'));
    await screen.findByLabelText('Remove notes.txt');
    vi.mocked(api).sendMessage.mockResolvedValueOnce({ ok: true, data: {} } as never);
    fireEvent.keyDown(box(), { key: 'Enter' });
    await waitFor(() => expect(vi.mocked(api).sendMessage).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api).sendMessage.mock.calls[1][2]).toEqual([att]);
  });

  it('keeps what he typed since: the box is not overwritten and the toast carries a short preview', async () => {
    history(); agent();
    let refuse: (v: unknown) => void = () => {};
    vi.mocked(api).sendMessage.mockReturnValue(new Promise((r) => { refuse = r; }) as never);
    const long = 'abc '.repeat(60);
    render(shell(<Chat />));
    await typeAndSend(long);
    await waitFor(() => expect(vi.mocked(api).sendMessage).toHaveBeenCalled());
    fireEvent.change(box(), { target: { value: 'something new' } });
    await act(async () => { refuse({ ok: false, error: 'Agent is terminated' }); });
    await waitFor(() => expect(toasts().some((t) => t.level === 'error')).toBe(true));
    expect(box().value).toBe('something new');
    expect(errorToast()).toContain('not sent');
    expect(errorToast()).toContain('abc abc');
    expect(errorToast().length).toBeLessThan(200);
  });

  it('a sent message keeps its bubble', async () => {
    history(); agent();
    vi.mocked(api).sendMessage.mockResolvedValue({ ok: true, data: {} } as never);
    render(shell(<Chat />));
    await typeAndSend('hello there');
    await waitFor(() => expect(screen.queryByText('hello there')).not.toBeNull());
    expect(toasts().some((t) => t.level === 'error')).toBe(false);
  });
});
