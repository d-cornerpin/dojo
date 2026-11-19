// A download link can never serve the Dojo's keys file or an SSH private key, even when a row for it
// exists in the shared-files list. Any other registered file still downloads.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { homeDir } from '../../home.js';

const db = new Database(':memory:');
db.exec('CREATE TABLE shared_files (id TEXT PRIMARY KEY, agent_id TEXT, file_path TEXT, filename TEXT, mime_type TEXT, size INTEGER)');
vi.mock('../../db/connection.js', () => ({ getDb: () => db }));

const { uploadRouter } = await import('../routes/upload.js');

const FAKE_KEY = 'zq9FakeDownloadKey000000000042';

beforeAll(() => {
  const keys = path.join(homeDir(), '.dojo', 'secrets.yaml');
  fs.mkdirSync(path.dirname(keys), { recursive: true });
  fs.writeFileSync(keys, `jwt_secret: ${FAKE_KEY}\n`);
  const sshKey = path.join(homeDir(), '.ssh', 'id_ed25519');
  fs.mkdirSync(path.dirname(sshKey), { recursive: true });
  fs.writeFileSync(sshKey, `-----BEGIN OPENSSH PRIVATE KEY-----\n${FAKE_KEY}\n-----END OPENSSH PRIVATE KEY-----\n`);
  const notes = path.join(homeDir(), 'files', 'notes.txt');
  fs.mkdirSync(path.dirname(notes), { recursive: true });
  fs.writeFileSync(notes, 'plain notes');
  const add = db.prepare('INSERT INTO shared_files VALUES (?, ?, ?, ?, ?, ?)');
  add.run('keys', 'a', keys, 'secrets.yaml', 'application/octet-stream', 1);
  add.run('ssh', 'a', sshKey, 'id_ed25519', 'application/octet-stream', 1);
  add.run('notes', 'a', notes, 'notes.txt', 'text/plain', 1);
});

describe('the download route', () => {
  it('refuses the keys file', async () => {
    const res = await uploadRouter.request('/download/keys');
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(FAKE_KEY);
  });

  it('refuses an SSH private key', async () => {
    const res = await uploadRouter.request('/download/ssh');
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(FAKE_KEY);
  });

  it('still serves an ordinary file', async () => {
    const res = await uploadRouter.request('/download/notes');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('plain notes');
  });
});
