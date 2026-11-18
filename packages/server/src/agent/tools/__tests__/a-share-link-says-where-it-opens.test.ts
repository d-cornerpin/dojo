// share_file's link opens from any device only while the Cloudflare tunnel runs. Without the tunnel the
// result says the link works only on this Mac, so the agent never texts a link that will not open.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'share-reach-'));
vi.stubEnv('DOJO_HOME', home);

const connection = await import('../../../db/connection.js');
const migrations = await import('../../../db/migrations.js');
const platform = await import('../../../config/platform.js');
const { executeTool, toolResultOf } = await import('../index.js');

const file = path.join(home, 'reports', 'summary.txt');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions) VALUES (?, 'main', 'idle', '{}', 'sensei', NULL)").run(MAIN);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'the summary');
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a share link says where it opens', () => {
  it('without the tunnel, share_file says the link works only on this Mac', async () => {
    const r = toolResultOf(await executeTool(MAIN, { id: 'call-share', name: 'share_file', arguments: { path: file } }));
    expect(r.isError).toBe(false);
    expect(r.content).toContain('http://localhost:');
    expect(r.content).toContain('only works on this Mac');
  });
});
