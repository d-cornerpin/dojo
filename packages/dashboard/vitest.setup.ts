// ════════════════════════════════════════════════════════════════════════════
// WHAT EVERY DASHBOARD TEST GETS, AND WHAT IT IS NOT ALLOWED TO REACH.
//
// Runs inside each worker before the code under test is imported.
//
// ── 1. THE NETWORK TRIPWIRE (the sibling of `src/home.ts`'s real-home tripwire) ──
// `packages/server`'s suite once wrote 123,000 log lines into the owner's real
// `~/.dojo` because nothing stopped it reaching outside itself. The dashboard's
// version of that mistake is a component test that reaches a LIVE server: it
// passes on the dev box with `:3001` up, fails in a release, and proves nothing
// either way. So `fetch` throws here. A test that wants a door mocks the door
// (`vi.mock('../lib/api')`) — which is also the only way an assertion about what
// the card SENT can be made at all.
//
// ── 2. WHAT happy-dom DID NOT BRING — THE STUB LIST, WHICH IS THE ARGUMENT ──
// `vitest.config.ts` chose happy-dom over jsdom on a measured API census. That
// choice is only honest if the residue is written down, so this is the residue,
// in full:
//
//   · `HTMLCanvasElement.getContext` — returns null here. The one call site is
//     `components/orb/dojoOrbEngine.ts` asking for **WebGL**, which no headless
//     DOM implements (jsdom's optional `canvas` package is 2D-only). null is what
//     a browser returns when the context is unavailable and the orb already has
//     to survive it, so this stub asserts a real production path rather than
//     inventing a fake GPU.
//
// Everything else the dashboard touches — `matchMedia`, `ResizeObserver`,
// `IntersectionObserver`, `scrollIntoView`, `navigator.clipboard`,
// `localStorage`, `requestAnimationFrame`, `WebSocket` — comes from happy-dom
// itself and is asserted present by
// `src/__tests__/the-dom-environment-provides-what-the-dashboard-uses.test.ts`,
// so an upgrade that silently drops one fails a clause instead of making a
// component test fail for a reason nobody can read.
//
// ── 3. NO TOKEN, ON PURPOSE ──
// `localStorage` starts empty, so `hooks/useWebSocket.ts`'s provider finds no
// token and never opens a socket. That is the shipped behaviour of a logged-out
// tab, not a mock.
// ════════════════════════════════════════════════════════════════════════════

import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// ── 1 ──
const NETWORK_REFUSED =
  'NETWORK TRIPWIRE: a dashboard test called fetch().\n' +
  '  Component tests must drive a MOCKED door, never a live server: a test that\n' +
  '  passes because :3001 happened to be up is not a test. Mock the module that\n' +
  '  owns the call — `vi.mock("../lib/api")` — which is also what lets the test\n' +
  '  assert what the component SENT.';

globalThis.fetch = (() => { throw new Error(NETWORK_REFUSED); }) as unknown as typeof fetch;

// ── 2 ──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).HTMLCanvasElement.prototype.getContext = () => null;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  // React Testing Library's auto-cleanup only registers itself when the test
  // framework exposes `afterEach` GLOBALLY. This suite runs without globals (the
  // server suite's convention: every symbol is imported), so cleanup is explicit
  // — without it each test's tree stays mounted and the next `getByText` reads
  // the previous test's DOM.
  cleanup();
  vi.restoreAllMocks();
  // A clause that must opt out of the tripwire does it with `vi.stubGlobal('fetch', …)`
  // — see `a-hidden-credential-draws-a-chip.test.tsx`, which mounts a component that
  // calls `fetch` DIRECTLY instead of through `lib/api` and therefore has no door to
  // mock. Un-stubbing here is what stops that opt-out leaking into the next test.
  vi.unstubAllGlobals();
});
