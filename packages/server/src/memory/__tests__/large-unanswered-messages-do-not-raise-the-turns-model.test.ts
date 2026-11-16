// The owner's open messages a turn serves are re-shown when a fold took them out of view. Together they stay
// inside the live conversation's room: the newest is shown whole, older ones shrink to their kept-row pointer
// (the same view and paging a long row already has), so a pile of large asks does not push the assembly past the
// window and onto a bigger model. Through the real assembler.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { claimAsk } from '../../work/store.js';
import { openTurnContext, endTurnContext } from '../../agent/turn-context.js';
import { createLeafSummary } from '../dag.js';
import { assembleContext } from '../assembler.js';
import { servedOwnerMessageIds } from '../served-ask.js';

const AGENT = 'primary';
let n = 0;
function say(role: 'user' | 'assistant', content: string, id = `m-${++n}`): string {
  insertMessage({
    id, agentId: AGENT, role, content, turnNumber: 1, channel: 'dashboard', senderId: 'owner', conversationId: 'conv-dash',
    ...(role === 'user' ? { inboundMeta: JSON.stringify({ channel: 'dashboard', relation: 'owner' }) } : {}),
  });
  return id;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  const db = mockDb.current;
  db.prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 64000, 1)`).run();
  db.prepare("INSERT INTO agents (id, name, model_id, status, config, classification) VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')").run();
  db.prepare(`INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
              VALUES ('conv-dash', 'primary', 'dashboard', NULL, 'owner', datetime('now'))`).run();
  n = 0;
});
afterEach(() => { endTurnContext(AGENT); mockDb.current?.close(); mockDb.current = null; });

describe('large unanswered messages do not raise the turn\'s model', () => {
  it('four large open asks behind the fold: shown within the room, the newest whole, the older ones by pointer', async () => {
    const asks = [0, 1, 2, 3].map((i) => say('user', `ASK-${i} ${'crate manifest line, bay and weight; '.repeat(540)}`, `ask-${i}`));
    expect(claimAsk('ask:ask-0', AGENT).kind).toBe('applied');
    createLeafSummary(AGENT, 'The owner sent four long manifests to check.', 20, asks, '2026-10-01 00:00:00', '2026-10-01 00:00:05');
    for (let i = 0; i < 6; i++) { say('assistant', `checking part ${i}`); say('user', `part ${i} looks fine`); }
    const bag = openTurnContext(AGENT);
    bag.root = { kind: 'ask', id: 'ask-0', sourceMessageId: 'ask-0' };
    expect(servedOwnerMessageIds(AGENT), 'precondition: all four are served').toEqual(expect.arrayContaining(asks));

    const a = await assembleContext(AGENT, 'm');
    expect(a.allocation!.spentTokens, 'the assembly fits its budget').toBeLessThanOrEqual(a.allocation!.budgetTokens);
    const wire = JSON.stringify(a.messages);
    const newest = (mockDb.current!.prepare("SELECT content FROM messages WHERE id = 'ask-3'").get() as { content: string }).content;
    expect(wire, 'the newest is whole').toContain(JSON.stringify(newest).slice(1, -1));
    for (const id of asks) expect(wire, `${id} is still shown`).toContain(id.toUpperCase());
    expect(wire, 'an older one is shown by its kept-row pointer').toContain('msg:ask-0');
  });
});
