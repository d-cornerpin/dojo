// The main agent's vault_discard_archives call is warned once (it permanently deletes saved conversation
// archives); the identical repeat in the same turn deletes them. Runs in a scratch home.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'discard-archives-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../../../db/connection.js');
const migrations = await import('../../../../../db/migrations.js');
const platform = await import('../../../../../config/platform.js');
const { executeTool } = await import('../../../../tools/index.js');
const { runRefusalGates } = await import('../refusal-gates.js');
const { initState } = await import('../../../state.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, 'main', 'idle', '{}', 'sensei')").run(MAIN);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
  db.prepare(`INSERT INTO vault_conversations (id, agent_id, messages, message_count, token_count, earliest_at, latest_at)
              VALUES ('archive-1', ?, '[]', 0, 0, datetime('now'), datetime('now'))`).run(MAIN);
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const call = { id: 'c1', name: 'vault_discard_archives', arguments: { archive_ids: ['archive-1'], reason: 'test chatter' } };
const gate = (seen: Set<string>) =>
  runRefusalGates(initState({ agentId: MAIN, turnNumber: 1, lastUserMessageContent: null } as never) as never,
    call as never, { agentId: MAIN, turnNumber: 1, turnCtx: {}, counterparty: null, refusedOnceSigs: seen } as never, false).refusal;
const archives = () => (connection.getDb().prepare('SELECT COUNT(*) AS n FROM vault_conversations WHERE is_processed = 0').get() as { n: number }).n;

describe('the main agent is warned once before discarding vault archives', () => {
  it('the first try is a warning; the identical repeat in the same turn deletes the archive', async () => {
    const seen = new Set<string>();
    expect(gate(seen)?.content).toMatch(/^\[Engine warning, nothing ran\] This call would permanently delete saved conversation archives/);
    expect(archives()).toBe(1);
    expect(gate(seen)).toBeNull();
    await executeTool(MAIN, call);
    expect(archives()).toBe(0);
  });
});
