// HTML, SVG and Office previews served for display carry a CSP sandbox without allow-same-origin, so a page's
// script runs in an opaque origin and cannot use the dashboard's storage or call its API as the owner.

import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { homeDir } from '../../home.js';
import { OUT_DIR } from '../../services/public-share.js';

const db = new Database(':memory:');
db.exec('CREATE TABLE shared_files (id TEXT PRIMARY KEY, agent_id TEXT, file_path TEXT, filename TEXT, mime_type TEXT, size INTEGER)');
vi.mock('../../db/connection.js', () => ({ getDb: () => db }));

const { uploadRouter } = await import('../routes/upload.js');
const { createServer } = await import('../server.js');

const sandboxed = (res: Response) => {
  const csp = res.headers.get('content-security-policy') ?? '';
  expect(csp).toMatch(/^sandbox\b/);
  expect(csp).not.toContain('allow-same-origin');
};

beforeAll(() => {
  const dir = path.join(homeDir(), 'files');
  fs.mkdirSync(dir, { recursive: true });
  const add = (id: string, name: string, body: string, mime: string) => {
    fs.writeFileSync(path.join(dir, name), body);
    db.prepare('INSERT INTO shared_files VALUES (?, ?, ?, ?, ?, ?)').run(id, 'a', path.join(dir, name), name, mime, 1);
  };
  add('h', 'page.html', '<script>1</script>', 'text/html');
  add('s', 'pic.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>', 'image/svg+xml');
  add('c', 'sheet.csv', 'a,b\n1,2', 'text/csv');
  fs.mkdirSync(path.join(OUT_DIR, 'demo-csp'), { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'demo-csp', 'index.html'), '<script>1</script>');
});

describe('display responses are sandboxed', () => {
  it('the inline HTML and SVG downloads', async () => {
    sandboxed(await uploadRouter.request('/download/h?inline=1'));
    sandboxed(await uploadRouter.request('/download/s?inline=1'));
  });

  it('the Office render route', async () => {
    const res = await uploadRouter.request('/render/c');
    expect(res.status).toBe(200);
    sandboxed(res);
  });

  it('a shared page', async () => {
    sandboxed(await createServer().app.request('/share/demo-csp/index.html'));
  });
});
