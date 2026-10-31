// A file in a shared drive looks "not found" to Drive unless the request says supportsAllDrives=true,
// and files.list also needs includeItemsFromAllDrives=true with corpora=allDrives.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const readUrls: string[] = [];
const googleRead = vi.fn(async (...a: unknown[]) => {
  const u = String(a[0]);
  readUrls.push(u);
  if (u.includes('/export?')) return { ok: false as const, error: 'not exportable' };
  if (u.includes('alt=media')) return { ok: true as const, data: 'hello' };
  if (u.includes('/revisions')) return { ok: true as const, data: { revisions: [] } };
  if (u.includes('fields=id,name,mimeType')) return { ok: true as const, data: { id: 'f1', name: 'n', mimeType: 'text/plain' } };
  return { ok: true as const, data: { files: [] } };
});
const googleWrite = vi.fn(async () => ({ ok: true, data: {}, error: null, apiEndpoint: 'x' }));
vi.mock('../client.js', () => ({
  googleRead: (...a: unknown[]) => googleRead(...a),
  googleWrite: (...a: unknown[]) => (googleWrite as (...x: unknown[]) => unknown)(...a),
}));
vi.mock('../accounts.js', () => ({
  resolveGoogleAccountForRead: vi.fn(() => ({ account: { id: 'acct', email: 'a@example.invalid' }, labelAccount: false })),
  resolveGoogleAccountForTool: vi.fn(() => ({
    account: {
      id: 'agent', kind: 'agent', position: 1, email: 'agent@example.com',
      enabled: true, connected: true, accessToken: null, refreshToken: null,
      tokenExpiresAt: null, grantedScopes: null, enabledServices: null,
      watchEmail: false, sendEmail: true, lastVerifiedAt: null,
    },
  })),
}));
vi.mock('../../receipts/store.js', () => ({ writeToolReceipt: vi.fn() }));

const { executeGoogleReadTool } = await import('../tools-read.js');
const { executeGoogleWriteTool } = await import('../tools-write.js');

beforeEach(() => {
  readUrls.length = 0;
  googleRead.mockClear();
  googleWrite.mockClear();
});

describe('Drive calls reach shared-drive files', () => {
  it('drive_list asks for shared-drive items', async () => {
    await executeGoogleReadTool('drive_list', { query: 'report' }, 'agent-1', 'Agent');
    expect(readUrls.length).toBe(1);
    expect(readUrls[0]).toContain('supportsAllDrives=true');
    expect(readUrls[0]).toContain('includeItemsFromAllDrives=true');
    expect(readUrls[0]).toContain('corpora=allDrives');
  });

  it('drive_read metadata, export and download all carry supportsAllDrives', async () => {
    const out = await executeGoogleReadTool('drive_read', { file_id: 'f1' }, 'agent-1', 'Agent');
    expect(out).toContain('hello');
    expect(readUrls.length).toBe(3);
    for (const u of readUrls) expect(u).toContain('supportsAllDrives=true');
  });

  it('drive_versions_list carries supportsAllDrives', async () => {
    await executeGoogleReadTool('drive_versions_list', { file_id: 'f1' }, 'agent-1', 'Agent');
    expect(readUrls.length).toBe(1);
    expect(readUrls[0]).toContain('supportsAllDrives=true');
  });

  it.each([[false], [true]])('drive_delete (permanent=%s) carries supportsAllDrives and encodes the id', async (permanent) => {
    await executeGoogleWriteTool('drive_delete', { file_id: 'a b/c', permanent }, 'agent-1', 'Agent');
    expect(googleWrite).toHaveBeenCalledTimes(1);
    const url = String((googleWrite.mock.calls[0] as unknown[])[1]);
    expect(url).toContain('supportsAllDrives=true');
    expect(url).toContain('a%20b%2Fc');
  });
});
