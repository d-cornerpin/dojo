// A history search typed the way people talk ("Bob's roof?") finds the message: ordinary punctuation never
// breaks the full-text search. Driven through executeTool on a migrated scratch database.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const AGENT = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'history-punct-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../../db/connection.js');
const migrations = await import('../../../../db/migrations.js');
const { executeTool, toolResultOf } = await import('../../index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, 'main', 'idle', '{}', 'sensei')").run(AGENT);
  db.prepare("INSERT INTO messages (id, agent_id, role, lane, content) VALUES ('m-roof', ?, 'user', 'owner', ?)")
    .run(AGENT, "Bob's roof needs new shingles before winter.");
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a question mark in a history search', () => {
  it.each(["Bob's roof?", 'roof?'])(
    'still finds the message for %j', async (pattern) => {
      const outcome = await executeTool(AGENT, { id: `call-${pattern.length}`, name: 'history_search', arguments: { pattern, scope: 'messages' } });
      expect(toolResultOf(outcome).content).toContain('shingles');
    });
});
