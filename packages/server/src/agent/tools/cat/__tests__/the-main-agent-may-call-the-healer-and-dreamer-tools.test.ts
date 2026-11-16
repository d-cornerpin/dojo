// The Healer's and the Dreamer's own tools answer the main agent too; a helper is still refused.
// Driven through the tool executor with the real grants and a scratch DOJO_HOME.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'role-tools-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../../db/connection.js');
const migrations = await import('../../../../db/migrations.js');
const platform = await import('../../../../config/platform.js');
const { executeTool, toolResultOf } = await import('../../index.js');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification) VALUES (?, ?, 'idle', '{}', ?)");
  add.run(MAIN, 'main', 'sensei');
  add.run(HELPER, 'helper', 'apprentice');
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});

const CALLS: Array<{ name: string; args: Record<string, unknown>; answer: string; refusal: string }> = [
  { name: 'healer_recent_actions', args: {}, answer: 'No Healer actions in the last 24h.', refusal: 'only available to the Healer and the main agent.' },
  { name: 'healer_action_detail', args: { action_id: 'abc' }, answer: 'No Healer action found', refusal: 'only available to the Healer and the main agent.' },
  { name: 'healer_mark_applied', args: { proposal_id: 'abc' }, answer: 'No proposal found', refusal: 'only available to the Healer and the main agent.' },
  { name: 'vault_discard_archives', args: { archive_ids: ['nope'], reason: 'junk' }, answer: 'Discarded 0 archives', refusal: 'is for the Dreamer and the main agent only.' },
  {
    name: 'lesson_record',
    args: { task_id: 'no-such-task', cue: 'c', lesson: 'l', evidence_event_ids: [1], confidence: 0.5 },
    answer: 'no task no-such-task',
    refusal: 'is for the Dreamer and the main agent only.',
  },
];

const call = async (agentId: string, name: string, args: Record<string, unknown>) =>
  toolResultOf(await executeTool(agentId, { id: `call-${name}`, name, arguments: args })).content;

describe('the main agent may call the Healer and Dreamer tools', () => {
  it.each(CALLS)('the main agent gets $name\'s answer', async ({ name, args, answer, refusal }) => {
    const content = await call(MAIN, name, args);
    expect(content).toContain(answer);
    expect(content).not.toContain(refusal);
    expect(content).not.toMatch(/-only\.|only available to the Healer agent/);
  });

  it.each(CALLS)('a helper is still refused $name', async ({ name, args, refusal }) => {
    expect(await call(HELPER, name, args)).toContain(refusal);
  });
});
