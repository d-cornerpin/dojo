// Half-failed Microsoft batches must look failed to the engine.
//
// THE DEFECT. The engine decides a call failed from its first word (`isError = content.startsWith('Error')`,
// agent/tools/index.ts). Gmail's batch label follows that: a partial result starts with `Error modifying
// labels:` and then names what was and was not changed (google/gmail-label.ts). Two Microsoft batch tools
// said the same kind of thing but started with another word — `Batch upload: 0/5 ...` and
// `Moved 3 of 5 messages ...` — so a half-failed run was a SUCCESS to the engine, the work ledger and the
// owner's "did it work" view.
//
// THE RULE. Keep every word of both texts; only when at least one item FAILED put `Error: ` in front.
// When nothing failed the text is byte-for-byte what it was.

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

import { msGraphRead, msGraphWrite, graphFetch } from '../client.js';
import { executeMicrosoftWriteTool } from '../tools-write.js';

const ok = (data: unknown) => ({ ok: true, data, error: undefined, apiEndpoint: 'x' });
const fail = (error: string) => ({ ok: false, data: null, error, apiEndpoint: 'x' });

/** The mailbox: message m1 sits in conversation conv1, which has `size` messages. */
function mailbox(opts: { size?: number; failIds?: string[] } = {}) {
  const size = opts.size ?? 7;
  vi.mocked(msGraphRead).mockImplementation((async (endpoint: string) => {
    if (/^me\/messages\/[^/?]+\?\$select=conversationId,parentFolderId$/.test(endpoint)) return ok({ id: 'm1', conversationId: 'conv1', parentFolderId: 'inbox-id' });
    if (endpoint.startsWith('me/messages?') && decodeURIComponent(endpoint).includes("conversationId eq 'conv1'")) {
      return ok({ value: Array.from({ length: size }, (_, i) => ({ id: `c${i + 1}`, parentFolderId: 'inbox-id' })) });
    }
    return fail(`unexpected read ${endpoint}`);
  }) as never);
  vi.mocked(msGraphWrite).mockImplementation((async (_m: string, endpoint: string, body: unknown) => {
    if (endpoint === '$batch') {
      const reqs = (body as { requests: Array<{ id: string; url: string }> }).requests;
      return ok({
        responses: reqs.map((r) => {
          const bad = (opts.failIds ?? []).some((f) => r.url.includes(`/${f}/`));
          return bad ? { id: r.id, status: 404, body: { error: { message: 'The specified object was not found in the store.' } } }
                     : { id: r.id, status: 201, body: { id: `new-${r.id}` } };
        }),
      });
    }
    return ok({ id: 'moved-1' });
  }) as never);
}

const putOk = { ok: true, status: 200, json: async () => ({ id: 'i' }) } as never;
const putBoom = { ok: false, status: 500, text: async () => 'boom' } as never;

let fileA: string;
let fileB: string;

beforeEach(() => {
  vi.mocked(msGraphRead).mockReset();
  vi.mocked(msGraphWrite).mockReset();
  vi.mocked(graphFetch).mockReset();
  const uniq = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fileA = path.join(os.tmpdir(), `partial-batch-a-${uniq}.txt`);
  fileB = path.join(os.tmpdir(), `partial-batch-b-${uniq}.txt`);
  fs.writeFileSync(fileA, 'first file');
  fs.writeFileSync(fileB, 'second file');
});
afterEach(() => {
  fs.rmSync(fileA, { force: true });
  fs.rmSync(fileB, { force: true });
});

describe('a partly-failed Microsoft batch comes back as an Error result', () => {
  it('onedrive_upload_batch with one file failed leads with Error: and keeps the whole report', async () => {
    vi.mocked(graphFetch).mockResolvedValueOnce(putOk).mockResolvedValueOnce(putBoom);
    const out = await executeMicrosoftWriteTool('onedrive_upload_batch', { file_paths: [fileA, fileB] }, 'agent-1', 'Agent One');
    expect(out.startsWith('Error: Batch upload: 1/2 files uploaded successfully')).toBe(true);
    expect(out).toContain(fileB);
    expect(out).toContain('boom');
  });

  it('a conversation move that left one message behind leads with Error: Moved', async () => {
    mailbox({ size: 7, failIds: ['c3'] });
    const out = await executeMicrosoftWriteTool('outlook_move_to_folder', { message_id: 'm1', folder_id: 'archive' }, 'agent-1', 'A Worker');
    expect(out.startsWith('Error: Moved')).toBe(true);
    expect(out).toMatch(/Moved 6 of 7 messages/);
    expect(out).toMatch(/not found in the store/);
  });
});

describe('a fully-successful batch keeps its exact old words, un-prefixed', () => {
  it('onedrive_upload_batch with everything uploaded is byte-for-byte the old summary', async () => {
    vi.mocked(graphFetch).mockResolvedValue(putOk);
    const out = await executeMicrosoftWriteTool('onedrive_upload_batch', { file_paths: [fileA, fileB] }, 'agent-1', 'Agent One');
    expect(out).toBe('Batch upload: 2/2 files uploaded successfully.');
  });

  it('the whole conversation moved still starts with Moved the WHOLE conversation', async () => {
    mailbox({ size: 7 });
    const out = await executeMicrosoftWriteTool('outlook_move_to_folder', { message_id: 'm1', folder_id: 'archive' }, 'agent-1', 'A Worker');
    expect(out.startsWith('Moved the WHOLE conversation')).toBe(true);
  });
});
