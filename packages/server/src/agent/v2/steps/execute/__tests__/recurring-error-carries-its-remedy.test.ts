// K37 — two agents hit the same tool error: one counted fingerprint, hits 2, agents 2, and the
// result the model reads carries the registered remedy. An error with no registry entry is
// counted and carries nothing extra. This drives the real post-result seam.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../../../../db/migrations.js';
import { recordToolResultEffects } from '../post-result.js';
import { initState } from '../../../state.js';
import { fingerprint } from '../../../error-fingerprint.js';

function ctxFor(agentId: string) {
  return {
    agentId, turnNumber: 1, db: mockDb.current!,
    counterparty: { kind: 'none' }, persistRoutingMarker: () => undefined,
  } as never;
}
function stateFor(agentId: string) {
  return initState({
    agentId, contextWindow: 100000, isAutoRouted: false, configuredModelId: 'm',
    turnNumber: 1, triggeredByIMessage: false, triggeredByA2AReplyIntent: false,
    lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null,
    inboundContext: null, pendingTechniqueAck: null,
  } as never);
}
async function fail(agentId: string, tool: string, args: Record<string, unknown>, content: string) {
  const r = await recordToolResultEffects(
    stateFor(agentId), { id: 'c1', name: tool, arguments: args } as never,
    { toolCallId: 'c1', name: tool, content, isError: true } as never, ctxFor(agentId),
  );
  return r.toolResult.content as string;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('recurring tool errors are counted across agents and carry their remedy', () => {
  it('two agents, the same invalid-label failure: one fingerprint, hits 2, agents 2, remedy on the result', async () => {
    const text = 'Error modifying labels: Invalid label: Junk E-mail';
    const first = await fail('agent-a', 'gmail_label', { message_id: 'm1' }, text);
    const second = await fail('agent-b', 'user_gmail_label', { message_id: 'm2' }, text);
    const rows = mockDb.current!.prepare('SELECT * FROM tool_error_signatures').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe('gmail_label');
    expect(rows[0].fingerprint).toBe(fingerprint('gmail_label', text));
    expect(rows[0].hits).toBe(2);
    expect(JSON.parse(rows[0].agents as string)).toEqual(['agent-a', 'agent-b']);
    // The remedy follows the tool AS CALLED: the user_ call is pointed at the user_ lister.
    expect(first).toContain('gmail_list_labels');
    expect(second).toContain('user_gmail_list_labels');
    expect(second).toMatch(/does not exist on this Gmail account/i);
  });

  it('an error with no registry entry is counted and the result is left exactly as it was', async () => {
    const text = 'Error: upstream said no (code 41)';
    const out = await fail('agent-a', 'some_tool', {}, text);
    expect(out).toBe(text);
    const row = mockDb.current!.prepare('SELECT hits, agents FROM tool_error_signatures WHERE tool = ?').get('some_tool') as { hits: number; agents: string };
    expect(row.hits).toBe(1);
    expect(JSON.parse(row.agents)).toEqual(['agent-a']);
  });

  it('ids and numbers in otherwise identical errors count as one signature', async () => {
    await fail('agent-a', 'some_tool', { a: 1 }, 'Error: item 18f3a9c2d4e5b601 is locked (retry in 30s)');
    await fail('agent-a', 'some_tool', { a: 2 }, 'Error: item 77aa88bb99cc0011 is locked (retry in 45s)');
    const row = mockDb.current!.prepare('SELECT hits, agents FROM tool_error_signatures').get() as { hits: number; agents: string };
    expect(row.hits).toBe(2);
    expect(JSON.parse(row.agents)).toEqual(['agent-a']);
  });

  it('a Teams access-denied failure carries the work/school-account remedy; the same text from a non-Teams tool does not', async () => {
    const text = 'Error sending message: Access denied (HTTP 403 Forbidden).';
    const teams = await fail('agent-a', 'teams_send_message', {}, text);
    const other = await fail('agent-a', 'outlook_search', {}, text);
    expect(teams).toMatch(/work\/school account/i);
    expect(other).toBe(text);
  });

  it('a Teams failure that is not the personal-account 403 is not blamed on the account type', async () => {
    const other = await fail('agent-a', 'teams_send_message', {}, 'Error sending message: Access denied: the token has expired (HTTP 401).');
    expect(other).not.toMatch(/work\/school/i);
  });

  it('a success writes nothing to the ledger', async () => {
    await recordToolResultEffects(
      stateFor('agent-a'), { id: 'c1', name: 'gmail_label', arguments: {} } as never,
      { toolCallId: 'c1', name: 'gmail_label', content: 'Labels updated', isError: false } as never, ctxFor('agent-a'),
    );
    expect(mockDb.current!.prepare('SELECT COUNT(*) AS n FROM tool_error_signatures').get()).toEqual({ n: 0 });
  });
});
