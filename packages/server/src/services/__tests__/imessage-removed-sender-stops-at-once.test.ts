// A sender taken off the approved iMessage list stops reaching the agent at the next poll, with no
// restart, including when the owner removes the LAST sender. imsg/osascript are mocks; chat.db is a
// tiny fake under the test home.
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
import { startIMBridge, stopIMBridge, reloadApprovedSenders } from '../imessage-bridge.js';

const A = '+15550100201';
const B = '+15550100202';
const chatPath = path.join(homeDir(), 'Library', 'Messages', 'chat.db');
const rec = (address: string, primary: boolean) => ({ address, name: address, is_primary: primary, sharing_level: 'full' });
const setList = (list: unknown[]) =>
  getDb().prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('imessage_approved_senders', ?)").run(JSON.stringify(list));
const stored = (needle: string): boolean =>
  getDb().prepare('SELECT 1 FROM messages WHERE content LIKE ? LIMIT 1').get(`%${needle}%`) !== undefined;
async function until(cond: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
}
function addText(rowid: number, chatId: number, text: string): void {
  const chat = new Database(chatPath);
  const now = (Date.now() - 978307200000) * 1e6;
  chat.prepare('INSERT INTO message VALUES (?, ?, 0, ?, 0, 0, 0, ?)').run(rowid, text, now, `guid-rm-${rowid}`);
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
  setList([rec(A, true), rec(B, false)]);
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
  chat.prepare('INSERT INTO chat VALUES (1, ?), (2, ?)').run(A, B);
  chat.close();
});
afterAll(() => { stopIMBridge(); fs.rmSync(chatPath, { force: true }); });

describe('a sender removed from the approved list stops reaching the agent', () => {
  it('removing one of two senders: only the remaining sender is heard', async () => {
    startIMBridge(A);
    await new Promise((r) => setTimeout(r, 300)); // the initial poll runs on the two-sender list
    setList([rec(B, true)]);
    reloadApprovedSenders();
    addText(101, 1, 'text-from-removed-sender');
    addText(102, 2, 'text-from-kept-sender');
    await until(() => stored('text-from-kept-sender'), 8000);
    expect(stored('text-from-kept-sender')).toBe(true);
    expect(stored('text-from-removed-sender')).toBe(false);
  }, 15000);

  it('removing the last sender: the next text from them is not delivered', async () => {
    setList([]);
    reloadApprovedSenders();
    addText(103, 2, 'text-after-last-sender-removed');
    await new Promise((r) => setTimeout(r, 6500)); // longer than one poll interval
    expect(stored('text-after-last-sender-removed')).toBe(false);
  }, 15000);

  it('texts sent while a person was not approved are never delivered later, when someone is approved again', async () => {
    await new Promise((r) => setTimeout(r, 5500)); // the poll after the empty list has passed over the waiting text
    setList([rec(A, true), rec(B, false)]);
    reloadApprovedSenders();
    addText(104, 1, 'text-after-approved-again');
    await until(() => stored('text-after-approved-again'), 8000);
    expect(stored('text-after-approved-again')).toBe(true);
    expect(stored('text-from-removed-sender')).toBe(false);
    expect(stored('text-after-last-sender-removed')).toBe(false);
  }, 20000);
});
