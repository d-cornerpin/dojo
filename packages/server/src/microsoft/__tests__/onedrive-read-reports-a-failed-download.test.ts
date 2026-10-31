// `onedrive_read` on a text-like file downloads `…/content` inside a bare
// `catch { /* fall through to metadata */ }`. A 403, a timeout, or a token that
// would not refresh therefore printed the "(Binary file …)" metadata message next
// to `Type: text/plain` — the agent told the owner the file was binary and reached
// for a download tool that does not apply. A failed download of a text-like file
// now reports the real reason; only genuinely binary files keep the fall-through.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(),
  calendarPrefix: (id?: string) => (id ? `me/calendars/${id}/` : 'me/'),
  drivePrefix: () => 'me/drive/',
  graphFetch: vi.fn(),
}));
vi.mock('../auth.js', () => ({
  getValidAccessTokenForAccount: vi.fn(async () => 'tok'),
}));
vi.mock('../accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMicrosoftAccountForRead: vi.fn(() => ({ account: { id: 'agent', kind: 'agent', email: 'agent@example.com', connected: true }, labelAccount: false })),
}));

import { msGraphRead, graphFetch } from '../client.js';
import { executeMicrosoftReadTool } from '../tools-read.js';

const metaData = { id: 'f1', name: 'notes.txt', size: 10, file: { mimeType: 'text/plain' } };

const read = () =>
  executeMicrosoftReadTool('onedrive_read', { file_id: 'f1' }, 'agent-1', 'Agent One');

beforeEach(() => {
  vi.mocked(msGraphRead).mockReset();
  vi.mocked(graphFetch).mockReset();
  vi.mocked(msGraphRead).mockResolvedValue({ ok: true, data: metaData, error: null } as never);
});

describe('onedrive_read — a failed text download says so instead of blaming the file type', () => {
  it('a 403 on the content download names the status and is not reported as a binary file', async () => {
    vi.mocked(graphFetch).mockResolvedValue({ ok: false, status: 403, text: async () => 'Forbidden' } as never);
    const out = await read();
    expect(out.startsWith('Error reading')).toBe(true);
    expect(out).toContain('notes.txt');
    expect(out).toContain('403');
    expect(out).not.toContain('Binary file');
  });

  it('a thrown download (timeout, token refresh that died) names the error', async () => {
    vi.mocked(graphFetch).mockRejectedValue(new Error('The operation was aborted due to timeout'));
    const out = await read();
    expect(out.startsWith('Error reading')).toBe(true);
    expect(out).not.toContain('Binary file');
  });

  it('an ok download returns the file text', async () => {
    vi.mocked(graphFetch).mockResolvedValue({ ok: true, status: 200, text: async () => 'buy milk' } as never);
    const out = await read();
    expect(out).toContain('buy milk');
    expect(out).not.toContain('Binary file');
  });

  it('a genuinely binary file still gets the metadata message', async () => {
    vi.mocked(msGraphRead).mockResolvedValue({ ok: true, data: { ...metaData, file: { mimeType: 'application/pdf' } }, error: null } as never);
    const out = await read();
    expect(out).toContain('(Binary file');
    expect(vi.mocked(graphFetch)).not.toHaveBeenCalled();
  });
});
