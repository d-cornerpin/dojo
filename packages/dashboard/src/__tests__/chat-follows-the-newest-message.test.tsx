// ════════════════════════════════════════════════════════════════════════════
// GITHUB #23 (v3.5 lane t255, task C15): THE CHAT FOLLOWS THE NEWEST MESSAGE.
//
// The owner: "the chat used to scroll down to the newest message by itself, and
// it no longer does." The view follows only while it is PINNED to the bottom, and
// the one thing that un-pins is the scroll listener, which judged every scroll
// event by its distance from the bottom, including the events the page's OWN
// scrolls produce. A smooth `scrollIntoView` for a new message fires events at
// every step of its animation (all of them far from the bottom, because the new
// message is tall), and it lands where the bottom was when it STARTED, so any
// growth during the animation (the next message, a streamed chunk) leaves it
// short: the listener's last word is "not at the bottom" and the chat is
// un-pinned until the owner clicks the jump button. Streaming growth was also
// judged by a second 80-pixel test of its own instead of by the pin.
//
// happy-dom has no layout, so the scroll container is given one: its height is a
// function of what is rendered in it, `scrollTop` clamps like a real one, and the
// stand-in for `scrollIntoView` animates the way a browser does (events at
// intermediate positions, a landing at the target computed when it started).
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { emitFrame, resetFrames } from './helpers/frames';

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
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
    ToastContainer: () => null,
  };
});

import * as api from '../lib/api';
import { AuthProvider } from '../hooks/useAuth';
import { Chat } from '../pages/Chat';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';

const AGENT = 'primary';
const VIEWPORT = 500;

const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider><ThemeProvider><OrbProvider><ActiveAgentProvider>
      <RightDockProvider><TechniqueSessionProvider>{page}</TechniqueSessionProvider></RightDockProvider>
    </ActiveAgentProvider></OrbProvider></ThemeProvider></AuthProvider>
  </MemoryRouter>
);

const row = (id: string, content: string) => ({
  id, role: 'assistant', content, createdAt: new Date().toISOString(),
  modelId: null, attachments: null, source: null, origin: null, conversationId: null, displayKind: null,
});

/** A page of history tall enough to scroll: twelve rows, none older. */
const history = Array.from({ length: 12 }, (_, i) => row(`h${i}`, `earlier message ${i} `.repeat(6)));

/** The layout happy-dom lacks: height follows what is rendered; scrollTop clamps. */
function giveItALayout(el: HTMLElement) {
  let top = 0;
  let extra = 0; // content that grew WITHOUT React rendering it (a late image)
  const height = () => 40 * el.querySelectorAll('*').length + (el.textContent ?? '').length + extra;
  const max = () => Math.max(0, height() - VIEWPORT);
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: height });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => VIEWPORT });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.min(Math.max(0, v), max()); },
  });
  return {
    max,
    set: (v: number) => { el.scrollTop = v; },
    /** The browser's own scroll event, after the position changed. */
    fire: () => { el.dispatchEvent(new Event('scroll')); },
    grow: (px: number) => { extra += px; },
  };
}

/**
 * A browser's smooth scroll: the position moves in steps, each reported by a scroll event on a LATER
 * task, and it lands at the target computed when it STARTED. `step()` runs one queued step, `land()` all.
 */
function installSmoothScrollIntoView(el: HTMLElement, lay: ReturnType<typeof giveItALayout>) {
  const queue: Array<() => void> = [];
  const smooth = function smooth() {
    const target = lay.max();
    const mid = el.scrollTop + (target - el.scrollTop) / 2;
    queue.push(() => { el.scrollTop = mid; lay.fire(); });
    queue.push(() => { el.scrollTop = target; lay.fire(); });
  };
  Element.prototype.scrollIntoView = smooth;
  HTMLElement.prototype.scrollIntoView = smooth;
  const land = () => { while (queue.length) queue.shift()!(); };
  land.step = () => { queue.shift()?.(); };
  return land;
}

const message = (id: string, content: string) => ({
  agentId: AGENT,
  message: { id, role: 'assistant', content, createdAt: new Date().toISOString(), attachments: null, conversationId: null },
});
const jumpButton = () => screen.queryByRole('button', { name: 'Jump to latest messages' });

