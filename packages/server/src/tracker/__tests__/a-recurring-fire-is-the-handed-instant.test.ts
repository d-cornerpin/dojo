// ════════════════════════════════════════════════════════════════════════════════════════
// D17 (GitHub #26) — A RECURRING TASK'S FIRE IS WHEN THE AGENT WAS HANDED IT.
//
// The incident (GitHub #26): a nightly task fires, the scheduler claims a new run and stamps the
// parent's `last_run_at`; on the same tick the liveness sweep measured the agent's quiet from the
// parent's `opened_at`, which for a recurring row is the day it was CREATED, and from the agent's
// last activity, hours ago. The window was exceeded at second zero and the owner was texted
// "has shown no sign of work for 15 h" about work that had just been handed over.
//
// A typical owner's expectation: the clock on "no sign of work" starts when the agent was given
// the work, and a nightly task being given is the moment it fires. A one-shot task opened hours
// ago and never touched is still reported, as before.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-d17-liveness', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ }, stampPersistedRow: (e: unknown) => e }));
const { alerts } = vi.hoisted(() => ({ alerts: [] as string[] }));
vi.mock('../../services/imessage-bridge.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  sendAlert: vi.fn((words: string) => { alerts.push(words); }),
}));

import { runMigrations } from '../../db/migrations.js';
import { sweepSilentAgents } from '../liveness.js';
import { seedTrackerTask } from '../../work/__tests__/work-fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const db = (): Database.Database => mockDb.current!;
const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

beforeEach(() => {
  alerts.length = 0;
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare(`INSERT INTO providers (id, name, type, auth_type) VALUES ('prov-a', 'Cloud Provider', 'openai-compatible', 'api_key')`).run();
  d.prepare(`INSERT INTO models (id, provider_id, name, api_model_id) VALUES ('m-a', 'prov-a', 'Model A', 'model-a')`).run();
  d.prepare(`INSERT INTO agents (id, name, status, model_id, classification, silent_window_minutes)
             VALUES ('helper', 'Helper', 'working', 'm-a', 'apprentice', 120)`).run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

/** The agent's last movement: a finished model call `ago` before `now`. */
function lastMovedAgo(ago: number, now: number): void {
  db().prepare(`INSERT INTO cost_records (id, agent_id, model_id, provider_id, input_tokens, output_tokens, cost_usd, created_at)
                VALUES ('cr-1', 'helper', 'm-a', 'prov-a', 1000, 100, 0.01, ?)`).run(sqlTime(now - ago));
}

describe('D17 — the sweep that shares the fire\'s tick does not text about work just handed over', () => {
  it('#26\'s shape: a nightly task created days ago fires now, the agent was quiet ~4 h, the window is 120 min: no notice', () => {
    const now = Date.now();
    lastMovedAgo(4 * HOUR, now);
    seedTrackerTask(db(), {
      id: 'nightly', agentId: 'helper', status: 'in_progress', title: 'the nightly digest', priority: 'normal',
      opened_at: now - 3 * DAY, updated_at: now, last_run_at: now, schedule_status: 'running',
    } as never);
    sweepSilentAgents(now);
    expect(alerts).toEqual([]);
    expect((db().prepare("SELECT silent_notice AS n FROM agents WHERE id = 'helper'").get() as { n: string | null }).n).toBeNull();
  });

  it('the backlog\'s shape: an agent idle 15 h, the nightly task fires now, the sweep runs on the same tick: no notice', () => {
    const now = Date.now();
    lastMovedAgo(15 * HOUR, now);
    seedTrackerTask(db(), {
      id: 'nightly', agentId: 'helper', status: 'in_progress', title: 'the nightly digest', priority: 'normal',
      opened_at: now - 40 * DAY, updated_at: now, last_run_at: now, schedule_status: 'running',
    } as never);
    sweepSilentAgents(now);
    expect(alerts).toEqual([]);
  });

  it('the quiet is measured from the fire: the same task, fired 3 h ago and untouched since, IS reported', () => {
    const now = Date.now();
    lastMovedAgo(4 * HOUR, now);
    seedTrackerTask(db(), {
      id: 'nightly', agentId: 'helper', status: 'in_progress', title: 'the nightly digest', priority: 'normal',
      opened_at: now - 3 * DAY, updated_at: now - 3 * HOUR, last_run_at: now - 3 * HOUR, schedule_status: 'running',
    } as never);
    sweepSilentAgents(now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('the nightly digest');
  });

  it('CONTROL: a one-shot task opened 3 h ago and never moved, with an agent quiet 4 h, is reported as today', () => {
    const now = Date.now();
    lastMovedAgo(4 * HOUR, now);
    seedTrackerTask(db(), {
      id: 'oneshot', agentId: 'helper', status: 'in_progress', title: 'the one-off report', priority: 'normal',
      opened_at: now - 3 * HOUR, updated_at: now - 3 * HOUR,
    } as never);
    sweepSilentAgents(now);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain('the one-off report');
  });
});
