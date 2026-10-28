// `drive_read` on a Google Doc or Sheet delegates to the docs/sheets read. That
// delegation must keep the account the Drive read used: a `user_` read must still
// fetch the doc/sheet body as the owner, and an explicit `account:` must travel
// with it — otherwise the body is fetched with the agent's account and comes back
// "File not found". Driven through the real tool door; only the HTTP client and
// the account resolver are doubles.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Which surface the Drive file turns out to be, so the delegate lands on the right API.
let driveMime = 'application/vnd.google-apps.document';

const googleRead = vi.fn(async (...a: unknown[]) => {
  const u = String(a[0]);
  if (u.includes('/drive/v3/files/')) return { ok: true as const, data: { id: 'f1', name: 'Doc', mimeType: driveMime } };
  if (u.includes('docs.googleapis.com')) return { ok: true as const, data: { title: 'Doc', body: { content: [{ paragraph: { elements: [{ textRun: { content: 'hello doc' } }] } }] } } };
  if (u.includes('sheets.googleapis.com')) return { ok: true as const, data: { range: 'Sheet1', values: [['a', 'b']] } };

  throw new Error(`unexpected url: ${u}`);
});
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));

const resolve = vi.fn((kind: string, email?: string) => ({ account: { id: `acct-${kind}`, email: email ?? `${kind}@example.invalid` }, labelAccount: false }));
vi.mock('../accounts.js', () => ({ resolveGoogleAccountForRead: (...a: [string, string?]) => resolve(...a) }));

const { executeGoogleReadTool } = await import('../tools-read.js');

beforeEach(() => {
  resolve.mockClear();
  driveMime = 'application/vnd.google-apps.document';
});

describe('drive_read keeps the account it read with on a doc or sheet', () => {
  it('a user doc keeps the user account on the delegated docs read', async () => {
    const out = await executeGoogleReadTool('user_drive_read', { file_id: 'f1' }, 'agent-1', 'Agent');
    expect(out).toContain('hello doc');
    expect(resolve.mock.calls.every((c) => c[0] === 'user')).toBe(true);
  });

  it('an explicit account travels to the delegated docs read', async () => {
    const out = await executeGoogleReadTool('drive_read', { file_id: 'f1', account: 'second@example.invalid' }, 'agent-1', 'Agent');
    expect(out).toContain('hello doc');
    expect(resolve.mock.calls.every((c) => c[1] === 'second@example.invalid')).toBe(true);
  });

  it('a user sheet keeps the user account on the delegated sheets read', async () => {
    driveMime = 'application/vnd.google-apps.spreadsheet';
    const out = await executeGoogleReadTool('user_drive_read', { file_id: 'f1' }, 'agent-1', 'Agent');
    expect(out).toContain('Row 1: a | b');
    expect(resolve.mock.calls.every((c) => c[0] === 'user')).toBe(true);
  });

  it('a plain drive_read reads the agent account with no explicit account', async () => {
    const out = await executeGoogleReadTool('drive_read', { file_id: 'f1' }, 'agent-1', 'Agent');
    expect(out).toContain('hello doc');
    expect(resolve.mock.calls.every((c) => c[0] === 'agent')).toBe(true);
    expect(resolve.mock.calls.every((c) => c[1] === undefined)).toBe(true);
  });
});
