// 707 — two pictures of one text that share a file name (many senders call every picture
// `image.jpg`) must both survive: neither copy may overwrite the other.
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

vi.mock('../imessage-run.js', async (orig) => ({
  ...(await orig<typeof import('../imessage-run.js')>()),
  getImsgPath: () => null,
  convertHeicToJpeg: vi.fn(),
}));

import { homeDir } from '../../home.js';
import { fetchImessageAttachments } from '../imessage-bridge.js';

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'imsg-att-'));
let chatDb: Database.Database;

beforeAll(() => {
  // The uploads land under the test home, never the real one.
  expect(homeDir().startsWith(os.tmpdir()) || homeDir().includes('test'), 'uploads go to a test home').toBe(true);
  fs.writeFileSync(path.join(SCRATCH, 'a.jpg'), 'AAA');
  fs.writeFileSync(path.join(SCRATCH, 'b.jpg'), 'BBB');
  chatDb = new Database(':memory:');
  chatDb.exec(`CREATE TABLE attachment(ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, transfer_name TEXT);
    CREATE TABLE message_attachment_join(message_id INTEGER, attachment_id INTEGER);`);
  const ins = chatDb.prepare('INSERT INTO attachment(ROWID, filename, mime_type, transfer_name) VALUES (?, ?, ?, ?)');
  ins.run(1, path.join(SCRATCH, 'a.jpg'), 'image/jpeg', 'image.jpg');
  ins.run(2, path.join(SCRATCH, 'b.jpg'), 'image/jpeg', 'image.jpg');
  chatDb.prepare('INSERT INTO message_attachment_join VALUES (1, 1), (1, 2)').run();
});
afterAll(() => { chatDb.close(); fs.rmSync(SCRATCH, { recursive: true, force: true }); });

describe('707 same-named attachments both survive', () => {
  it('two entries, two paths, each with its own bytes, both still named image.jpg', () => {
    const { uploadedFiles } = fetchImessageAttachments(chatDb, 1, 'agent-x');
    expect(uploadedFiles).toHaveLength(2);
    expect(uploadedFiles[0].path).not.toBe(uploadedFiles[1].path);
    expect(fs.readFileSync(uploadedFiles[0].path, 'utf8')).toBe('AAA');
    expect(fs.readFileSync(uploadedFiles[1].path, 'utf8')).toBe('BBB');
    expect(uploadedFiles.map((f) => f.filename)).toEqual(['image.jpg', 'image.jpg']);
    for (const f of uploadedFiles) fs.rmSync(f.path, { force: true });
  });
});