async function openBusyChat() {
  vi.mocked(api).getAgent.mockImplementation((async (id: string) => ({
    ok: true, data: { id, name: id, status: 'idle', inFlight: { turn: 0, background: 0 } },
  })) as unknown as typeof api.getAgent);
  vi.mocked(api).getChatHistory.mockImplementation((async (_id: string, _l?: number, before?: string) => (
    { ok: true, data: before ? [] : history }
  )) as unknown as typeof api.getChatHistory);
  const view = render(shell(<Chat />));
  await waitFor(() => expect(screen.queryByText(/earlier message 11/)).not.toBeNull());
  await act(async () => { await new Promise((r) => setTimeout(r, 650)); }); // the load's own settling scrolls
  const el = view.container.querySelector('.dojo3-chat-scroll') as HTMLElement;
  const lay = giveItALayout(el);
  lay.set(lay.max());
  lay.fire();
  return { el, lay };
}

const realElementScroll = Element.prototype.scrollIntoView;
const realHtmlScroll = HTMLElement.prototype.scrollIntoView;
beforeEach(() => { resetFrames(); });
afterEach(() => { Element.prototype.scrollIntoView = realElementScroll; HTMLElement.prototype.scrollIntoView = realHtmlScroll; vi.resetAllMocks(); });

describe('the chat follows the newest message', () => {
  it('a pinned chat that receives a message is scrolled to it', async () => {
    const { el, lay } = await openBusyChat();
    const land = installSmoothScrollIntoView(el, lay);
    await act(async () => { emitFrame('chat:message', message('n1', 'a new reply '.repeat(30))); });
    await act(async () => { land(); await new Promise((r) => setTimeout(r, 50)); });
    expect(el.scrollTop, 'the new message is not in view').toBe(lay.max());
    expect(jumpButton(), 'the jump button shows on a chat that is at the bottom').toBeNull();
  });

  it('a second message arriving while the first is still being scrolled to is followed too', async () => {
    const { el, lay } = await openBusyChat();
    const land = installSmoothScrollIntoView(el, lay);
    await act(async () => { emitFrame('chat:message', message('n1', 'first reply '.repeat(30))); });
    await act(async () => { land.step(); });   // the first leg of the animation is reported
    await act(async () => { emitFrame('chat:message', message('n2', 'second reply '.repeat(30))); });
    await act(async () => { land(); await new Promise((r) => setTimeout(r, 50)); });
    expect(el.scrollTop, 'the chat stopped short of the newest message').toBe(lay.max());
    expect(jumpButton(), 'the chat un-pinned itself').toBeNull();
  });

  it('a streamed answer that grows by more than a few lines at once is followed', async () => {
    const { el, lay } = await openBusyChat();
    const land = installSmoothScrollIntoView(el, lay);
    await act(async () => { emitFrame('chat:chunk', { agentId: AGENT, messageId: 's1', content: 'starting ', done: false }); });
    await act(async () => { emitFrame('chat:chunk', { agentId: AGENT, messageId: 's1', content: 'a long paragraph '.repeat(40), done: false }); });
    await act(async () => { land(); await new Promise((r) => setTimeout(r, 50)); });
    expect(el.scrollTop, 'the streamed answer ran off the bottom').toBe(lay.max());
  });

  it('content that grows after our own scroll (a late image) does not un-pin', async () => {
    const { el, lay } = await openBusyChat();
    const land = installSmoothScrollIntoView(el, lay);
    await act(async () => { emitFrame('chat:message', message('n1', 'a reply '.repeat(30))); });
    await act(async () => { land(); await new Promise((r) => setTimeout(r, 50)); });
    lay.grow(300);   // the browser reports our scroll after the layout moved on
    lay.fire();
    await act(async () => { land(); await new Promise((r) => setTimeout(r, 50)); });
    expect(jumpButton(), 'a scroll event of our own making un-pinned the chat').toBeNull();
    await act(async () => { emitFrame('chat:message', message('n2', 'and another '.repeat(30))); });
    await act(async () => { land(); await new Promise((r) => setTimeout(r, 50)); });
    expect(el.scrollTop, 'the next message was not followed').toBe(lay.max());
  });

  it('an owner who scrolled up to read is left where they are, with the jump button', async () => {
    const { el, lay } = await openBusyChat();
    const land = installSmoothScrollIntoView(el, lay);
    lay.set(lay.max() - 200);
    lay.fire();
    await waitFor(() => expect(jumpButton(), 'no jump button after scrolling up').not.toBeNull());
    const where = el.scrollTop;
    await act(async () => { emitFrame('chat:message', message('n1', 'a reply '.repeat(30))); });
    await act(async () => { land(); await new Promise((r) => setTimeout(r, 50)); });
    expect(el.scrollTop, 'the chat yanked a reader down').toBe(where);
    expect(jumpButton()).not.toBeNull();
  });
});
