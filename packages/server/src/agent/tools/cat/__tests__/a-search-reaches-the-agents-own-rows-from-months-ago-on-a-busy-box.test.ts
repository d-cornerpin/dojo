// On a busy box other agents write most of the rows, so an agent's message from months ago sits far below the
// newest rows of the whole box. History search counts its window in the agent's own rows and still finds it.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const AGENT = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'history-busy-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../../db/connection.js');
const migrations = await import('../../../../db/migrations.js');
const { executeTool, toolResultOf } = await import('../../index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  for (const id of [AGENT, 'agent-busy']) {
    db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, ?, 'idle', '{}', 'sensei')").run(id, id);
  }
  const row = db.prepare("INSERT INTO messages (seq, id, agent_id, role, lane, content) VALUES (?, ?, ?, 'user', 'owner', ?)");
  db.transaction(() => {
    row.run(1, 'm-old', AGENT, 'The plumber quoted nine hundred for the boiler.');
    // Another agent's work fills the box between the two: its rows, not this agent's, take the numbers.
    for (const seq of [2, 30_000, 60_001]) row.run(seq, `m-busy-${seq}`, 'agent-busy', `routine status line ${seq}`);
    row.run(60_002, 'm-new', AGENT, 'Thanks, that is all for today.');
  })();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a search on a busy box', () => {
  it("reaches the agent's own row from months ago", async () => {
    const outcome = await executeTool(AGENT, { id: 'call-boiler', name: 'history_search', arguments: { pattern: 'boiler', scope: 'messages' } });
    expect(toolResultOf(outcome).content).toContain('nine hundred');
  });
});
