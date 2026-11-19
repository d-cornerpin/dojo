// A turn whose preflight throws after it picked a request hands that request back as a crash: open again,
// counted once, served again now; the throw still reaches the runtime. A throw before any pick hands nothing back.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/reply-sender.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));
vi.mock('../steps/preflight/inbound-and-abort.js', () => ({
  runInboundAndAbort: () => { throw new Error('the inbound read failed'); },
}));

import { runMigrations } from '../../../db/migrations.js';
import { insertMessage } from '../../../memory/message-store.js';
import { askIdForMessage } from '../../../work/store.js';
import { RE_SERVE_MARKER } from '../../../work/ask-settlement.js';
import { runV2Turn } from '../loop.js';
import { freshReplyDb, testDb, AGENT } from './helpers/reply-sender.js';

const ASK = askIdForMessage('m-1');
const askRow = (): { state: string; due: number | null } =>
  testDb().prepare('SELECT state, next_attempt_at AS due FROM work WHERE id = ?').get(ASK) as { state: string; due: number | null };
const crashCount = (): number => (testDb().prepare(`SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND kind = 'audit'
  AND json_extract(payload, '$.marker') = ? AND json_extract(payload, '$.cause') = 'crash'`).get(ASK, RE_SERVE_MARKER) as { n: number }).n;

beforeEach(() => {
  freshReplyDb(runMigrations);
  testDb().prepare("INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')").run();
  testDb().prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
    VALUES ('model-a', 'p', 'Model A', 'model-a-1', '["tools"]', 200000, 1)`).run();
  testDb().prepare("UPDATE agents SET model_id = 'model-a' WHERE id = ?").run(AGENT);
  testDb().prepare("INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id) VALUES ('conv-owner', ?, 'dashboard', 'dashboard', 'owner')").run(AGENT);
  insertMessage({ id: 'm-1', agentId: AGENT, role: 'user', content: 'Compare the three quotes and tell me which to take',
    conversationId: 'conv-owner', channel: 'dashboard', senderId: 'owner', lane: 'owner' } as never);
});

describe('a preflight that throws hands its ask back', () => {
  it('the request it picked is open again, counted once as a crash, and due now', async () => {
    await expect(runV2Turn(AGENT)).rejects.toThrow('the inbound read failed');
    const row = askRow();
    expect(row.state).toBe('open');
    expect(crashCount()).toBe(1);
    expect(row.due).not.toBeNull();
    expect(row.due!).toBeLessThanOrEqual(Date.now());
  });

  it('a throw before any request was picked hands nothing back', async () => {
    testDb().prepare('UPDATE agents SET model_id = NULL WHERE id = ?').run(AGENT);
    await expect(runV2Turn(AGENT)).rejects.toThrow(/no model configured/);
    expect(askRow()).toEqual({ state: 'open', due: null });
    expect(crashCount()).toBe(0);
  });
});
