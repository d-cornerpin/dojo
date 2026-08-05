// PHASE-0 T12 — the `rate_limited` alert can actually fire.
//
// Three-strike rate limiting is supposed to mark the agent `rate_limited` and
// broadcast it, so the dashboard says WHY the agent went quiet. It never has:
// `agents.status` carried a day-0 CHECK that did not list the value, and the
// throw landed in a bare `catch { /* best effort */ }` that also owned the
// broadcast. Two halves, two guards here:
//
//   Part A — migration 126 widens the constraint on a lived-in database without
//            losing a row, a column, or a foreign key.
//   Part B — the strike-3 path routes the write through the status writer and
//            the `agent:status` broadcast actually leaves the building.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { AGENT_STATUSES } from '@dojo/shared';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(HERE, '..', '..', 'db', 'migrations');
const MIGRATION_126 = fs.readFileSync(
  path.join(MIGRATIONS_DIR, '126_agent_status_rate_limited.sql'),
  'utf-8',
);

const mockDb = { current: null as Database.Database | null };
const broadcastSpy = vi.fn();
const sendAlertSpy = vi.fn();
const notifyRateLimitHitSpy = vi.fn();

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
  // migrations.ts uses this for its best-effort pre-chain VACUUM INTO backup.
  // Point it at the OS temp dir so nothing lands in the repo.
  getDbPath: () => path.join(os.tmpdir(), 'dojo-t12-test', 'dojo.db'),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: (e: unknown) => broadcastSpy(e) }));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: (...a: unknown[]) => sendAlertSpy(...a) }));
vi.mock('../errors.js', () => ({ notifyRateLimitHit: (...a: unknown[]) => notifyRateLimitHitSpy(...a) }));
vi.mock('../../config/platform.js', () => ({ isPrimaryAgent: () => true }));

// The retry manager replays the last message through the runtime; this one is
// permanently rate-limited, which is what drives the strikes.
vi.mock('../runtime.js', () => ({
  getAgentRuntime: () => ({
    handleMessage: () => Promise.reject(new Error('429 rate_limit_error: too many requests')),
  }),
}));

