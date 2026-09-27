// ════════════════════════════════════════════════════════════════════════════
// THE CARD THE OWNER SCREENSHOTTED, AND WHAT IT DRAWS NOW (v3.2.2).
//
// ── THE DEFECT, IN ONE SENTENCE ──
// The GitHub OAuth client id was set BY HAND on the development box at T4
// Step 8 and never shipped, so on a user's box `clientIdConfigured` was false
// and Settings → Integrations → GitHub drew "GitHub isn't set up on this box
// yet" with NO CONNECT PATH. The feature existed and was unreachable.
//
// The id is now a shipped product constant (DOJO-REPORT spec D3 — device-flow
// public client, no secret, nothing extractable), so a fresh box resolves it and
// `clientIdConfigured` is true. What that means for the PIXELS is this file's
// subject: the server half is pinned next door, and until the dashboard had a
// runner (BACKLOG line 54) nothing could assert that a button appears.
//
// ── WHY BOTH STATES ARE DRIVEN ──
// The `unconfigured` branch stays in the component because it stays reachable —
// a fork may blank the constant — and a state nobody draws is a state that rots.
// So both are rendered here: one must offer the button, the other must not, and
// the difference between them is the whole point of the card's third state.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { githubCardState, connectLabel, type GithubCardStatus } from '../lib/github-card';

// The same three stubs its sibling `a-frame-refetches-the-whole-answer.test.tsx` uses on this
// component: the door, the socket, the toast. This file is about what the card draws for a GIVEN
// status, so the status is the input and nothing else is real.
vi.mock('../lib/api');
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
import { GitHubSettings } from '../components/GitHubSettings';

/** A fresh user box: no connection yet, and — since v3.2.2 — a client id all the same. */
const FRESH: GithubCardStatus = {
  connected: false, login: null, scope: null, connectedAt: null, lastOkAt: null,
  lastError: null, reauthRequired: false, clientIdConfigured: true,
  loginInProgress: false, userCode: null, verificationUri: null,
};

/** The same box on a build whose constant was blanked and which has no override row. */
const BLANKED_BUILD: GithubCardStatus = { ...FRESH, clientIdConfigured: false };

/** The door answers an ENVELOPE (`{ok, data}`), and the card only reads `data` when `ok`. */
const serve = (s: GithubCardStatus): void => {
  vi.mocked(api.getGithubStatus).mockResolvedValue(
    { ok: true, data: s as unknown as api.GithubStatus },
  );
};

beforeEach(() => { vi.clearAllMocks(); });

describe('the decidable rule agrees with what the card draws', () => {
  it('a fresh box is DISCONNECTED — a state that has a button — not UNCONFIGURED', () => {
    expect(githubCardState(FRESH)).toBe('disconnected');
    expect(connectLabel(FRESH)).toBe('Connect GitHub');
  });

  it('only a blanked build is UNCONFIGURED', () => {
    expect(githubCardState(BLANKED_BUILD)).toBe('unconfigured');
  });
});

describe('a fresh user box draws the Connect flow', () => {
  it('renders the button, and NOT the "isn\'t set up" sentence', async () => {
    serve(FRESH);
    render(<GitHubSettings />);

    const button = await screen.findByRole('button', { name: /connect github/i });
    expect(button, 'a fresh box must offer Connect — its absence was the defect').toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(false);

    expect(
      screen.queryByText(/isn't set up on this box yet/i),
      'the dead-end sentence must not be what a user box says',
    ).toBeNull();
  });

  it('a blanked build still says so plainly, and offers no button', async () => {
    serve(BLANKED_BUILD);
    render(<GitHubSettings />);

    expect(await screen.findByText(/isn't set up on this box yet/i)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /connect github/i }),
      'a button that cannot work must not be drawn',
    ).toBeNull();
  });
});
