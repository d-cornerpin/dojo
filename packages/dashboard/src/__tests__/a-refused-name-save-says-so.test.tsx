// ── Settings → The Profile tab: a refused name save shows the server's reason,
//    and the About You text names the toggle the owner actually sees.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';

// The permissive factory the smoke floor uses, every exported FUNCTION answers
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
  { address: 'me@gmail.test', provider: 'google', accountId: 'g1' },
  { address: 'me@work.test', provider: 'microsoft', accountId: 'm1' },
];

/** What `getIdentity('USER.md')` answers for this case. */
const identityAnswers = (data: unknown) =>
  mocked().getIdentity.mockResolvedValue({ ok: true, data } as never);

beforeEach(() => {
  mocked().getSetting.mockResolvedValue({ ok: true, data: { value: 'Alex' } } as never);
});
afterEach(() => { vi.clearAllMocks(); });

describe('the Profile tab name save', () => {
  it('a refused save shows the reason', async () => {
    mocked().getIdentity.mockResolvedValue({ ok: true, data: { content: '# User Profile', mailboxes: [] } } as never);
    mocked().setSetting.mockResolvedValue({ ok: false, error: 'The name could not be stored.' } as never);
    render(<ProfileTab />);
    const box = await screen.findByPlaceholderText('e.g., Alex');
    fireEvent.change(box, { target: { value: 'Sam' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);
    await waitFor(() => expect(screen.getByText('The name could not be stored.')).toBeTruthy());
    expect(screen.queryByText('Saved!')).toBeNull();
  });
  it('the About You text names the real toggle', async () => {
    mocked().getIdentity.mockResolvedValue({ ok: true, data: { content: '# User Profile', mailboxes: [] } } as never);
    render(<ProfileTab />);
    expect(await screen.findByText(/"Knows who you are"/)).toBeTruthy();
    expect(screen.queryByText(/Share User Profile/)).toBeNull();
  });
});