// ── GUARD-AUDIT F3, DISCHARGED AT PHASE-6 T10: THE MOCK FOLLOWS ITS SUBJECT ──
//
// This used to be `vi.mock('../v2/loop.js', …)` — a mock bound to a PATH rather than to a
// behaviour, and the audit's finding was that vitest does not fail on a mock whose target no
// longer exports the name. `setAgentStatus` HAS now left `loop.ts` (T10 made
// `agent/agent-status.ts` the one owner of the `agents.status` transition), so the old
// binding would have silently stopped intercepting and this test would have gone on passing
// while measuring something else. It is re-pointed WITH its subject.
//
// The stand-in performs the SAME two effects the real writer performs for a non-idle status:
// the UPDATE, and the `agent:status` broadcast. The UPDATE runs against the REAL migrated
// schema below, so the widened CHECK is genuinely exercised here; Part A proves the column
// accepts the value, this proves the retry path delegates and broadcasts.
const setAgentStatusSpy = vi.fn((agentId: string, status: string) => {
  const db = mockDb.current;
  if (!db) throw new Error('test DB not initialized');
  db.prepare("UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, agentId);
  broadcastSpy({ type: 'agent:status', agentId, status });
});
const writeAgentStatusSpy = vi.fn((agentId: string, status: string) => {
  const db = mockDb.current;
  if (!db) throw new Error('test DB not initialized');
  db.prepare("UPDATE agents SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, agentId);
});
vi.mock('../agent-status.js', () => ({
  setAgentStatus: (a: string, s: string) => setAgentStatusSpy(a, s),
  writeAgentStatus: (a: string, s: string) => writeAgentStatusSpy(a, s),
}));

import { scheduleRateLimitRetry, hasActiveRateLimitRetry } from '../rate-limit-retry.js';
import { runMigrations } from '../../db/migrations.js';

// ════════════════════════════════════════
// Part A — migration 126
// ════════════════════════════════════════

// `agents` exactly as SQLite serialises it after the shipped chain through 125:
// the day-0 CREATE in db/migrations.ts plus every ALTER TABLE ADD COLUMN since.
// This is the table a lived-in stable box brings to migration 126.
const AGENTS_AT_125 = `
CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model_id TEXT,
      system_prompt_path TEXT,
      status TEXT NOT NULL DEFAULT 'idle' CHECK(status IN ('idle', 'working', 'paused', 'error', 'terminated')),
      config TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')), parent_agent TEXT REFERENCES agents(id), spawn_depth INTEGER DEFAULT 0, agent_type TEXT DEFAULT 'standard', max_runtime INTEGER, timeout_at TEXT, permissions TEXT DEFAULT '{}', tools_policy TEXT DEFAULT '{}', task_id TEXT, classification TEXT NOT NULL DEFAULT 'apprentice', group_id TEXT REFERENCES agent_groups(id), equipped_techniques TEXT DEFAULT '[]', session_started_at TEXT DEFAULT NULL, always_loaded_tools TEXT DEFAULT NULL, last_error TEXT, last_error_at TEXT, recovery_attempts INTEGER DEFAULT 0, dreamer_ignore INTEGER DEFAULT 0, charter TEXT DEFAULT NULL, timeout_decision_pending INTEGER DEFAULT 0,
      FOREIGN KEY (model_id) REFERENCES models(id) ON DELETE SET NULL
    );
`;

describe('migration 126 widens agents.status without disturbing a lived-in table', () => {
  let db: Database.Database;

  /** A stable-shaped box: the pre-126 agents table, its FK parents, and one of
   * the ON DELETE CASCADE children the rebuild's DROP could take with it. */
  function stableBox(): Database.Database {
    const d = new Database(':memory:');
    // The runner disables FK enforcement for the whole chain; mirror that.
    d.pragma('foreign_keys = OFF');
    d.exec(`
      CREATE TABLE models (id TEXT PRIMARY KEY);
      CREATE TABLE agent_groups (id TEXT PRIMARY KEY);
      ${AGENTS_AT_125}
      CREATE TABLE messages (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, content TEXT NOT NULL,
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
      );
    `);
    d.prepare("INSERT INTO models (id) VALUES ('m1')").run();
    d.prepare("INSERT INTO agent_groups (id) VALUES ('g1')").run();
    d.prepare(`
      INSERT INTO agents (id, name, model_id, status, config, created_by, created_at, updated_at,
                          parent_agent, spawn_depth, agent_type, permissions, tools_policy,
                          classification, group_id, equipped_techniques, last_error,
                          recovery_attempts, dreamer_ignore, charter, timeout_decision_pending)
      VALUES ('parent', 'Sensei', 'm1', 'working', '{"a":1}', 'owner', '2026-01-01 00:00:00', '2026-02-02 00:00:00',
              NULL, 0, 'persistent', '{"fs":"rw"}', '{"allow":["x"]}',
              'sensei', 'g1', '["t1"]', 'boom', 3, 1, 'a charter', 2)
    `).run();
    d.prepare(`
      INSERT INTO agents (id, name, status, parent_agent, spawn_depth, classification)
      VALUES ('child', 'Apprentice', 'terminated', 'parent', 1, 'apprentice')
    `).run();
    d.prepare("INSERT INTO messages (id, agent_id, content) VALUES ('m-1', 'parent', 'hello')").run();
    return d;
  }

  const setStatus = (id: string, status: string): void => {
    db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, id);
  };

  beforeEach(() => { db = stableBox(); });
  afterEach(() => { db.close(); });

  it('RED anchor: the shipped constraint refuses rate_limited', () => {
    expect(() => setStatus('parent', 'rate_limited')).toThrow(/CHECK constraint failed/);
  });

  it('accepts rate_limited once the rebuild has run', () => {
    db.exec(MIGRATION_126);
    setStatus('parent', 'rate_limited');
    expect(db.prepare("SELECT id FROM agents WHERE status = 'rate_limited'").all()).toEqual([{ id: 'parent' }]);
  });

  it('is a widening only — every prior status still fits, an unknown one still does not', () => {
    db.exec(MIGRATION_126);
    for (const s of ['idle', 'working', 'paused', 'error', 'terminated']) {
      expect(() => setStatus('parent', s), s).not.toThrow();
    }
    expect(() => setStatus('parent', 'banana')).toThrow(/CHECK constraint failed/);
  });

  it('preserves every agent row byte for byte', () => {
    const before = db.prepare('SELECT * FROM agents ORDER BY id').all();
    db.exec(MIGRATION_126);
    expect(db.prepare('SELECT * FROM agents ORDER BY id').all()).toEqual(before);
  });

  it('preserves the column roster, the foreign keys and the primary key', () => {
    const cols = (): unknown => db.prepare('SELECT * FROM pragma_table_info(?)').all('agents');
    const fks = (): unknown => db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all('agents');
    const before = { cols: cols(), fks: fks() };
    db.exec(MIGRATION_126);
    // 28 columns, same order, same types, same NOT NULL / DEFAULT / pk flags.
    expect(cols()).toEqual(before.cols);
    // models(SET NULL), agent_groups, and the parent_agent self-reference — the
    // last one must resolve to `agents`, not to the scratch `agents_new` name.
    expect(fks()).toEqual(before.fks);
    expect((fks() as { table: string }[]).map(f => f.table).sort()).toEqual(['agent_groups', 'agents', 'models']);
  });

  it('leaves no scratch table behind and takes no cascade child with it', () => {
    db.exec(MIGRATION_126);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'agents_new'").all()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) AS c FROM messages').get()).toEqual({ c: 1 });
    expect(db.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
  });

  it('is idempotent — a second run changes nothing', () => {
    db.exec(MIGRATION_126);
    setStatus('parent', 'rate_limited');
    const before = db.prepare('SELECT * FROM agents ORDER BY id').all();
    db.exec(MIGRATION_126);
    expect(db.prepare('SELECT * FROM agents ORDER BY id').all()).toEqual(before);
    expect(() => setStatus('child', 'rate_limited')).not.toThrow();
  });
});

// The durable invariant this task installs: the shared roster and the database
// constraint are one fact. A future status added to AGENT_STATUSES without a
// migration fails here instead of failing silently in a swallowed catch.
describe('the agents.status CHECK and the AgentStatus roster are the same list', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    mockDb.current = db;
    runMigrations(); // the REAL chain, 001 → 126
  });
  afterEach(() => { mockDb.current = null; db.close(); });

  it('accepts every declared status and refuses one that is not declared', () => {
    db.prepare("INSERT INTO agents (id, name, status) VALUES ('a1', 'A', 'idle')").run();
    for (const status of AGENT_STATUSES) {
      expect(
        () => db.prepare('UPDATE agents SET status = ? WHERE id = ?').run(status, 'a1'),
        status,
      ).not.toThrow();
    }
    expect(() => db.prepare('UPDATE agents SET status = ? WHERE id = ?').run('not_a_status', 'a1'))
      .toThrow(/CHECK constraint failed/);
  });
});

