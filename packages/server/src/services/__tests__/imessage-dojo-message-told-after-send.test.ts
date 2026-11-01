// Item 6: the agent is told "the Dojo sent X" only AFTER the send succeeded, and told plainly when it failed.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const runMock = vi.hoisted(() => vi.fn(async (_p: string, _a: readonly string[]) => ''));
const noticeMock = vi.hoisted(() => vi.fn());
vi.mock('../imessage-run.js', async (orig) => ({ ...(await orig<typeof import('../imessage-run.js')>()), getImsgPath: () => null, runMessagesProgram: runMock }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: noticeMock }));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { activeRuns, agentStartTimes } from '../../agent/shared-state.js';
import { maybeSendBusyAck, processInboundIMessage } from '../imessage-bridge.js';

const OWNER = '+15550100198';
const AGENT = getPrimaryAgentId();
beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
});
beforeEach(() => { runMock.mockReset(); runMock.mockImplementation(async () => ''); noticeMock.mockClear(); activeRuns.delete(AGENT); agentStartTimes.delete(AGENT); });

const cmd = () => processInboundIMessage({ sender: OWNER, cleanedText: 'status', advanceRowId: null, wakeAgent: false });

describe('a command reply', () => {
  it('tells the agent the exact text once the send landed', async () => {
    await cmd();
    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(noticeMock.mock.calls[0][0].brief).toContain('Dojo: Status report');
    expect(noticeMock.mock.calls[0][0].brief).not.toMatch(/FAILED/);
  });
  it('tells the agent the send FAILED when it did not land (never "the Dojo sent X")', async () => {
    runMock.mockImplementation(async () => { throw new Error('osascript failed'); });
    await cmd();
    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(noticeMock.mock.calls[0][0].brief).toMatch(/FAILED/);
    expect(noticeMock.mock.calls[0][0].brief).not.toMatch(/\bsent \+15550100198 this text\b/);
  });
});

describe('the busy auto-reply', () => {
  const ack = () => { activeRuns.add(AGENT); agentStartTimes.set(AGENT, Date.now() - 120_000); maybeSendBusyAck(AGENT, OWNER); };
  it('tells the agent only after the send landed', async () => {
    ack();
    await vi.waitFor(() => expect(noticeMock).toHaveBeenCalledTimes(1));
    expect(noticeMock.mock.calls[0][0].brief).not.toMatch(/FAILED/);
  });
  it('says it FAILED when the send failed', async () => {
    runMock.mockImplementation(async () => { throw new Error('osascript failed'); });
    ack();
    await vi.waitFor(() => expect(noticeMock).toHaveBeenCalledTimes(1));
    expect(noticeMock.mock.calls[0][0].brief).toMatch(/FAILED/);
  });
});
