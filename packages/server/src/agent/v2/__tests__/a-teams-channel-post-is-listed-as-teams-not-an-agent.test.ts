// The RECENT OUTBOUND block names the channel a send went on: a Teams channel post is Teams,
// and an owner-account twin sends on its base tool's channel.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { channelOfSendTool } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => undefined }));

import { runMigrations } from '../../../db/migrations.js';
import { writeToolReceipt } from '../../../receipts/store.js';
import { getRecentOutbound, renderRecentOutboundBlock } from '../outbound-ledger.js';
import { outboundChannelForTool } from '../outbound.js';

const AGENT = 'agent-under-test';

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Worker', 'idle', '1970-01-01')`).run(AGENT);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('a Teams channel post is listed as Teams, not an agent', () => {
  it('the block says Teams for a channel post', () => {
    writeToolReceipt({
      agentId: AGENT, tool: 'teams_send_channel_message', tier: 1, verified: true, basis: 'provider-id',
      providerId: 'm-1', recipient: 'channel-general',
    });
    const block = renderRecentOutboundBlock(getRecentOutbound(AGENT, 24, 5));
    expect(block).toContain('Teams -> channel-general');
    expect(block).not.toContain('agent ->');
  });

  it('a message to another agent is still listed as agent', () => {
    writeToolReceipt({
      agentId: AGENT, tool: 'send_to_agent', tier: 1, verified: true, basis: 'provider-id',
      recipient: 'the helper', sentText: 'Please check the report.',
    });
    expect(renderRecentOutboundBlock(getRecentOutbound(AGENT, 24, 5))).toContain('agent -> the helper');
  });

  it("an owner-account twin sends on its base tool's channel, in both readers", () => {
    expect(channelOfSendTool('user_gmail_send')).toBe('email');
    expect(channelOfSendTool('user_teams_send_channel_message')).toBe('teams');
    expect(outboundChannelForTool('user_teams_send_channel_message')).toBe('teams');
    expect(outboundChannelForTool('send_to_agent')).toBeNull();
  });
});
