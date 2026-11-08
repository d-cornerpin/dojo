// t277 / s08 F6 — OneDrive and Teams downloads use the RESOLVED account's token,
// not the agent slot's. The user_ prefix resolves the owner's account (slot), but
// the raw content/download Graph calls pulled the agent's cached token
// (`getAccessToken()` / `getValidAccessToken('agent')`), so owner-side reads
// refused the content and the agent got metadata only (or "(agent account)").

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(), msGraphWrite: vi.fn(), graphFetch: vi.fn(),
  calendarPrefix: () => 'me/', drivePrefix: () => 'me/drive/',
}));
vi.mock('../auth.js', () => ({
  getValidAccessToken: async () => 'AGENT-TOKEN',
  getValidAccessTokenForAccount: vi.fn(async (id: string): Promise<string | null> => `token-for-${id}`),
}));
vi.mock('../accounts.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('../accounts.js');
  return {
    ...actual,
    resolveMicrosoftAccountForRead: () => ({
      account: { id: 'user-acct', kind: 'user', email: 'owner@example.com', connected: true },
      labelAccount: false,
    }),
    resolveMicrosoftAccountForTool: () => ({
      account: { id: 'user-acct', kind: 'user', email: 'owner@example.com', connected: true, sendEmail: true },
    }),
  };
});

import { msGraphRead, graphFetch } from '../client.js';
import { getValidAccessTokenForAccount } from '../auth.js';
import { executeMicrosoftReadTool } from '../tools-read.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
let savePath: string;

beforeEach(() => {
  vi.mocked(msGraphRead).mockReset();
  vi.mocked(graphFetch).mockReset();
  vi.mocked(getValidAccessTokenForAccount).mockReset();
  vi.mocked(getValidAccessTokenForAccount).mockImplementation(async (id: string) => `token-for-${id}`);
  savePath = path.join(os.tmpdir(), `teams-attachment-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
});
afterEach(() => {
  fs.rmSync(savePath, { force: true });
});

describe('downloads use the resolved account token', () => {
  it('onedrive_read downloads content with the resolved user account token', async () => {
    vi.mocked(msGraphRead).mockResolvedValue(ok({ id: 'f1', name: 'a.txt', size: 5, file: { mimeType: 'text/plain' } }));
    vi.mocked(graphFetch).mockResolvedValue({ ok: true, text: async () => 'file text' } as never);
    const out = await executeMicrosoftReadTool('user_onedrive_read', { file_id: 'f1' }, 'agent-1', 'Agent One');
    const init = vi.mocked(graphFetch).mock.calls[0][2] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-for-user-acct');
    expect(out).toContain('file text');
  });

  it('teams_download_attachment downloads with the resolved user account token', async () => {
    vi.mocked(msGraphRead).mockResolvedValue(ok({
      attachments: [{ id: 'att1', name: 'f.txt', contentType: 'text/plain', contentUrl: 'https://graph.microsoft.com/v1.0/me/drive/items/f1/content' }],
    }));
    vi.mocked(graphFetch).mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('hi').buffer } as never);
    const out = await executeMicrosoftWriteTool(
      'user_teams_download_attachment',
      { chat_id: 'c1', message_id: 'm1', attachment_id: 'att1', save_path: savePath },
      'agent-1', 'Agent One',
    );
    const init = vi.mocked(graphFetch).mock.calls[0][2] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer token-for-user-acct');
    expect(out).toContain('saved to');
  });

  it('onedrive_read answers "not authenticated" when the resolved account token is null', async () => {
    vi.mocked(msGraphRead).mockResolvedValue(ok({ id: 'f1', name: 'a.txt', size: 5, file: { mimeType: 'text/plain' } }));
    vi.mocked(getValidAccessTokenForAccount).mockResolvedValueOnce(null);
    const out = await executeMicrosoftReadTool('user_onedrive_read', { file_id: 'f1' }, 'agent-1', 'Agent One');
    expect(graphFetch).not.toHaveBeenCalled();
    expect(out).toMatch(/^Error reading .*a\.txt.*: not authenticated with Microsoft\.$/);
  });

  it('teams_download_attachment answers "not authenticated" when the resolved account token is null', async () => {
    vi.mocked(msGraphRead).mockResolvedValue(ok({
      attachments: [{ id: 'att1', name: 'f.txt', contentType: 'text/plain', contentUrl: 'https://contoso.example/files/f.txt' }],
    }));
    vi.mocked(getValidAccessTokenForAccount).mockResolvedValueOnce(null);
    const out = await executeMicrosoftWriteTool(
      'user_teams_download_attachment',
      { chat_id: 'c1', message_id: 'm1', attachment_id: 'att1', save_path: savePath },
      'agent-1', 'Agent One',
    );
    expect(out).toBe('Error: not authenticated with Microsoft.');
    expect(graphFetch).not.toHaveBeenCalled();
  });
});
