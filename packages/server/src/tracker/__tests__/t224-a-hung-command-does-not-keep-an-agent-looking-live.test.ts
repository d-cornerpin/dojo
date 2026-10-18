// ════════════════════════════════════════════════════════════════════════════════════════
// t224 — A RUNNING COMMAND IS NOT "A REQUEST OPEN ON A LIVE CONNECTION".
//
// THE DEFECT (t223 section 3). Liveness reads the abort registry as "a model or media request is
// open" and counts it as movement RIGHT NOW. t203 put every child the toolbox spawns into that
// registry for its whole life, so a sub-agent wedged on a command that never exits looked
// permanently live: the SILENT window never closed, the owner got no notice and no `person_told`
// record, and later the ladder raised the very same task with him again.
//
// This clause drives the REAL spawn door (a real child that never exits, inside a real per-call
// capability) and the REAL liveness sweep, down to the owner-notice door and the task's spine.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t224-liveness');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t224-liveness');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t224-liveness', 'dojo.db'),
  };
});

const { transport } = vi.hoisted(() => ({ transport: [] as string[] }));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: () => undefined,
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));
// Only the phone's synchronous senders are replaced; `spawn` (the door under test) is the real one.
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../../db/migrations.js';
import { runWithToolCallId } from '../../agent/turn-state.js';
import { attachCallCapability, mintCallCapability, type ResourceGrant } from '../../agent/effects/capability.js';
import { countAbortable, activeAbortControllers } from '../../agent/shared-state.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const OWNER = 'owner@example.test';
const AGENT = 'helper';
const MIN = 60_000;
const db = (): Database.Database => mockDb.current!;
const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const children: Array<{ pid?: number }> = [];

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  transport.length = 0;
  d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true }]));
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification) VALUES
    ('helper', 'Helper', 'working', 'm-a', 'apprentice')`).run();
});

afterEach(() => {
  for (const c of children) { try { process.kill(-(c.pid as number), 'SIGKILL'); } catch { /* gone */ } }
  children.length = 0;
  activeAbortControllers.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

/** A real child that never exits, started through the toolbox's one spawn door inside a real call. */
async function startHungCommand(): Promise<void> {
  const { spawnAuthorized } = await import('../../agent/effects/proc.js');
  const grants: ResourceGrant[] = [{ kind: 'proc', program: '/bin/zsh', display: '/bin/zsh' } as ResourceGrant];
  const child = await runWithToolCallId(AGENT, 'call-1', async () => {
    attachCallCapability(mintCallCapability({ agentId: AGENT, tool: 'shell', callId: 'call-1', grants }));
    return spawnAuthorized('/bin/zsh', ['-c', 'sleep 53; wait']);
  });
  children.push(child);
}

describe('t224: a sub-agent wedged on a command that never exits is SILENT, and the owner is told', () => {
  it('RED: one silent notice goes out and the newest task records the owner as told', async () => {
    const now = Date.now();
    // The sub-agent claimed two tasks 10 minutes ago; its last model call finished 6 minutes ago,
    // it asked for a command, and the command never came back. Its silent window is ONE minute.
    for (const [id, title, at] of [['task-old', 'the older report', now - 12 * MIN], ['task-new', 'the venue shortlist', now - 10 * MIN]] as const) {
      seedTrackerTask(db(), {
        id, agentId: AGENT, status: 'in_progress', title,
        opened_at: at, updated_at: at, origin_conv_key: 'c-1', priority: 'normal',
      } as never);
    }
    db().prepare('UPDATE agents SET silent_window_minutes = 1 WHERE id = ?').run(AGENT);
    db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
                  VALUES ('cr-1', ?, 'm-a', 'prov-a', 12000, 300, 0.01, ?)`).run(AGENT, sqlTime(now - 6 * MIN));
    db().prepare(`INSERT INTO messages (id, agent_id, role, content, turn_number, created_at) VALUES ('asst-1', ?, 'assistant', ?, 3, ?)`)
      .run(AGENT, JSON.stringify([{ type: 'tool_use', id: 'tu-1', name: 'shell', input: {} }]), now - 6 * MIN);
    await startHungCommand();

    const { sweepSilentAgents } = await import('../liveness.js');
    sweepSilentAgents();
    sweepSilentAgents();   // the next sweep of the same incident: still one

    const texts = (db().prepare(
      "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = 'platform' AND tool = 'alert' AND recipient_id = ?",
    ).get(OWNER) as { n: number }).n;
    expect(texts, 'the owner is told once that the sub-agent has shown no sign of work').toBe(1);
    expect(transport.filter((t) => t.includes('"send"'))[0]).toContain('has shown no sign of work');
    const told = (id: string): Array<{ via: string }> => db().prepare(
      "SELECT json_extract(payload, '$.via') AS via FROM work_events WHERE work_id = ? AND kind = 'person_told'",
    ).all(id) as Array<{ via: string }>;
    expect(told('task-new')).toEqual([{ via: 'owner_notice' }]);
    expect(told('task-old')).toEqual([]);
  });

  it('RED: the abort registry, which liveness reads as "a request is open", holds nothing for a running command', async () => {
    await startHungCommand();
    expect(countAbortable(AGENT)).toBe(0);
  });
});
