// 9901: drive_list keeps the folder around an either-or search, and a quoted "trashed" word is not a trash condition.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const googleRead = vi.fn(async (..._a: unknown[]) => ({ ok: true as const, data: { files: [] } }));
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: () => ({ account: { id: 'acct-1', email: 'agent@example.invalid' }, labelAccount: false }),
}));

const { executeGoogleReadTool } = await import('../tools-read.js');

async function sentQ(args: Record<string, unknown>): Promise<string> {
  googleRead.mockClear();
  await executeGoogleReadTool('drive_list', args, 'agent-1', 'Agent');
  return new URL(String(googleRead.mock.calls[0][0])).searchParams.get('q') ?? '';
}

describe('9901 — the folder and the Trash clauses bind to the whole search', () => {
  beforeEach(() => googleRead.mockClear());

  it('an either-or search stays inside the chosen folder', async () => {
    expect(await sentQ({ query: "name contains 'a' or name contains 'b'", folder_id: 'F1' }))
      .toBe("(name contains 'a' or name contains 'b') and 'F1' in parents and trashed = false");
  });

  it('the plain word "trashed" in the search words does not stop the Trash exclusion', async () => {
    expect(await sentQ({ query: 'trashed budget' })).toBe("fullText contains 'trashed budget' and trashed = false");
  });

  it('the model\'s own trash condition is sent unchanged', async () => {
    expect(await sentQ({ query: 'trashed = true' })).toBe('trashed = true');
  });

  it('a quoted "or" needs no brackets', async () => {
    expect(await sentQ({ query: "name contains 'tea or coffee'" })).toBe("name contains 'tea or coffee' and trashed = false");
  });

  it('a folder alone', async () => {
    expect(await sentQ({ folder_id: 'F1' })).toBe("'F1' in parents and trashed = false");
  });
});
