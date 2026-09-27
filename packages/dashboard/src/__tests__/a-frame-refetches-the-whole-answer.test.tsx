// ════════════════════════════════════════════════════════════════════════════
// THE REFETCH-ON-EVENT IDIOM (DOJO-REPORT T5 §2b, MIGRATED OUT OF PROSE).
//
// T5 could not hold four rules and said which one it wanted most:
//
//   | that `loadStatus()` is called on every frame (the refetch-on-event idiom,
//   | never a partial merge) | ditto | a partial merge would be the
//   | invented-freshness defect — **this is the one worth a DOM runner if the
//   | house ever gets one** |
//
// The doctrine behind it is `memory/integration-status-lane.ts`'s ".24" rule,
// quoted in the card's own header: *ledger-backed, NEVER AN INVENTED FRESHNESS*.
// A WebSocket frame here is a PING — "something changed" — and the answer to what
// is now true comes from the door that owns it. The defect this refuses is a
// future edit that "optimises" the refetch away by merging the frame's own fields
// into state: the card would then show a connection assembled out of a
// notification, which is exactly the thing the platform tells its agents never to
// trust.
//
// Held here, behaviourally: a frame arrives → the DOOR is asked again → the WHOLE
// new answer is on screen. The three other T5 §2b rows ride along, because a DOM
// runner holds them for free: the four subscriptions and their cleanup, the
// mount-once guard, and the `problem` sentence that T5 called "the honest gap".
//
// The sentences are NEVER written down here: `problemText`, `connectedAs` and
// `describeScope` live in `lib/github-card.ts` and are driven by the server's
// suite. This file computes its expectations from those same functions, so a
// reworded sentence is one edit and never a red test in two packages.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  connectedAs, describeScope, problemText, CONNECT_FAILED_FALLBACK, CONNECT_REFUSED_FALLBACK,
} from '../lib/github-card';
import { resetFrames, emitFrame, handlerCount } from './helpers/frames';

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

const ACCOUNT = 'an-example-account';

const status = (over: Partial<api.GithubStatus> = {}): api.GithubStatus => ({
  connected: false, login: null, scope: null, connectedAt: null, lastOkAt: null,
  lastError: null, reauthRequired: false, clientIdConfigured: true,
  loginInProgress: false, userCode: null, verificationUri: null, ...over,
});

const mocked = () => vi.mocked(api);

/** The four frames this card subscribes to, in the order the component lists them. */
const FRAMES = ['github:device_code', 'github:connected', 'github:connect_failed', 'github:disconnected'];

beforeEach(() => {
  resetFrames();
  mocked().getGithubStatus.mockResolvedValue({ ok: true, data: status() });
});

afterEach(() => { vi.resetAllMocks(); });

describe('a frame is a ping; the door is the answer', () => {
  it('asks the door once on mount and not twice (the mount-once guard)', async () => {
    render(<GitHubSettings />);
    await screen.findByText('GitHub');
    await waitFor(() => expect(mocked().getGithubStatus).toHaveBeenCalledTimes(1));
    // A second render pass must not re-fire it.
    await new Promise((r) => setTimeout(r, 10));
    expect(mocked().getGithubStatus).toHaveBeenCalledTimes(1);
  });

  it('refetches on EVERY one of the four frames', async () => {
    render(<GitHubSettings />);
    await waitFor(() => expect(mocked().getGithubStatus).toHaveBeenCalledTimes(1));

    let expected = 1;
    for (const frame of FRAMES) {
      emitFrame(frame, {});
      expected += 1;
      await waitFor(
        () => expect(mocked().getGithubStatus, `${frame} did not refetch`).toHaveBeenCalledTimes(expected),
      );
    }
  });

  it('shows the WHOLE new answer after a frame — never the frame merged into the old one', async () => {
    render(<GitHubSettings />);
    await screen.findByText('GitHub');

    // The door's answer changes underneath: a real sign-in completed.
    const connected = status({ connected: true, login: ACCOUNT, scope: 'public_repo' });
    mocked().getGithubStatus.mockResolvedValue({ ok: true, data: connected });

    // The frame carries a login of its own. A partial merge would take THIS and keep
    // everything else stale; the rule is that the frame is only a ping.
    emitFrame('github:connected', { login: 'a-different-handle' });

    expect(await screen.findByText(connectedAs(ACCOUNT))).toBeDefined();
    expect(screen.getByText(describeScope('public_repo'))).toBeDefined();
    // The disconnected card's button is gone, which is what proves the whole card
    // re-derived from the new answer rather than patching one field.
    expect(screen.queryByRole('button', { name: /^Connect/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDefined();
    // And the frame's own login never reached the screen.
    expect(document.body.textContent).not.toContain('a-different-handle');
  });

  it('renders the reason a sign-in failed — and the fallback when the frame carries none', async () => {
    render(<GitHubSettings />);
    await screen.findByText('GitHub');

    const reason = 'GitHub said the code expired.';
    emitFrame('github:connect_failed', { error: reason });
    expect(await screen.findByText(problemText(reason, CONNECT_FAILED_FALLBACK))).toBeDefined();

    // T5 §2b called this "the honest gap": a frame with no `error` field falls back to a
    // fixed sentence, and until now only reading the code proved it.
    emitFrame('github:connect_failed', {});
    expect(await screen.findByText(CONNECT_FAILED_FALLBACK)).toBeDefined();
  });

  it('renders the reason a refused POST /connect gave, and clears it on the next attempt', async () => {
    const refusal = 'This box has no GitHub client id configured.';
    mocked().connectGithub.mockResolvedValue({ ok: false, error: refusal });
    render(<GitHubSettings />);
    await screen.findByText('GitHub');

    fireEvent.click(screen.getByRole('button', { name: /^Connect/ }));
    expect(await screen.findByText(problemText(refusal, CONNECT_REFUSED_FALLBACK))).toBeDefined();

    // A new attempt clears it: a stale reason beside a live spinner is its own defect.
    mocked().connectGithub.mockResolvedValue({ ok: true, data: { userCode: 'AAAA-BBBB', verificationUri: 'https://example.invalid/device' } as never });
    fireEvent.click(screen.getByRole('button', { name: /^Connect/ }));
    await waitFor(() => expect(screen.queryByText(problemText(refusal, CONNECT_REFUSED_FALLBACK))).toBeNull());
  });

  it('unsubscribes all four on unmount — no frame reaches a dead card', async () => {
    const { unmount } = render(<GitHubSettings />);
    await screen.findByText('GitHub');
    for (const frame of FRAMES) expect(handlerCount(frame), `${frame} was never subscribed`).toBe(1);

    unmount();
    for (const frame of FRAMES) expect(handlerCount(frame), `${frame} leaked after unmount`).toBe(0);
  });
});
