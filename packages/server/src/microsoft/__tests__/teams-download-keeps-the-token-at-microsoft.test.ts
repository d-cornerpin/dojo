// The Microsoft sign-in token must only ever be sent to Microsoft Graph. A Teams
// attachment's contentUrl comes from the chat message (so from its sender); it must not
// decide where the token goes, including when the link is built to look like Microsoft's.

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
    resolveMicrosoftAccountForTool: () => ({
      account: { id: 'user-acct', kind: 'user', email: 'owner@example.test', connected: true, sendEmail: true },
    }),
  };
});

import { msGraphRead, graphFetch } from '../client.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
let savePath: string;

beforeEach(() => {
  vi.mocked(msGraphRead).mockReset();
  vi.mocked(graphFetch).mockReset();
  vi.mocked(graphFetch).mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('hi').buffer } as never);
  savePath = path.join(os.tmpdir(), `teams-token-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
});
afterEach(() => {
  fs.rmSync(savePath, { force: true });
});

async function download(contentUrl: string, contentType = 'text/plain'): Promise<string> {
  vi.mocked(msGraphRead).mockResolvedValue(ok({
    attachments: [{ id: 'att1', name: 'f.txt', contentType, contentUrl }],
  }));
  return executeMicrosoftWriteTool(
    'user_teams_download_attachment',
    { chat_id: 'c1', message_id: 'm1', attachment_id: 'att1', save_path: savePath },
    'agent-1', 'Agent One',
  );
}

/** Every URL the Bearer token was sent to. */
function tokenTargets(): string[] {
  return vi.mocked(graphFetch).mock.calls
    .filter(c => JSON.stringify((c[2] as RequestInit | undefined)?.headers ?? {}).includes('Bearer'))
    .map(c => String(c[1]));
}

describe('teams_download_attachment keeps the token at Microsoft Graph', () => {
  const foreign = [
    'https://example.test/files/f.txt',
    'https://graph.microsoft.com.example.test/v1.0/f.txt',
    'https://example.test/graph.microsoft.com/v1.0/f.txt',
    'https://graph.microsoft.com@example.test/v1.0/f.txt',
    'https://graph.microsoft.com.@example.test/f.txt',
    'https://evilgraph.microsoft.com.example.test/f.txt',
    'http://graph.microsoft.com/v1.0/f.txt',
    'https://graph.microsoft.com:8443/v1.0/f.txt',
    'ftp://graph.microsoft.com/f.txt',
    'not a url',
  ];

  for (const url of foreign) {
    it(`does not send the token to ${url}, and says why`, async () => {
      const out = await download(url);
      expect(tokenTargets()).toEqual([]);
      expect(vi.mocked(graphFetch)).not.toHaveBeenCalled();
      expect(out).toMatch(/^Error:/);
      expect(out).toMatch(/Microsoft Graph/);
      expect(fs.existsSync(savePath)).toBe(false);
    });
  }

  it('still downloads an attachment hosted on Microsoft Graph', async () => {
    const out = await download('https://graph.microsoft.com/v1.0/me/drive/items/abc/content');
    expect(tokenTargets()).toEqual(['https://graph.microsoft.com/v1.0/me/drive/items/abc/content']);
    expect(out).toContain('saved to');
  });

  it('still resolves a SharePoint reference through the Graph shares endpoint', async () => {
    const out = await download('https://contoso.sharepoint.com/sites/team/f.txt', 'reference');
    const targets = tokenTargets();
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatch(/^https:\/\/graph\.microsoft\.com\/v1\.0\/shares\/u![^/]+\/driveItem\/content$/);
    expect(out).toContain('saved to');
  });

  it('sends a link that only looks like SharePoint to the Graph resolver, never to the link itself', async () => {
    await download('https://example.test/x?sharepoint.com');
    for (const t of tokenTargets()) expect(new URL(t).hostname).toBe('graph.microsoft.com');
  });
});
