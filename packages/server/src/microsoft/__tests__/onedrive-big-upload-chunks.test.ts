// Graph upload sessions only accept fragments that are a multiple of 320 KiB (327,680 bytes);
// every piece except the last must obey it. A session that never returns 200/201 is not "uploaded".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../client.js', () => ({
  msGraphRead: vi.fn(),
  msGraphWrite: vi.fn(),
  calendarPrefix: (id?: string) => (id ? `me/calendars/${id}/` : 'me/'),
  drivePrefix: () => 'me/drive/',
  graphFetch: vi.fn(),
}));
vi.mock('../auth.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getValidAccessTokenForAccount: vi.fn(async () => 'tok'),
}));
vi.mock('../accounts.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  resolveMicrosoftAccountForTool: vi.fn(() => ({
    account: { id: 'agent', kind: 'agent', email: 'agent@example.com', connected: true, sendEmail: true },
  })),
}));

import { graphFetch } from '../client.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';

const SIZE = 9_000_000;
const MULTIPLE = 327_680;
let file: string;
let ranges: string[];

function install(lastStatus: number) {
  vi.mocked(graphFetch).mockImplementation((async (_a: string, url: string, init?: { headers?: Record<string, string> }) => {
    if (url.includes('createUploadSession')) {
      return { ok: true, status: 200, json: async () => ({ uploadUrl: 'https://upload.example/s1' }), text: async () => '' };
    }
    const range = init?.headers?.['Content-Range'] ?? '';
    ranges.push(range);
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(range)!;
    const last = Number(m[2]) + 1 === Number(m[3]);
    if (last && lastStatus === 201) {
      return { ok: true, status: 201, json: async () => ({ id: 'i1', name: 'big.bin', webUrl: 'https://example/big' }), text: async () => '' };
    }
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
  }) as never);
}

function pieceLengths(): number[] {
  return ranges.map((r) => {
    const m = /bytes (\d+)-(\d+)\//.exec(r)!;
    return Number(m[2]) - Number(m[1]) + 1;
  });
}

beforeEach(() => {
  ranges = [];
  vi.mocked(graphFetch).mockReset();
  file = path.join(os.tmpdir(), `big-upload-${process.pid}-${Date.now()}.bin`);
  fs.writeFileSync(file, Buffer.alloc(SIZE, 1));
});
afterEach(() => { fs.rmSync(file, { force: true }); });

describe('OneDrive big upload', () => {
  it('onedrive_upload cuts pieces in multiples of 320 KiB and reports the file', async () => {
    install(201);
    const out = await executeMicrosoftWriteTool('onedrive_upload', { file_path: file, name: 'big.bin' }, 'agent-1', 'Agent One');
    const lens = pieceLengths();
    expect(lens.length).toBeGreaterThan(1);
    for (const n of lens.slice(0, -1)) expect(n % MULTIPLE).toBe(0);
    expect(lens.reduce((a, b) => a + b, 0)).toBe(SIZE);
    expect(out).toContain('big.bin');
    expect(out).not.toMatch(/^Error/);
  });

  it('onedrive_upload_batch cuts pieces in multiples of 320 KiB', async () => {
    install(201);
    const out = await executeMicrosoftWriteTool('onedrive_upload_batch', { file_paths: [file] }, 'agent-1', 'Agent One');
    const lens = pieceLengths();
    for (const n of lens.slice(0, -1)) expect(n % MULTIPLE).toBe(0);
    expect(out).toContain('1/1 files uploaded');
  });

  it('onedrive_upload does not claim success when OneDrive never confirms the file', async () => {
    install(202);
    const out = await executeMicrosoftWriteTool('onedrive_upload', { file_path: file, name: 'big.bin' }, 'agent-1', 'Agent One');
    expect(out).toMatch(/^Error/);
  });

  it('onedrive_upload_batch counts an unconfirmed upload as failed', async () => {
    install(202);
    const out = await executeMicrosoftWriteTool('onedrive_upload_batch', { file_paths: [file] }, 'agent-1', 'Agent One');
    expect(out).toContain('0/1 files uploaded');
  });
});
