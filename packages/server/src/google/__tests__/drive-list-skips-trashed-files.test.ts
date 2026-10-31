// `drive_list` hands back files sitting in the Trash. Drive's `files.list` includes
// trashed items unless the query says otherwise, and the handler only said so when
// the query was empty — so a search for "budget", or a plain folder listing, offered
// deleted files as if they were live. A query that already speaks about `trashed` is
// the model's own and passes through; everything else now excludes the Trash.
// Driven through the real tool door; only the HTTP client and the account resolver
// are doubles (setup copied from drive-read-keeps-the-account.test.ts).
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { files: [] } }));
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));

const resolve = vi.fn((kind: string, email?: string) => ({ account: { id: `acct-${kind}`, email: email ?? `${kind}@example.invalid` }, labelAccount: false }));
vi.mock('../accounts.js', () => ({ resolveGoogleAccountForRead: (...a: [string, string?]) => resolve(...a) }));

const { executeGoogleReadTool } = await import('../tools-read.js');

/** The `q` the handler put on the wire for these args. */
async function sentQ(args: Record<string, unknown>): Promise<string> {
  googleRead.mockClear();
  await executeGoogleReadTool('drive_list', args, 'agent-1', 'Agent');
  const url = String(googleRead.mock.calls[0][0]);
  return new URL(url).searchParams.get('q') ?? '';
}

beforeEach(() => {
  resolve.mockClear();
  googleRead.mockClear();
});

describe('drive_list keeps trashed files out of the results', () => {
  it('a bare search excludes the Trash', async () => {
    expect(await sentQ({ query: 'budget' })).toBe("fullText contains 'budget' and trashed = false");
  });

  it('a folder listing excludes the Trash', async () => {
    expect(await sentQ({ folder_id: 'F1' })).toBe("'F1' in parents and trashed = false");
  });

  it('an either-or query is wrapped so the Trash exclusion covers both sides', async () => {
    expect(await sentQ({ query: "name = 'a' or name = 'b'" })).toBe("(name = 'a' or name = 'b') and trashed = false");
  });

  it('a query that deliberately asks for the Trash still gets the Trash', async () => {
    expect(await sentQ({ query: 'trashed = true' })).toBe('trashed = true');
  });
});
