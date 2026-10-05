// ════════════════════════════════════════════════════════════════════════════
// THE FULL-DISK-ACCESS HINT ON THE SETTINGS PAGE SHOWS THE REAL EXECUTABLE.
//
// ── THE BUG THIS HOLDS, WHICH SHIPPED AND LIVED ──
// The fresh-box audit's item D fixed a hint that told the user to grant Full Disk
// Access to Terminal, or to "an entry just called node". The correct answer is the
// exact Node binary launchd started, which only the running server knows
// (`process.execPath`), so it is served as `serverExecPath` and both surfaces
// render it through one shared function.
//
// On THIS surface it never arrived. `pages/Settings.tsx` asked the door for
// `/api/setup/permissions/check`, and the door prepends `/api` — so the real
// request was `/api/api/setup/permissions/check`, a 404 on every single load. The
// failure was silent by construction: the door answers `{ ok: false }` as a VALUE
// and the call site reads `if (r.ok && r.data?.serverExecPath)`, so nothing threw,
// nothing logged, and `serverExecPath` simply stayed undefined. What the owner saw
// forever was the fallback wording — "the server reports its exact path on this
// screen once it is running" — on a screen where the server was running and
// reporting it. Item D's fix was inert here for five characters.
//
// ── WHY A RENDER CLAUSE AND NOT ONLY THE PREFIX CENSUS ──
// `the-dashboard-has-one-network-door.test.ts` now refuses any caller that passes
// a path beginning with `/api/`, which stops this exact typo returning. But that
// is a clause about a STRING. This one is about the CONSEQUENCE: the path the
// server sends has to reach the sentence the owner reads. A future break in the
// wiring between the two — a renamed field, a card that stops rendering the
// shared helper, a loader that drops the answer — would pass the census and fail
// here, which is the half worth having.
//
// It asserts BOTH directions, because the symptom was not a missing hint but a
// WRONG one: the real path present, and the "path unknown" fallback absent.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';
import { fullDiskAccessInstructions } from '@dojo/shared';
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
  return {
    useToast: () => stub.value,
    ToastProvider: ({ children }: { children: ReactElement }) => children,
    ToastContainer: () => null,
  };
});

import * as api from '../lib/api';
import { AuthProvider } from '../hooks/useAuth';
import { Settings } from '../pages/Settings';
import { ActiveAgentProvider } from '../components/ActiveAgentProvider';
import { RightDockProvider } from '../components/RightDockProvider';
import { TechniqueSessionProvider } from '../components/TechniqueSessionProvider';
import { OrbProvider } from '../components/orb/OrbProvider';
import { ThemeProvider } from '../themes/ThemeProvider';

/** A fictional but realistically awkward path — the kind item D exists for. */
const EXEC_PATH = '/Users/someone/.nvm/versions/node/v22.22.3/bin/node';

/** The wording the helper falls back to when it does NOT know the path. */
const UNKNOWN_WORDING = 'reports its exact path';

const mocked = () => vi.mocked(api);

/**
 * The iMessage card lives on the `channels` tab, and the page reads the tab from
 * the URL (`?tab=channels`) — so the route is how this test reaches the card,
 * rather than clicking through the tab strip.
 */
const shell = (page: ReactElement) => (
  <MemoryRouter initialEntries={['/settings?tab=channels']}>
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

beforeEach(() => {
  resetFrames();
  // The server answers the permissions door with the path, exactly as
  // `GET /api/setup/permissions/check` does. Any OTHER path fails, which is what
  // makes the mutant below faithful: a mis-prefixed call gets nothing, just as it
  // got nothing in production.
  mocked().request.mockImplementation((async (path: string) => (
    path === '/setup/permissions/check'
      ? { ok: true, data: { serverExecPath: EXEC_PATH } }
      : { ok: false, error: 'not found' }
  )) as never);
  // The hint only renders when the bridge is ON, so say it is.
  mocked().getSetting.mockImplementation((async (key: string) => (
    key === 'imessage_enabled'
      ? { ok: true, data: { value: 'true' } }
      : { ok: true, data: { value: '' } }
  )) as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the Full Disk Access hint names the executable the server reported', () => {
  it('⚠ renders the real path, and NOT the "path unknown" fallback', async () => {
    const { container } = render(shell(<Settings />));

    await waitFor(() => {
      expect(
        container.textContent,
        'the hint does not carry the path the server sent — the door answer never reached it',
      ).toContain(EXEC_PATH);
    });

    // ── THE HALF THAT CATCHES THE ACTUAL DEFECT ──
    // The bug did not hide the hint; it made the hint WRONG, telling the owner the
    // server would report a path on a screen that was already being told it.
    expect(
      container.textContent,
      'the hint still shows its "path unknown" wording even though the server answered',
    ).not.toContain(UNKNOWN_WORDING);
  });

  it('the sentence is the shared helper\'s, not a second copy typed here', async () => {
    // Item D's whole point was ONE source for these words. If this card ever grows
    // its own sentence, the text would still contain the path and this clause is
    // what notices.
    const { container } = render(shell(<Settings />));
    const expected = fullDiskAccessInstructions(EXEC_PATH);
    await waitFor(() => expect(container.textContent).toContain(EXEC_PATH));
    // Compare on a distinctive span of the helper's output rather than the whole
    // sentence, which the card renders alongside the verify line.
    const distinctive = expected.slice(0, 60);
    expect(container.textContent, 'the card is not rendering the shared copy')
      .toContain(distinctive);
  });
});
