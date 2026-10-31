// A send the iMessage door never actually delivered must not be reported as
// delivered: sendResponseViaIMessage has to resolve to null, not a recipient
// object, so the routing marker and the A2A relay refusal can both fire.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const runMock = vi.hoisted(() => vi.fn(async (_program: string, _argv: readonly string[]) => ''));
vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: runMock,
}));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { sendResponseViaIMessage } from '../imessage-bridge.js';

const OWNER = '+15550100198';
const AGENT = getPrimaryAgentId();

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
});

// With imsg absent, every send falls to the AppleScript (osascript) path, which
// runs through runMessagesProgram. Make it throw, so every send fails.
beforeEach(() => {
  runMock.mockReset();
  runMock.mockImplementation(async () => { throw new Error('osascript failed'); });
});

describe('a failed auto-reply text is not reported as delivered', () => {
  it('a failed send to an override recipient resolves to null', async () => {
    expect(await sendResponseViaIMessage('hello', AGENT, OWNER)).toBeNull();
  });
  it('a failed owner-bound send resolves to null', async () => {
    expect(await sendResponseViaIMessage('hello', AGENT, undefined, true)).toBeNull();
  });
  it('a failed starred-default send resolves to null', async () => {
    expect(await sendResponseViaIMessage('hello', AGENT)).toBeNull();
  });
  it('a send that lands still reports the true recipient', async () => {
    runMock.mockImplementation(async () => '');
    expect(await sendResponseViaIMessage('hello', AGENT)).toEqual({ address: OWNER, name: 'Owner' });
  });
});
