// The PM keeps the conversation it is having with the owner: after many reviews his earlier messages are
// still in the view it is handed, and none of its rows is deleted. (Owner incident: the PM once answered
// "Hey, I'm here. What's up?" to a conversation the engine had erased.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import { assembleContext } from '../../memory/assembler.js';
import { insertMessage } from '../../memory/message-store.js';
import { runMigrations } from '../../db/migrations.js';

const PM = 'pm';                 // config/platform.ts: `pm_agent_id` defaults to 'pm'
const MODEL = 'pm-chat-model';
const REPORT_WORDS = 20;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')").run();
  mockDb.current.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'pmchat', 'PM Chat', 128000, 4096, '["tools"]')`,
  ).run(MODEL);
  mockDb.current.prepare("INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'PM', 'idle', ?, '{}')").run(PM, MODEL);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const owner = (role: 'user' | 'assistant', content: string): void => {
  insertMessage({ agentId: PM, role, content, conversationId: 'conv-owner-pm', senderId: role === 'user' ? 'owner' : null, authorized: true });
};

const text = (messages: Array<{ content: unknown }>): string =>
  messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

describe('the PM keeps the conversation it is having', () => {
  it("the owner's earlier messages are in view after many reviews, and nothing is deleted", async () => {
    owner('user', 'why does the email project keep getting reassigned?');
    owner('assistant', 'Let me look into the assignment history.');
    owner('user', 'that did not answer my question');
    owner('assistant', 'You are right, I am checking the task log now.');
    for (let i = 0; i < 80; i += 1) {
      insertMessage({ agentId: PM, role: 'user', lane: 'events', originIntent: 'pm_review', content: `Tracker review ${i}: ${'the filing task waits on a decision. '.repeat(REPORT_WORDS)}` });
      insertMessage({ agentId: PM, role: 'assistant', lane: 'events', content: `Reviewed ${i}.`, subjectKind: 'engine_event' });
    }
    owner('user', 'Hello?');

    const view = text((await assembleContext(PM, MODEL)).messages);
    expect(view, 'the first question is gone: the amnesia the owner saw').toContain('why does the email project keep getting reassigned?');
    expect(view).toContain('that did not answer my question');
    expect(view).toContain('Hello?');
    expect((mockDb.current!.prepare('SELECT COUNT(*) AS c FROM messages WHERE agent_id = ?').get(PM) as { c: number }).c).toBe(165);
  });
});
