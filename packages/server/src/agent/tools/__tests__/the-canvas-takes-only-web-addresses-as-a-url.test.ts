// canvas_render's `url` takes a web address (http or https) or a dashboard path. A file:// address is
// refused with a pointer to `path`, which runs the file checks every other file tool runs.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'canvas-url-'));
vi.stubEnv('DOJO_HOME', home);

const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf } = await import('../index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, 'main', 'idle', '{}', 'sensei', NULL)").run(MAIN);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const render = async (url: string) => toolResultOf(await executeTool(MAIN, { id: `call-${url}`, name: 'canvas_render', arguments: { url } }));

describe('canvas_render url', () => {
  it('refuses a file:// address and points at path', async () => {
    const r = await render('file:///etc/hosts');
    expect(r.isError).toBe(true);
    expect(r.content).toContain('pass it as `path`');
  });

  it('opens a web address', async () => {
    const r = await render('https://example.com/page');
    expect(r.isError).toBe(false);
    expect(r.content).toContain('Canvas opened');
  });

  it('opens a dashboard path', async () => {
    const r = await render('/api/upload/download/0b6c3f7e-1111-4222-8333-944455556666');
    expect(r.isError).toBe(false);
    expect(r.content).toContain('Canvas opened');
  });
});
