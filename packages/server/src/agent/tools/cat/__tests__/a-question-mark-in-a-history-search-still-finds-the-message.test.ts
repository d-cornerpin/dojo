// A history search typed the way people talk ("what did Bob say about the roof?") finds the message, the row
// holding more of its words first: ordinary punctuation never breaks the full-text search, and OR still means OR.
// Driven through executeTool on a migrated scratch database.

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
  const row = db.prepare("INSERT INTO messages (id, agent_id, role, lane, content) VALUES (?, ?, 'user', 'owner', ?)");
  row.run('m-lunch', AGENT, 'What about lunch on Friday?');
  // Small words are common in a real history, so the ranking weighs them low.
  for (let i = 0; i < 6; i += 1) row.run(`m-chat-${i}`, AGENT, `What do you think about the plan for week ${i}?`);
  row.run('m-roof', AGENT, "Bob's roof needs new shingles");
  row.run('m-car', AGENT, 'The car is booked in for a service.');
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const search = async (pattern: string): Promise<string> => toolResultOf(await executeTool(AGENT, {
  id: `call-${pattern.length}`, name: 'history_search', arguments: { pattern, scope: 'messages' },
})).content;

describe('a question mark in a history search', () => {
  it('the spoken question finds the message, ahead of one that shares only its small words', async () => {
    const out = await search('what did Bob say about the roof?');
    expect(out).toContain('shingles');
    expect(out).toContain('lunch');
    expect(out.indexOf('shingles')).toBeLessThan(out.indexOf('lunch'));
  });

  it.each(["Bob's roof?", 'roof?'])('still finds the message for %j', async (pattern) => {
    expect(await search(pattern)).toContain('shingles');
  });

  it('roof OR car finds both', async () => {
    const out = await search('roof OR car');
    expect(out).toContain('shingles');
    expect(out).toContain('service');
  });
});
