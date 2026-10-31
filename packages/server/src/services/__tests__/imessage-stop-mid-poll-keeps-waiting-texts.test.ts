// 708 — switching iMessage off while a poll is between two texts of one batch must not
// throw the second text away. After the stop the poll does nothing further and the cursor
// stays put, so the next start picks the text up. imsg/osascript are mocks; chat.db is a
// tiny fake under the test home.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const hooks = vi.hoisted(() => ({ onBroadcast: null as null | (() => void), count: 0 }));

vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: vi.fn(async () => ''),
}));
vi.mock('../../gateway/ws.js', async (orig) => ({
  ...(await orig<typeof import('../../gateway/ws.js')>()),
  broadcast: vi.fn(() => { hooks.count++; if (hooks.count === 1) hooks.onBroadcast?.(); }),
}));
vi.mock('../../agent/runtime.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/runtime.js')>()),
  getAgentRuntime: () => ({ handleMessage: async () => {} }),
}));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { homeDir } from '../../home.js';
import { startIMBridge, stopIMBridge, isIMBridgeRunning } from '../imessage-bridge.js';

const SENDER = '+15550100198';
const chatPath = path.join(homeDir(), 'Library', 'Messages', 'chat.db');
const cursor = (): string | undefined =>
  (getDb().prepare("SELECT value FROM config WHERE key = 'imessage_last_rowid'").get() as { value: string } | undefined)?.value;
const stored = (needle: string): boolean =>
  getDb().prepare("SELECT 1 FROM messages WHERE content LIKE ? LIMIT 1").get(`%${needle}%`) !== undefined;
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
}

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)")
    .run(JSON.stringify([{ address: SENDER, name: 'Owner', is_primary: true, sharing_level: 'full' }]));
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_last_rowid', '100')").run();
  fs.mkdirSync(path.dirname(chatPath), { recursive: true });
  const chat = new Database(chatPath);
  chat.exec(`
    CREATE TABLE message(ROWID INTEGER PRIMARY KEY, text TEXT, is_from_me INTEGER, date INTEGER, cache_has_attachments INTEGER, associated_message_type INTEGER, item_type INTEGER, guid TEXT);
    CREATE TABLE chat(ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);
    CREATE TABLE chat_message_join(chat_id INTEGER, message_id INTEGER);
    CREATE TABLE message_attachment_join(message_id INTEGER, attachment_id INTEGER);
    CREATE TABLE attachment(ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT, total_bytes INTEGER);
  `);
  const now = (Date.now() - 978307200000) * 1e6;
  chat.prepare('INSERT INTO chat VALUES (1, ?)').run(SENDER);
  const ins = chat.prepare('INSERT INTO message VALUES (?, ?, 0, ?, 0, 0, 0, ?)');
  ins.run(101, 'one-mid-poll', now, 'guid-708-a');
  ins.run(102, 'two-mid-poll', now, 'guid-708-b');
  chat.prepare('INSERT INTO chat_message_join VALUES (1, 101), (1, 102)').run();
  chat.close();
});
afterAll(() => { stopIMBridge(); fs.rmSync(chatPath, { force: true }); });

describe('708 stopping the bridge mid-poll keeps the waiting texts', () => {
  it('the stop lands between two texts: the second is neither stored nor skipped past', async () => {
    hooks.onBroadcast = () => stopIMBridge();
    startIMBridge(SENDER);
    await until(() => hooks.count >= 1 && !isIMBridgeRunning());
    await new Promise((r) => setTimeout(r, 200)); // let the rest of the poll run out
    expect(isIMBridgeRunning()).toBe(false);
    expect(cursor()).toBe('101');
    expect(stored('one-mid-poll')).toBe(true);
    expect(stored('two-mid-poll')).toBe(false);
  });
  it('starting again picks the waiting text up', async () => {
    hooks.onBroadcast = null;
    startIMBridge(SENDER);
    await until(() => cursor() === '102');
    stopIMBridge();
    expect(cursor()).toBe('102');
    expect(stored('two-mid-poll')).toBe(true);
  });
});
