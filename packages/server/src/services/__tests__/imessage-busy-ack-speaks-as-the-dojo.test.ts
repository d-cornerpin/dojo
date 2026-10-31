// P8 (OR-ENGINE-LABELLED): the busy auto-reply is plainly the Dojo ("Dojo: ...", not the agent's "I"), and the
// agent is told the exact text and recipient on its next turn.
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const runMock = vi.hoisted(() => vi.fn(async (_program: string, _argv: readonly string[]) => ''));
const noticeMock = vi.hoisted(() => vi.fn());
vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: runMock,
}));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: noticeMock }));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { getPrimaryAgentId } from '../../config/platform.js';
import { activeRuns, agentStartTimes } from '../../agent/shared-state.js';
import { maybeSendBusyAck } from '../imessage-bridge.js';

const OWNER = '+15550100198';
const AGENT = getPrimaryAgentId();

beforeAll(() => {
  runMigrations();
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
});
beforeEach(() => { runMock.mockClear(); noticeMock.mockClear(); });

describe('the busy auto-reply', () => {
  it('starts "Dojo:", is not first person, and the agent is told the exact text and recipient', async () => {
    activeRuns.add(AGENT);
    agentStartTimes.set(AGENT, Date.now() - 120_000);
    maybeSendBusyAck(AGENT, OWNER);
    await vi.waitFor(() => expect(runMock).toHaveBeenCalled());
    const sent = JSON.stringify(runMock.mock.calls[0]);
    expect(sent).toContain('Dojo: ');
    expect(sent).not.toContain('On it. I am');
    expect(noticeMock).toHaveBeenCalledTimes(1);
    const n = noticeMock.mock.calls[0][0];
    expect(n.toAgentId).toBe(AGENT);
    expect(n.brief).toContain('Dojo: ');
    expect(n.brief).toContain(OWNER);
    activeRuns.delete(AGENT); agentStartTimes.delete(AGENT);
  });
});
