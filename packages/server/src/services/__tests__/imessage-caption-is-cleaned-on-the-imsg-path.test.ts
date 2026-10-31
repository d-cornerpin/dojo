// 705 — the words that ride with a picture or file are cleaned like every other iMessage
// text, on the imsg path too. imsg itself is a mock: nothing real is run.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const runMock = vi.hoisted(() => vi.fn(async (_program: string, _argv: readonly string[]) => ''));
vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => '/fake/imsg',
  runMessagesProgram: runMock,
}));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { sendIMessageWithAttachment } from '../imessage-bridge.js';

const OWNER = '+15550100198';

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
});
beforeEach(() => runMock.mockClear());

async function argvFor(caption?: string): Promise<string[]> {
  await sendIMessageWithAttachment(OWNER, '/tmp/x.png', caption);
  expect(runMock).toHaveBeenCalledTimes(1);
  return [...(runMock.mock.calls[0][1] as readonly string[])];
}
const textArg = (argv: string[]): string | undefined => { const i = argv.indexOf('--text'); return i < 0 ? undefined : argv[i + 1]; };

describe('705 imsg caption is cleaned', () => {
  it('strips bold marks', async () => { expect(textArg(await argvFor('**Here** is the plan'))).toBe('Here is the plan'); });
  it('strips headings and extra blank lines', async () => { expect(textArg(await argvFor('# Title\n\n\n\nbody'))).toBe('Title\n\nbody'); });
  it('a caption that cleans to nothing sends no --text', async () => { expect(await argvFor('```\n```')).not.toContain('--text'); });
  it('plain words are untouched', async () => { expect(textArg(await argvFor('plain words'))).toBe('plain words'); });
  it('no caption, no --text', async () => { expect(await argvFor(undefined)).not.toContain('--text'); });
});
