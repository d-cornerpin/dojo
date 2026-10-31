// 706 — on the AppleScript fallback the file can go out while its words fail. That must
// not be reported as a fully delivered text: the words get one retry on their own, the
// ledger says failed, and the file is never sent a second time. osascript is a mock.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runMock = vi.hoisted(() => vi.fn(async (_program: string, _argv: readonly string[]) => ''));
vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: runMock,
}));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { sendIMessageWithAttachments } from '../imessage-bridge.js';

const OWNER = '+15550100198';
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-fail-'));
const FILE = path.join(SCRATCH, 'pic.png');

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
  fs.writeFileSync(FILE, 'x');
});
afterAll(() => { fs.rmSync(SCRATCH, { recursive: true, force: true }); });

const script = (call: unknown[]): string => String((call[1] as readonly string[]).join(' '));
const fileCalls = () => runMock.mock.calls.filter((c) => script(c).includes('POSIX file'));
const wordCalls = () => runMock.mock.calls.filter((c) => !script(c).includes('POSIX file'));
const lastRow = (): { outcome: string; detail: string | null } | undefined => getDb().prepare(
  "SELECT outcome, detail FROM deliveries WHERE channel = 'imessage' ORDER BY rowid DESC LIMIT 1",
).get() as { outcome: string; detail: string | null } | undefined;

beforeEach(() => {
  runMock.mockReset();
  runMock.mockImplementation(async (_p, argv) => {
    if (!argv.join(' ').includes('POSIX file')) throw new Error('script failed');
    return '';
  });
});

describe('706 a failed caption is not reported delivered', () => {
  it('file counted sent, words not sent, nothing marked failed', async () => {
    const r = await sendIMessageWithAttachments(OWNER, 'the words', [FILE]);
    expect(r.sentFiles).toEqual([FILE]);
    expect(r.failedFiles).toEqual([]);
    expect(r.textSent).toBe(false);
  });
  it('file sent once; words tried inside the file send and once more on their own', async () => {
    await sendIMessageWithAttachments(OWNER, 'the words', [FILE]);
    expect(fileCalls()).toHaveLength(1);
    expect(wordCalls()).toHaveLength(2);
  });
  it('the ledger row is failed and names the caption', async () => {
    await sendIMessageWithAttachments(OWNER, 'the words', [FILE]);
    const row = lastRow();
    expect(row?.outcome).toBe('failed');
    expect(row?.detail ?? '').toContain('caption');
  });
  it('control: both go out, text sent and ledger delivered', async () => {
    runMock.mockImplementation(async () => '');
    const r = await sendIMessageWithAttachments(OWNER, 'the words', [FILE]);
    expect(r.textSent).toBe(true);
    expect(lastRow()?.outcome).toBe('delivered');
  });
});