// ════════════════════════════════════════
// Part B — the strike-3 alert path
// ════════════════════════════════════════

describe('strike 3 marks the agent rate_limited and broadcasts it', () => {
  let db: Database.Database;

  // rate-limit-retry keeps its in-flight retries in a module-level map that no
  // export clears, and a decaying agent is still in it when a test ends. Every
  // test therefore uses a fresh agent id, or the next scheduleRateLimitRetry
  // would take the "already retrying, don't stack" early return and silently
  // assert nothing.
  let seq = 0;
  function freshAgent(modelId: string | null = null): string {
    const id = `agent-${++seq}`;
    db.prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, ?, 'working', ?)").run(id, id, modelId);
    return id;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    db = new Database(':memory:');
    mockDb.current = db;
    runMigrations();
  });

  afterEach(() => {
    vi.useRealTimers();
    mockDb.current = null;
    db.close();
  });

  const statusOf = (id: string): string =>
    (db.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;

  const statusBroadcasts = (): { agentId: string; status: string }[] =>
    broadcastSpy.mock.calls
      .map(c => c[0] as { type: string; agentId: string; status: string })
      .filter(e => e.type === 'agent:status');

  const rateLimitHints = (): { agentId: string }[] =>
    broadcastSpy.mock.calls
      .map(c => c[0] as { type: string; agentId: string; code?: string })
      .filter(e => e.type === 'chat:error' && e.code === 'RATE_LIMITED');

  /** Silent retry 1 (10s) → silent retry 2 (30s) → strike 3. */
  async function driveToStrikeThree(agentId: string): Promise<void> {
    scheduleRateLimitRetry(agentId, null, 'the message that got rate-limited');
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(30_000);
  }

  it('says nothing on the two silent strikes', async () => {
    const id = freshAgent();
    scheduleRateLimitRetry(id, null, 'hello');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statusOf(id)).toBe('working');
    expect(statusBroadcasts()).toEqual([]);
    expect(notifyRateLimitHitSpy).not.toHaveBeenCalled();
    expect(hasActiveRateLimitRetry(id)).toBe(true);
  });

  it('writes the status through the status writer, and the row lands', async () => {
    const id = freshAgent();
    await driveToStrikeThree(id);
    expect(setAgentStatusSpy).toHaveBeenCalledWith(id, 'rate_limited');
    expect(statusOf(id)).toBe('rate_limited');
  });

  it('emits the agent:status broadcast the dashboard reads', async () => {
    const id = freshAgent();
    await driveToStrikeThree(id);
    expect(statusBroadcasts()).toContainEqual({ type: 'agent:status', agentId: id, status: 'rate_limited' });
  });

  it('notifies the owner exactly once and keeps decaying', async () => {
    const id = freshAgent();
    await driveToStrikeThree(id);
    expect(notifyRateLimitHitSpy).toHaveBeenCalledTimes(1);
    expect(notifyRateLimitHitSpy).toHaveBeenCalledWith(id, 'rate_limit');
    expect(hasActiveRateLimitRetry(id)).toBe(true);

    // The first decay rung (60s) fires, still limited: no second alert, no
    // second status write, and the agent stays marked.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(notifyRateLimitHitSpy).toHaveBeenCalledTimes(1);
    expect(setAgentStatusSpy).toHaveBeenCalledTimes(1);
    expect(statusOf(id)).toBe('rate_limited');
  });

  it('adds the auto-router hint only for an auto-routed agent', async () => {
    const pinned = freshAgent(null);
    await driveToStrikeThree(pinned);
    expect(rateLimitHints()).toEqual([]);
    expect(statusOf(pinned)).toBe('rate_limited');

    const auto = freshAgent('auto');
    await driveToStrikeThree(auto);
    expect(rateLimitHints().map(h => h.agentId)).toEqual([auto]);
    // …and the status alert still stands beside it: the hint is no longer
    // sharing a catch with the thing that matters.
    expect(statusOf(auto)).toBe('rate_limited');
    expect(statusBroadcasts().map(e => e.agentId)).toEqual([pinned, auto]);
  });
});
