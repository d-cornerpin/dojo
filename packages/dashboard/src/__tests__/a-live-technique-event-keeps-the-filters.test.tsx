// ════════════════════════════════════════════════════════════════════════════
// A LIVE TECHNIQUE EVENT RELOADS THE LIST THE OWNER IS LOOKING AT.
//
// `load` reads `stateFilter`/`tagFilter`/`search` from the render it was created
// in. The websocket effect subscribes once — `[subscribe]`, and the real hook's
// `subscribe` is a `useCallback([], …)` that never changes — so its handlers
// kept calling the FIRST render's load. Every `technique:used` frame (every
// agent use of every technique) then fetched the UNFILTERED list and replaced
// what was on screen, while the chip still said "Published" and the search box
// still held the query. The page must keep a ref to the latest `load` and let
// the handlers go through it.
//
// One adaptation of the usual fake: `fakeUseWebSocket` builds a NEW subscribe
// on every call, which would re-run the effect on every render and hand its
// handlers a fresh `load` — the opposite of production, where the effect runs
// once. Pinning one instance is what lets this file see the mount-time binding
// the owner is actually exposed to; `emitFrame` and the handler registry stay
// the shared ones from ./helpers/frames.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames, emitFrame } from './helpers/frames';

// The permissive factory from `a-failed-load-says-so` — every exported FUNCTION
// answers `{ ok: true, data: [] }`, so the page mounts on its own terms and the
// only thing this file observes is WHICH path each reload asks for.
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
  const pinned = fakeUseWebSocket();
  return {
    useWebSocket: () => pinned,
    WebSocketProvider: ({ children }: { children: ReactElement }) => children,
  };
});

import * as api from '../lib/api';
import { Techniques } from '../pages/Techniques';
import { ToastProvider } from '../hooks/useToast';

const mocked = () => vi.mocked(api);

/** The path of the most recent call the page made through the generic door. */
const lastCall = (): string => {
  const calls = mocked().request.mock.calls;
  return String(calls[calls.length - 1]?.[0]);
};

beforeEach(() => {
  resetFrames();
  mocked().request.mockImplementation(async (_path: string) => ({ ok: true, data: [] } as never));
});
afterEach(() => { vi.clearAllMocks(); });

describe('A live technique event refreshes the list the filters drew, not the whole table', () => {
  it('⚠ technique:used while the Published chip is on reloads the PUBLISHED list', async () => {
    render(<ToastProvider><MemoryRouter><Techniques /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(mocked().request).toHaveBeenCalledWith('/techniques?'));

    fireEvent.click(screen.getByRole('button', { name: 'Published' }));
    await waitFor(() => expect(mocked().request).toHaveBeenCalledWith('/techniques?state=published'));

    // The page's own 300ms search-debounce fires once after mount (it used to
    // fetch unfiltered under the chip — that was the bug, not the contract; it
    // now reloads with the current filters). Let that call pass by before the
    // frame arrives, so only the frame's reload can be its successor.
    await waitFor(() => expect(mocked().request).toHaveBeenCalledTimes(3), { timeout: 1500 });
    expect(lastCall()).toBe('/techniques?state=published');

    await act(async () => { emitFrame('technique:used', {}); });

    expect(lastCall(), 'the frame reloaded the unfiltered list under the Published chip')
      .toBe('/techniques?state=published');
  });

  it('⚠ technique:published while a search is typed reloads the SEARCHED list', async () => {
    render(<ToastProvider><MemoryRouter><Techniques /></MemoryRouter></ToastProvider>);
    await waitFor(() => expect(mocked().request).toHaveBeenCalledWith('/techniques?'));

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'alpha' } });
    await waitFor(
      () => expect(mocked().request).toHaveBeenCalledWith('/techniques?search=alpha'),
      { timeout: 1000 },
    );

    await act(async () => { emitFrame('technique:published', {}); });

    expect(lastCall(), 'the frame reloaded the unfiltered list under the search box')
      .toBe('/techniques?search=alpha');
  });
});
