// ── Settings → The Profile tab: "Your Mailboxes".
//
// The list is READ-ONLY (owner ruling 2026-10-27): it fills itself from the
// `mailboxes` the identity read now carries, and an owner with nothing connected
// — or an older server that never sends the key at all — sees the none-yet line.
// No box to type in, no Save button: case 4 below holds that absence.
//
// The door mock is the smoke floor's permissive factory, copied from
// `a-failed-load-says-so.test.tsx`. This tab uses no websocket, no toast and no
// router, so it needs none of that file's providers — `render(<ProfileTab />)`
// is the whole shell.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

// The permissive factory the smoke floor uses — every exported FUNCTION answers
// `{ ok: true, data: [] }`, every exported constant stays real.
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

import * as api from '../lib/api';
import { ProfileTab } from '../components/settings/ProfileTab';

const mocked = () => vi.mocked(api);

const TWO_MAILBOXES = [
  { address: 'me@gmail.com', provider: 'google', accountId: 'g1' },
  { address: 'me@work.com', provider: 'microsoft', accountId: 'm1' },
];

/** What `getIdentity('USER.md')` answers for this case. */
const identityAnswers = (data: unknown) =>
  mocked().getIdentity.mockResolvedValue({ ok: true, data } as never);

beforeEach(() => {
  mocked().getSetting.mockResolvedValue({ ok: true, data: { value: 'Alex' } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('The Profile tab lists your mailboxes', () => {
  it('⚠ shows each connected address with its provider', async () => {
    identityAnswers({ content: '# User Profile', mailboxes: TWO_MAILBOXES });
    render(<ProfileTab />);

    await screen.findByText('Your Mailboxes');
    expect(screen.getByText('me@gmail.com')).toBeTruthy();
    expect(screen.getByText('me@work.com')).toBeTruthy();
    expect(screen.getByText('Google')).toBeTruthy();
    expect(screen.getByText('Microsoft')).toBeTruthy();
  });

  it('⚠ nothing connected yet says so plainly', async () => {
    identityAnswers({ content: '# User Profile', mailboxes: [] });
    render(<ProfileTab />);

    expect(await screen.findByText(/None yet\. Connect your own Google or Microsoft account/))
      .toBeTruthy();
  });

  it('⚠ an older server that sends no mailboxes key still shows the none-yet line', async () => {
    identityAnswers({ content: '# User Profile' });
    render(<ProfileTab />);

    expect(await screen.findByText(/None yet\. Connect your own Google or Microsoft account/))
      .toBeTruthy();
  });

  it('⚠ the tile is read-only: no textbox inside it', async () => {
    identityAnswers({ content: '# User Profile', mailboxes: TWO_MAILBOXES });
    render(<ProfileTab />);

    await screen.findByText('Your Mailboxes');
    const tile = screen.getByText('Your Mailboxes').closest('.tile') as HTMLElement;
    expect(within(tile).queryAllByRole('textbox')).toHaveLength(0);
  });
});
