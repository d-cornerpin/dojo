// 3.5 release testing, observation O1: gmail_label's description says add_labels takes "a custom label name from
// gmail_list_labels" and gmail_list_labels says to "pass the label NAME (not ID)". Gmail's modify calls accept label
// IDs only, so a custom name was refused ("Invalid label: ..."). The tool must turn a name into the account's label id
// before it asks Gmail, and still accept ids and system labels as given.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({ googleRead: vi.fn(), googleWrite: vi.fn() }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: { id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com', enabled: true, connected: true, accessToken: null, refreshToken: null, tokenExpiresAt: null, grantedScopes: null, enabledServices: null, watchEmail: false, sendEmail: true, lastVerifiedAt: null },
  })),
}));

import { googleRead, googleWrite } from '../client.js';
import { executeGoogleWriteTool } from '../tools-write.js';

const ok = (data: unknown = {}) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const labels = { labels: [
  { id: 'INBOX', name: 'INBOX', type: 'system' },
  { id: 'Label_42', name: 'W4-all', type: 'user' },
  { id: 'Label_9', name: 'URGENT', type: 'user' },
  { id: 'Label_7', name: 'Receipts/2026', type: 'user' },
] };
const sentBody = (): Record<string, unknown> => vi.mocked(googleWrite).mock.calls[0]?.[2] as Record<string, unknown>;
const run = (args: Record<string, unknown>) => executeGoogleWriteTool('gmail_label', { message_ids: ['m1'], ...args }, 'agent-1', 'A Worker');

beforeEach(() => {
  vi.mocked(googleRead).mockReset(); vi.mocked(googleWrite).mockReset();
  vi.mocked(googleWrite).mockResolvedValue(ok() as never);
  vi.mocked(googleRead).mockResolvedValue(ok(labels) as never);
});

describe('an all-capitals custom name is a name, not an id', () => {
  it('URGENT resolves to its id; a real system label in the same call still passes through', async () => {
    await run({ add_labels: ['URGENT', 'STARRED'], remove_labels: ['INBOX'] });
    expect(sentBody()).toMatchObject({ addLabelIds: ['Label_9', 'STARRED'], removeLabelIds: ['INBOX'] });
  });
});

describe('gmail_label resolves custom label names to ids', () => {
  it('a custom name (any case) is sent as its id; nested names work', async () => {
    await run({ add_labels: ['w4-ALL'], remove_labels: ['Receipts/2026'] });
    expect(sentBody()).toMatchObject({ addLabelIds: ['Label_42'], removeLabelIds: ['Label_7'] });
  });
  it('system labels and ids pass through unchanged', async () => {
    await run({ add_labels: ['Label_42', 'STARRED'], remove_labels: ['INBOX'] });
    expect(sentBody()).toMatchObject({ addLabelIds: ['Label_42', 'STARRED'], removeLabelIds: ['INBOX'] });
  });
  it('a name that matches nothing is sent as given, so Gmail\'s own refusal and the remedy still apply', async () => {
    await run({ add_labels: ['No Such Label'] });
    expect(sentBody()).toMatchObject({ addLabelIds: ['No Such Label'] });
  });
  it('an unreadable label list leaves the labels as given', async () => {
    vi.mocked(googleRead).mockResolvedValue({ ok: false, data: null, error: 'down', apiEndpoint: 'x' } as never);
    await run({ add_labels: ['W4-all'] });
    expect(sentBody()).toMatchObject({ addLabelIds: ['W4-all'] });
  });
  it('no lookup is made when every label is a system label', async () => {
    await run({ add_labels: ['STARRED', 'UNREAD'], remove_labels: ['INBOX'] });
    expect(googleRead).not.toHaveBeenCalled();
  });
});
