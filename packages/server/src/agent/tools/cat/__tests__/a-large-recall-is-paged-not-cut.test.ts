// Recall has no per-turn cap: a second large recall in the same turn returns its result, kept whole behind the
// engine's one pointer for a long result, the same as any other long tool result.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const AGENT = 'agent-main';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'recall-paged-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../../db/connection.js');
const migrations = await import('../../../../db/migrations.js');
const { openTurnContext, endTurnContext } = await import('../../../turn-context.js');
const { executeTool, toolResultOf } = await import('../../index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, 'main', 'idle', '{}', 'sensei')").run(AGENT);
  const row = db.prepare("INSERT INTO messages (id, agent_id, role, lane, content) VALUES (?, ?, ?, 'owner', ?)");
  for (let i = 0; i < 30; i += 1) {
    row.run(`u-${i}`, AGENT, 'user', `Question ${i} about the garden plan. ${'detail '.repeat(300)}`);
    row.run(`a-${i}`, AGENT, 'assistant', `Answer ${i} on the garden plan. ${'reply '.repeat(300)}`);
  }
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a large recall', () => {
  it('is paged, not cut, however much the turn has already recalled', async () => {
    openTurnContext(AGENT);
    try {
      const args = { turn_count: 30, truncate_message_chars: 8000, scope: 'all' };
      const first = toolResultOf(await executeTool(AGENT, { id: 'call-1', name: 'recall_recent_thread', arguments: args }));
      const second = toolResultOf(await executeTool(AGENT, { id: 'call-2', name: 'recall_recent_thread', arguments: args }));
      for (const r of [first, second]) {
        expect(r.content).toContain('tool_result_read');
        expect(r.keptWhole).toContain('Question 0 about the garden plan');
        expect(r.keptWhole).toContain('Answer 29 on the garden plan');
      }
    } finally {
      endTurnContext(AGENT);
    }
  });
});
