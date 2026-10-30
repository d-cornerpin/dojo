// ════════════════════════════════════════════════════════════════════════════
// THE LIST ON THE TECHNIQUES PAGE MATCHES THE CONTROLS ON THE TECHNIQUES PAGE.
//
// Three ways it used to drift:
//   1. The debounced-search effect ran once after mount (and again after every
//      keystroke) through the `load` of the render it was created in. A tab or
//      tag clicked before it fired was then fetched UNFILTERED, and that answer
//      replaced the filtered list while the tab still said "Drafts".
//   2. Answers were applied in the order they ARRIVED, not the order they were
//      asked for, so a slow answer to an old filter overwrote the newer one.
//   3. (1) again from the other side: typing, then clicking a tab inside the
//      300ms window, fetched the search under the tab that was selected when the
//      timer was set.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
  const pinned = fakeUseWebSocket();
  return {
    useWebSocket: () => pinned,
    WebSocketProvider: ({ children }: { children: ReactElement }) => children,
  };
});

import * as api from '../lib/api';
import { Techniques } from '../pages/Techniques';
import { ToastProvider } from '../hooks/useToast';

const mount = () => render(<ToastProvider><MemoryRouter><Techniques /></MemoryRouter></ToastProvider>);

const mocked = () => vi.mocked(api);

const make = (name: string, state: string) => ({
  id: `id-${name}`, name, description: null, state, tags: [], authorAgentName: null,
  enabled: true, usageCount: 0, lastUsedAt: null, version: 1, createdAt: '2026-01-01T00:00:00Z',
});
const TABLE = [
  make('Alpha Published', 'published'),
  make('Alpha Draft', 'draft'),
  make('Beta Draft', 'draft'),
];

/** What the server would answer for a path: the table, filtered by the query. */
const answer = (path: string) => {
  const q = new URLSearchParams(path.split('?')[1] ?? '');
  const state = q.get('state');
  const search = q.get('search');
  return {
    ok: true,
    data: TABLE.filter(t => (!state || t.state === state)
      && (!search || t.name.toLowerCase().includes(search.toLowerCase()))),
  } as never;
};

const callCount = () => mocked().request.mock.calls.length;
const shown = () => screen.queryAllByText(/^(Alpha|Beta) /).map(e => e.textContent);

beforeEach(() => {
  resetFrames();
  mocked().request.mockImplementation(async (path: string) => answer(path));
});
afterEach(() => { vi.clearAllMocks(); });

describe('The Techniques list always matches the state tab, tag filter and search box', () => {
  it('⚠ a tab clicked right after opening is not undone by the page\'s own debounced reload', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));
    await waitFor(() => expect(mocked().request).toHaveBeenCalledWith('/techniques?state=draft'));

    // Let the 300ms debounce fire; it must not bring the other rows back.
    const before = callCount();
    await waitFor(() => expect(callCount()).toBeGreaterThan(before), { timeout: 1500 });
    await act(async () => {});

    expect(shown().sort()).toEqual(['Alpha Draft', 'Beta Draft']);
  });

  it('⚠ typing and then clicking a tab inside the debounce window loads the search under the NEW tab', async () => {
    mount();
    await waitFor(() => expect(mocked().request).toHaveBeenCalledWith('/techniques?'));

    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'alpha' } });
    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));

    // Mount load, the tab's load, then the debounced one.
    await waitFor(() => expect(callCount()).toBeGreaterThanOrEqual(3), { timeout: 1500 });
    await act(async () => {});

    expect(mocked().request).toHaveBeenCalledWith('/techniques?state=draft&search=alpha');

    expect(shown()).toEqual(['Alpha Draft']);
  });

  it('⚠ a slow answer to an old filter does not overwrite the answer to the current one', async () => {
    const pending: Record<string, (v: never) => void> = {};
    mocked().request.mockImplementation((path: string) => {
      if (path === '/techniques?state=draft') {
        return new Promise(resolve => { pending[path] = () => resolve(answer(path)); });
      }
      return Promise.resolve(answer(path));
    });
    mount();
    await waitFor(() => expect(shown().length).toBe(3));

    fireEvent.click(screen.getByRole('button', { name: 'Drafts' }));
    await waitFor(() => expect(pending['/techniques?state=draft']).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Published' }));
    await waitFor(() => expect(shown()).toEqual(['Alpha Published']));

    // The Drafts answer finally arrives, after the Published one.
    await act(async () => { pending['/techniques?state=draft'](undefined as never); });

    expect(shown()).toEqual(['Alpha Published']);
  });
});
