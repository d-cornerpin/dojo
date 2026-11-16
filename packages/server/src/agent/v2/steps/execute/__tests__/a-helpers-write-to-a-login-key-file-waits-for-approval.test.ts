// A helper's write onto a login-key file (~/.ssh/authorized_keys) waits for the main agent's approval,
// through a file tool or a shell `tee` or redirect; the main agent's own write is not held. Driven
// through the turn loop's dispatch step, where the hold lives.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../../../approval-decision.js', async (orig) => ({ ...(await orig<Record<string, unknown>>()), deliverGateWake: async () => true }));

const MAIN = 'agent-main';
const HELPER = 'agent-helper';
const home = fs.mkdtempSync(path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'login-key-hold-'));
vi.stubEnv('DOJO_HOME', home);
const connection = await import('../../../../../db/connection.js');
const migrations = await import('../../../../../db/migrations.js');
const platform = await import('../../../../../config/platform.js');
const { recordDispatchAndHold } = await import('../dispatch-bookkeeping.js');
const { initState } = await import('../../../state.js');

const keys = path.join(home, '.ssh', 'authorized_keys');

beforeAll(() => {
  migrations.runMigrations();
  const db = connection.getDb();
  const wide = JSON.stringify({ file_read: '*', file_write: '*', exec_allow: ['echo', 'tee'], exec_deny: [], shell_allow: ['echo', 'tee'], shell_deny: [], network_domains: 'none', max_processes: 1, can_spawn_agents: false, can_assign_permissions: false, system_control: [] });
  const add = db.prepare("INSERT INTO agents (id, name, status, config, classification, permissions, spawn_depth, created_by) VALUES (?, ?, 'idle', '{}', ?, ?, 1, 'agent-main')");
  add.run(MAIN, 'main', 'sensei', null);
  add.run(HELPER, 'helper', 'apprentice', wide);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(MAIN);
  platform.clearPlatformConfigCache();
});

afterAll(() => {
  connection.closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
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

describe("a helper's write to a login-key file waits for approval", () => {
  it('through a file tool', async () => {
    const refusal = await dispatch(HELPER, 'file_write', { path: keys, content: 'ssh-ed25519 FAKEKEY someone@example.com' });
    expect(refusal?.content).toContain('[HELD by engine');
  });

  it.each([
    `echo "ssh-ed25519 FAKEKEY" | tee -a ${keys}`,
    'echo "ssh-ed25519 FAKEKEY" >> ~/.ssh/authorized_keys',
  ])('through the shell: %s', async (script) => {
    const refusal = await dispatch(HELPER, 'shell', { script });
    expect(refusal?.content).toContain('[HELD by engine');
  });

  it('an ordinary write by the same helper is not held', async () => {
    expect(await dispatch(HELPER, 'file_write', { path: path.join(home, 'notes.txt'), content: 'x' })).toBeNull();
    expect(await dispatch(HELPER, 'shell', { script: `echo hi | tee ${path.join(home, 'notes.txt')}` })).toBeNull();
  });

  it("the main agent's own write is not held", async () => {
    expect(await dispatch(MAIN, 'file_write', { path: keys, content: 'ssh-ed25519 FAKEKEY' })).toBeNull();
    expect(await dispatch(MAIN, 'shell', { script: `echo k | tee -a ${keys}` })).toBeNull();
  });
});
