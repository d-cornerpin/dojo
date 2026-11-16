// canvas_read of a file the secret-file rule denies returns a plain refusal, never the file's text, for any agent,
// and the dashboard canvas is not handed that text either.

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { homeDir } from '../../home.js';

const db = new Database(':memory:');
db.exec('CREATE TABLE shared_files (id TEXT PRIMARY KEY, agent_id TEXT, file_path TEXT, filename TEXT, mime_type TEXT, size INTEGER)');
vi.mock('../../db/connection.js', () => ({ getDb: () => db }));
vi.mock('../effects/fs.js', async () => ({ ...(await import('node:fs')) }));

const { viewCanvas } = await import('../canvas-view.js');
const { uploadRouter } = await import('../../gateway/routes/upload.js');

describe('canvas_read and secret files', () => {
  it('refuses the keys file, and a link to it, without returning their text', async () => {
    const dojo = path.join(homeDir(), '.dojo');
    fs.mkdirSync(dojo, { recursive: true });
    fs.writeFileSync(path.join(dojo, 'secrets.yaml'), 'providers: KEY-VALUE');
    fs.symlinkSync(path.join(dojo, 'secrets.yaml'), path.join(homeDir(), 'notes.yaml'));
    for (const p of ['~/.dojo/secrets.yaml', path.join(homeDir(), 'notes.yaml')]) {
      const out = await viewCanvas('main', { path: p });
      expect(out).not.toContain('KEY-VALUE');
      expect(out).toMatch(/secret/i);
    }
  });

  it('still returns the text of an ordinary file', async () => {
    fs.writeFileSync(path.join(homeDir(), 'plan.yaml'), 'step: one');
    expect(await viewCanvas('main', { path: path.join(homeDir(), 'plan.yaml') })).toContain('step: one');
  });

  it('the dashboard canvas gets no text for the keys file', async () => {
    const keys = path.join(homeDir(), '.dojo', 'secrets.yaml');
    db.prepare('INSERT INTO shared_files VALUES (?, ?, ?, ?, ?, ?)').run('k', 'a', keys, 'secrets.yaml', 'text/yaml', 1);
    const body = await (await uploadRouter.request('/describe/k')).text();
    expect(body).not.toContain('KEY-VALUE');
  });
});
