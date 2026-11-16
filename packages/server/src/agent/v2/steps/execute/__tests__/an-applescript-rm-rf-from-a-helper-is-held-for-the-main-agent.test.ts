// A helper's AppleScript whose shell line deletes recursively waits for the main agent's approval, as
// the same line at the shell door does. Driven through the turn loop's dispatch step; nothing runs.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../approval-decision.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), deliverGateWake: async () => true }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'applescript-hold-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../../../db/connection.js');
const migrations = await import('../../../../../db/migrations.js');
const platform = await import('../../../../../config/platform.js');
const { recordDispatchAndHold } = await import('../dispatch-bookkeeping.js');
const { initState } = await import('../../../state.js');


beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const wide = JSON.stringify({ file_read: '*', file_write: '*', exec_allow: ['*'], exec_deny: [], shell_allow: ['*'], shell_deny: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: ['applescript'] });
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 1, 'agent-main')");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HELPER, 'helper', 'apprentice', wide);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
});

const dispatch = async (agentId: string, name: string, args: Record<string, unknown>) => {
  const state = initState({
    agentId, contextWindow: 200_000, isAutoRouted: false, configuredModelId: 'test',
    turnNumber: 1, triggeredByIMessage: false, triggeredByA2AReplyIntent: null,
    lastUserMessageContent: null, lastUserMessageId: null, inboundChannel: null,
    inboundContext: null, pendingTechniqueAck: null,
  });
  const out = await recordDispatchAndHold(state, { id: `tc-${name}`, name, arguments: args } as never, { agentId, db: connection.getDb() } as never);
  return out.refusal;
};

describe("an AppleScript rm -rf from a helper is held for the main agent", () => {
  it('is held', async () => {
    const refusal = await dispatch(HELPER, 'applescript_run', { script: `do shell script "rm -rf ${path.join(home, 'old-build')}"` });
    expect(refusal?.content).toContain('[HELD by engine');
  });

  it('an AppleScript with no deleting shell line is not held', async () => {
    expect(await dispatch(HELPER, 'applescript_run', { script: 'do shell script "ls -l /tmp"' })).toBeNull();
  });
});
