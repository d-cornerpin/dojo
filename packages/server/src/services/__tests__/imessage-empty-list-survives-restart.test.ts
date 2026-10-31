// A saved EMPTY approved list (`[]`, what the owner gets after removing the last sender in Settings)
// must survive a bridge restart: nobody is heard, exactly as reloadApprovedSenders already treats it.
// The restart-time fallback to the default recipient exists for a fresh install only - a stored value
// that is missing or not a JSON list at all. imsg/osascript are mocks; chat.db is a tiny fake under
// the test home.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  runMessagesProgram: vi.fn(async () => ''),
}));
vi.mock('../../gateway/ws.js', async (orig) => ({
  ...(await orig<typeof import('../../gateway/ws.js')>()),
  broadcast: vi.fn(),
}));
vi.mock('../../agent/runtime.js', async (orig) => ({
  ...(await orig<typeof import('../../agent/runtime.js')>()),
  getAgentRuntime: () => ({ handleMessage: async () => {} }),
}));

import { runMigrations } from '../../db/migrations.js';
import { getDb } from '../../db/connection.js';
import { homeDir } from '../../home.js';
import { startIMBridge, stopIMBridge } from '../imessage-bridge.js';

const OWNER = '+15550100299';
const chatPath = path.join(homeDir(), 'Library', 'Messages', 'chat.db');
const setRaw = (value: string) =>
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)").run(value);
const clearList = () =>
  getDb().prepare("DELETE FROM config WHERE key = 'imessage_approved_senders'").run();
const stored = (needle: string): boolean =>
  getDb().prepare('SELECT 1 FROM messages WHERE content LIKE ? LIMIT 1').get(`%${needle}%`) !== undefined;
async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}
function addText(rowid: number, chatId: number, text: string): void {
  const chat = new Database(chatPath);
  const now = (Date.now() - 978307200000) * 1e6;
  chat.prepare('INSERT INTO message VALUES (?, ?, 0, ?, 0, 0, 0, ?)').run(rowid, text, now, `guid-el-${rowid}`);
  chat.prepare('INSERT INTO chat_message_join VALUES (?, ?)').run(chatId, rowid);
  chat.close();
}

beforeAll(() => {
  runMigrations();
  const db = getDb();
  db.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('p', 'P', 'anthropic', 'api_key')`).run();
  db.prepare(`INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window, is_enabled)
              VALUES ('m', 'p', 'M', 'm-1', '["tools"]', 200000, 1)`).run();
  db.prepare(`INSERT INTO agents (id, name, model_id, status, config, classification)
              VALUES ('primary', 'Primary', 'm', 'idle', '{}', 'sensei')`).run();
  clearList();
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
  chat.prepare('INSERT INTO chat VALUES (1, ?)').run(OWNER);
  chat.close();
});
afterAll(() => { stopIMBridge(); fs.rmSync(chatPath, { force: true }); });

describe('a saved empty approved list survives a restart', () => {
  it('saved []: after a restart a text from the default recipient is not delivered', async () => {
    setRaw('[]');
    startIMBridge(OWNER);
    await new Promise((r) => setTimeout(r, 300)); // the initial poll runs on the empty list
    addText(101, 1, 'text-when-nobody-was-approved');
    await new Promise((r) => setTimeout(r, 6500)); // longer than one poll interval
    expect(stored('text-when-nobody-was-approved')).toBe(false);
    stopIMBridge();
  }, 15000);

  it('no saved list at all: after a start the default recipient is still heard', async () => {
    clearList();
    startIMBridge(OWNER);
    await new Promise((r) => setTimeout(r, 300)); // the initial poll runs on the fallback recipient
    addText(102, 1, 'text-from-a-fresh-install');
    await until(() => stored('text-from-a-fresh-install'), 8000);
    expect(stored('text-from-a-fresh-install')).toBe(true);
    stopIMBridge();
  }, 15000);

  it('a saved value that is not a JSON list: after a start the default recipient is still heard', async () => {
    setRaw('not json');
    startIMBridge(OWNER);
    await new Promise((r) => setTimeout(r, 300)); // the initial poll runs on the fallback recipient
    addText(103, 1, 'text-from-an-unreadable-list');
    await until(() => stored('text-from-an-unreadable-list'), 8000);
    expect(stored('text-from-an-unreadable-list')).toBe(true);
    stopIMBridge();
  }, 15000);
});
