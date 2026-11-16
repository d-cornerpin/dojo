// Only the owner's Stop drops queued replies. Stopping runs for a data import, and ending an agent, both stop
// the agent too, but a reply waiting to go stays queued and nothing is marked "not sent".
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../services/imessage-bridge.js', async (orig) => (await import('./helpers/reply-sender.js')).bridgeMock(await orig()));
vi.mock('../../../services/presence.js', () => ({ getPresence: () => 'in_dojo', isImessageConfigured: () => true }));
vi.mock('../../../config/platform.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), isPrimaryAgent: () => true }));
vi.mock('../../access/engine-route.js', () => ({ engineMayRouteTo: () => true, engineRouteRefusalReason: () => 'no grant' }));
vi.mock('../steps/finalize/link-backstop.js', () => ({ appendUndeliveredLinks: async (s: unknown) => s }));
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../vault/archive.js', () => ({ archiveAgentConversation: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { routeTerminalReply } from '../steps/finalize/route-reply.js';
import { stopAgentRunsForImport } from '../../../migration/import-agents.js';
import { terminateAgent } from '../../spawner.js';
import { activeRuns, stoppedAgents } from '../../shared-state.js';
import { freshReplyDb, personTurn, replyRows, AGENT, T0 } from './helpers/reply-sender.js';
import { pills } from './helpers/owner-stop.js';

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(T0);
  freshReplyDb(runMigrations);
  stoppedAgents.delete(AGENT);
  await routeTerminalReply(...personTurn('here is the address', { channel: 'imessage' }));
});

describe('import and terminate leave queued replies alone', () => {
  it('stopping runs for an import keeps the queued reply', () => {
    activeRuns.add(AGENT);
    try { stopAgentRunsForImport(); } finally { activeRuns.delete(AGENT); }
    expect(stoppedAgents.has(AGENT)).toBe(true);
    expect(replyRows()[0].outcome).toBe('pending');
    expect(pills().some((p) => p.includes('not sent'))).toBe(false);
  });

  it('ending the agent keeps the queued reply', () => {
    terminateAgent(AGENT, 'test');
    expect(stoppedAgents.has(AGENT)).toBe(true);
    expect(replyRows()[0].outcome).toBe('pending');
    expect(pills().some((p) => p.includes('not sent'))).toBe(false);
  });
});
