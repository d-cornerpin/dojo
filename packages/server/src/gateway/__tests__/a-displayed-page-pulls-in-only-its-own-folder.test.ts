// A page served for the canvas (`/download/:id?inline=1`) has its local assets inlined, but only files in its
// own folder, and never a secret file even there.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { homeDir } from '../../home.js';

const db = new Database(':memory:');
db.exec('CREATE TABLE shared_files (id TEXT PRIMARY KEY, agent_id TEXT, file_path TEXT, filename TEXT, mime_type TEXT, size INTEGER)');
vi.mock('../../db/connection.js', () => ({ getDb: () => db }));

const { uploadRouter } = await import('../routes/upload.js');

const b64 = (s: string) => Buffer.from(s).toString('base64');
let page: string;

beforeAll(() => {
  const dojo = path.join(homeDir(), '.dojo');
  fs.mkdirSync(dojo, { recursive: true });
  fs.writeFileSync(path.join(dojo, 'secrets.yaml'), 'KEY-IN-SECRETS');
  const outside = path.join(homeDir(), 'outside.png');
  fs.writeFileSync(outside, 'OUTSIDE');
  const dir = path.join(homeDir(), 'site');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pic.png'), 'OWN-PIC');
  fs.writeFileSync(path.join(dir, '.env'), 'KEY-IN-ENV');
  fs.symlinkSync(outside, path.join(dir, 'linked.png'));
  fs.writeFileSync(path.join(dir, 'page.html'), [
    '<img src="~/.dojo/secrets.yaml">',
    `<img src="${outside}">`,
    '<img src="../outside.png">',
    `<img src="file://${outside}">`,
    '<img src="linked.png">',
    '<img src=".env">',
    '<img src="pic.png">',
  ].join('\n'));
  db.prepare('INSERT INTO shared_files VALUES (?, ?, ?, ?, ?, ?)').run('p1', 'a', path.join(dir, 'page.html'), 'page.html', 'text/html', 1);
});

describe('the canvas page inliner', () => {
  it('inlines nothing from outside the page folder and no secret file', async () => {
    page = await (await uploadRouter.request('/download/p1?inline=1')).text();
    for (const s of ['KEY-IN-SECRETS', 'OUTSIDE', 'KEY-IN-ENV']) expect(page).not.toContain(b64(s));
    expect(page).toContain('<img src="~/.dojo/secrets.yaml">');
    expect(page).toContain('<img src="../outside.png">');
  });

  it('still inlines an image in the page folder', () => {
    expect(page).toContain(`<img src="data:image/png;base64,${b64('OWN-PIC')}">`);
  });
});
