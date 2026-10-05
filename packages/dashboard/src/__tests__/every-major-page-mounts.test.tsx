// ════════════════════════════════════════════════════════════════════════════
// EVERY MAJOR PAGE MOUNTS — THE SMOKE FLOOR.
//
// ── WHY A FLOOR AND NOT A FEATURE TEST ──
// `tsc && vite build` proves every type lines up and every import resolves. It
// does not run one line of a component, so the whole class of defect that only
// happens at RENDER time has never been caught in this package by anything but a
// person opening a tab: a hook called conditionally, a `.map` on a field the door
// stopped sending, a context read outside its provider, a destructure of
// `undefined`. Any one of those is a WHITE PAGE for the owner — the dashboard is
// the only way into this platform, so a page that throws while rendering is a
// total outage of that page.
//
// This file mounts each major page against a permissive mocked API and asserts it
// reaches the DOM. It deliberately asserts almost nothing about what it drew:
// a smoke floor that also checks content becomes a test that fails on every
// redesign, and nobody thanks it. What it catches is the crash.
//
// ── THE MOCKING RULE ──
// Every exported FUNCTION of `lib/api` answers `{ ok: true, data: [] }`; every
// exported constant stays real. That is the shape the whole client is written
// against, so a page that handles "nothing here yet" correctly mounts, and a page
// that assumes a field into existence does not — which is the defect worth
// catching.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
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
  // The two the app calls synchronously: a logged-out tab is the honest default.
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

import { AuthProvider } from '../hooks/useAuth';
import { Login } from '../pages/Login';
import { Chat } from '../pages/Chat';
import { Agents } from '../pages/Agents';
import { Tracker } from '../pages/Tracker';
import { Memory } from '../pages/Memory';
import { Health } from '../pages/Health';
import { Costs } from '../pages/Costs';
import { Techniques } from '../pages/Techniques';
import { Settings } from '../pages/Settings';
import { InterAgentLane } from '../pages/InterAgentLane';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';

/** The shell App.tsx puts every page inside. Same nesting, same order. */
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

const PAGES: ReadonlyArray<readonly [string, () => ReactElement]> = [
  ['Login', () => <Login />],
  ['Chat', () => <Chat />],
  ['Agents', () => <Agents />],
  ['Tracker', () => <Tracker />],
  ['Memory', () => <Memory />],
  ['Health', () => <Health />],
  ['Costs', () => <Costs />],
  ['Techniques', () => <Techniques />],
  ['Settings', () => <Settings />],
  ['InterAgentLane', () => <InterAgentLane />],
];

beforeEach(() => {
  resetFrames();

  // ── BOTH CONCESSIONS THAT USED TO LIVE HERE ARE GONE, AND THAT IS THE POINT ──
  //
  // 1. THE TRIPWIRE NOW STANDS FOR THIS FILE TOO. This block used to replace the
  //    setup file's throwing `fetch` with a 503-answering stub, because 16 files
  //    called the global `fetch` directly and mounting their pages tripped it.
  //    Every one of those calls goes through `lib/api` now (BACKLOG line 31), and
  //    `lib/api` is MOCKED above — so no page reaches the network at all and the
  //    tripwire can do its job. That makes this floor strictly stronger than the
  //    stub did: a page that mounts here is a page with no un-mockable network
  //    call left in it, and the next direct `fetch` anyone adds reds this file
  //    with the tripwire's own message rather than being quietly served a 503.
  //
  // 2. NO HAND-SHAPED ANSWER FOR ONE DOOR. `getOllamaLockStatus` used to be
  //    overridden with `{ warnings: [] }` because `pages/Agents.tsx` read
  //    `result.data.warnings.length` with nothing but `result.ok` in front of it,
  //    so the permissive `data: []` default crashed the page. The read is guarded
  //    now and this door gets the same answer as every other. Put the unguarded
  //    read back and Agents reds here — that is the mutant.
});
afterEach(() => { vi.clearAllMocks(); });

describe('every major page mounts without throwing', () => {
  for (const [name, page] of PAGES) {
    it(`${name} renders`, () => {
      const { container } = render(shell(page()));
      // Something reached the DOM. An empty container means the page returned
      // null from its very first render, which is not a mount.
      expect(container.firstChild, `${name} rendered nothing at all`).not.toBeNull();
    });
  }
});
