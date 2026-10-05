// ════════════════════════════════════════════════════════════════════════════
// A FAILED LOAD DRAWS SOMETHING (BACKLOG line 31, the two unhandled-rejection
// sites) — review I1.
//
// ── WHY THIS FILE EXISTS, AND WHY THE SMOKE FLOOR WAS NOT ENOUGH ──
// Both sites were fixed in code and both were left unheld. Review found it:
// nothing in this package rendered either page with the door ANSWERING FAILURE.
// `every-major-page-mounts.test.tsx` mocks every door as `{ ok: true, data: [] }`,
// so it drives the happy path only; its tripwire-armed form reds a reverted
// direct `fetch` — an A2 mutant — not a failed load that draws nothing, which is
// the A1 defect. The brief asked for "a clause per site using the dashboard's
// test runner", and this is it.
//
// ── WHAT THE DEFECT ACTUALLY WAS, PER SITE ──
//
//   `pages/Techniques.tsx` — `fetchTechniques` answered `data.ok ? data.data : []`
//   on a bare `fetch` with no `.catch`, inside a loader an effect calls without
//   awaiting. So "the server is down" and "you have no techniques yet" were THE
//   SAME EMPTY GRID, and with no server at all the rejection left the page
//   entirely.
//
//   `pages/Settings.tsx` — worse, and this is the clause worth the most below.
//   `RemoteAccessSettings`'s `load` left `status` null on failure, and null is
//   what that card renders as "cloudflared is not installed." A failed read told
//   the owner a LIE ABOUT HIS OWN BOX and offered to install software he already
//   has. So the clause asserts an ABSENCE as well as a presence: the lie must not
//   be on screen while the load is known to have failed. An error banner added
//   next to a surviving lie would satisfy a weaker test.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { resetFrames } from './helpers/frames';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real — so the page under
// test mounts on its own terms and the ONE door this file is about is the only
// thing that fails.
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
import { Techniques } from '../pages/Techniques';
import { Settings } from '../pages/Settings';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';

/** The shell `App.tsx` puts every page inside — same nesting as the smoke floor. */
const shell = (page: ReactElement) => (
  <MemoryRouter>
    <AuthProvider>
      <ThemeProvider>
        <OrbProvider>
          <ActiveAgentProvider>
            <RightDockProvider>
              <TechniqueSessionProvider>
                {page}
              </TechniqueSessionProvider>
            </RightDockProvider>
          </ActiveAgentProvider>
        </OrbProvider>
      </ThemeProvider>
    </AuthProvider>
  </MemoryRouter>
);

const mocked = () => vi.mocked(api);

/** Calls the generic door has taken for a path with this prefix. */
const callsTo = (prefix: string): number =>
  mocked().request.mock.calls.filter((c) => String(c[0]).startsWith(prefix)).length;

beforeEach(() => {
  resetFrames();
  // THE WHOLE POINT: the door answers failure, as a VALUE. That is what the door
  // guarantees now — before this lane these sites got a REJECTION, which is why
  // the defect was an unhandled rejection rather than a visible error.
  mocked().request.mockResolvedValue({ ok: false, error: 'offline' } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('Techniques says so when the list cannot be loaded', () => {
  it('⚠ draws the failure instead of an empty grid', async () => {
    render(shell(<Techniques />));

    const banner = await screen.findByText(/Could not load techniques/);
    expect(banner.textContent, 'the door’s reason reaches the owner').toContain('offline');

    // And it is NOT the "you have none yet" empty state, which is the lie this
    // replaces — the two were indistinguishable before.
    expect(screen.queryByText(/No techniques yet/), 'the empty-state copy is a different claim')
      .toBeNull();
  });

  it('⚠ Retry asks the door again', async () => {
    render(shell(<Techniques />));
    const banner = await screen.findByText(/Could not load techniques/);

    // Let the page's own 300ms search debounce fire first, so the extra call it
    // makes cannot be mistaken for the click's. (Measured while writing this: the
    // debounced effect runs once after mount.)
    await new Promise((r) => { setTimeout(r, 400); });
    mocked().request.mockClear();
    expect(callsTo('/techniques'), 'the page settled before the click').toBe(0);

    fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(callsTo('/techniques')).toBeGreaterThan(0));
  });
});

describe('Remote Access stops claiming cloudflared is missing when it simply does not know', () => {
  // `activeTab` defaults to 'platform', and `PlatformTab` renders
  // `RemoteAccessSettings`, so rendering the page is enough to reach the card.
  it('⚠ draws the failure, and NOT the lie about the box', async () => {
    render(shell(<Settings />));

    const banner = await screen.findByText(/Could not read the tunnel status/);
    expect(banner.textContent).toContain('offline');

    // ── THE ASSERTION THIS CLAUSE EXISTS FOR ──
    // `status` stays null when the read fails, and null is what the card used to
    // render as an install offer. An error banner beside a surviving lie would
    // pass a weaker test; the lie has to be GONE.
    expect(
      screen.queryByText(/cloudflared is not installed/),
      'the card still tells the owner his box is missing software, on a failed READ',
    ).toBeNull();
  });

  it('⚠ Retry asks the door again', async () => {
    render(shell(<Settings />));
    const banner = await screen.findByText(/Could not read the tunnel status/);

    mocked().request.mockClear();
    fireEvent.click(within(banner).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(callsTo('/system/tunnel')).toBeGreaterThan(0));
  });
});
