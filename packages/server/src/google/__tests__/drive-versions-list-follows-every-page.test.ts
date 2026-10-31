// Drive's `revisions.list` returns revisions OLDEST first and hands out at most
// one page per call, with `nextPageToken` when more follow. Reading one page and
// reversing it showed only the OLDEST versions under the label "(newest first)".
// The tool must follow the token until it is absent, so the whole history is
// listed newest first, and a failing later page must surface as an error rather
// than a short list. Only the HTTP client and the account resolver are doubles;
// the pages are keyed on the pageToken carried in the requested url.
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Rev = { id: string; modifiedTime: string };

// Keyed by the pageToken in the request ('' = first page), oldest revisions first
// exactly as Drive serves them.
const PAGES: Record<string, { revisions: Rev[]; nextPageToken?: string }> = {
  '': {
    revisions: [
      { id: 'r1', modifiedTime: '2026-01-01T10:00:00Z' },
      { id: 'r2', modifiedTime: '2026-01-02T10:00:00Z' },
    ],
    nextPageToken: 'T1',
  },
  T1: {
    revisions: [
      { id: 'r3', modifiedTime: '2026-01-03T10:00:00Z' },
      { id: 'r4', modifiedTime: '2026-01-04T10:00:00Z' },
    ],
    nextPageToken: 'T2',
  },
  T2: {
    revisions: [{ id: 'r5', modifiedTime: '2026-01-05T10:00:00Z' }],
  },
};

// When set, the page whose request carries this token fails instead of answering.
let failPage: string | null = null;

const googleRead = vi.fn(async (...a: unknown[]) => {
  const u = String(a[0]);
  const token = /pageToken=([^&]*)/.exec(u)?.[1] ?? '';
  if (failPage !== null && token === failPage) return { ok: false as const, error: 'HTTP 500' };
  const page = PAGES[token];
  if (!page) throw new Error(`unexpected pageToken in url: ${u}`);
  return { ok: true as const, data: page };
});
vi.mock('../client.js', () => ({ googleRead: (...a: unknown[]) => googleRead(...a) }));

const resolve = vi.fn((kind: string, email?: string) => ({ account: { id: `acct-${kind}`, email: email ?? `${kind}@example.invalid` }, labelAccount: false }));
vi.mock('../accounts.js', () => ({ resolveGoogleAccountForRead: (...a: [string, string?]) => resolve(...a) }));

const { executeGoogleReadTool } = await import('../tools-read.js');

beforeEach(() => {
  googleRead.mockClear();
  resolve.mockClear();
  failPage = null;
});

describe('drive_versions_list follows every page of the revision list', () => {
  it('collects every page and lists all revisions newest first', async () => {
    const out = await executeGoogleReadTool('drive_versions_list', { file_id: 'f1' }, 'agent-1', 'Agent');
    expect(out).toContain('5 version(s)');
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) expect(out).toContain(id);
    expect(out.indexOf('r5')).toBeLessThan(out.indexOf('r1'));
  });

  it('a failing later page is an error, not a short list', async () => {
    failPage = 'T1';
    const out = await executeGoogleReadTool('drive_versions_list', { file_id: 'f1' }, 'agent-1', 'Agent');
    expect(out).toMatch(/^Error listing versions/);
    expect(out).toContain('HTTP 500');
  });

  it('a server that keeps handing back the same token ends the list and says it may be incomplete', async () => {
    let calls = 0;
    googleRead.mockImplementation(async () => {
      calls++;
      if (calls > 10) throw new Error('followed the same token without end');
      return { ok: true as const, data: { revisions: [{ id: `r${calls}`, modifiedTime: '2026-01-01T10:00:00Z' }], nextPageToken: 'SAME' } };
    });
    const out = await executeGoogleReadTool('drive_versions_list', { file_id: 'f1' }, 'agent-1', 'Agent');
    expect(calls).toBe(2);
    expect(out).toContain('This list may be incomplete: not every page could be read.');
    expect(out).toContain('2 version(s)');
  });
});
