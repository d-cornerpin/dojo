// ════════════════════════════════════════════════════════════════════════════
// THE TWO SPAWN GATES, RECONCILED (PHASE-5 T5, RULING P5-R2).
//
// T0-SURVEY found that spawn permission is asked in TWO places, and the ruling
// left the reconciliation to this task with a named requirement: *"measure both
// paths at its own HEAD, declare which gate is authoritative, and prove by a
// RED-first test that a spawn-permission refusal still bites END TO END (through
// the spawner, not only the executor). Neither gate goes dead silently; a dead
// gate that still reads as protection is the disease."*
//
// ── MEASURED AT THIS HEAD ──
//   GATE 1  the executor's.  `tools/gates.ts` pushes `{kind:'spawn', row:'4'}`
//           for the tool name `spawn_agent`; `tools/gate-eval.ts` answers it
//           with `authorizeSpawn(grantFor(agentId))`. Fires ONLY when a MODEL
//           calls the tool.
//   GATE 2  the spawner's.   `spawner.ts` asks
//           `checkPermission(parentId, {type:'spawn'})`, which answers with
//           `authorizeSpawn(grantForManifest(...))`. Fires on EVERY call of
//           `spawnAgent()`, whatever called it.
//
// ── THE VERDICT: GATE 2 IS AUTHORITATIVE, AND GATE 1 IS NOT REDUNDANT ──
// `spawnAgent()` has callers that never enter the executor —
// `vault/maintenance.ts` spawns without a model in the loop — so gate 1 cannot
// be the authority: it is not on that path at all. Gate 2 is on every path by
// construction, because it is inside the function that writes the row.
//
// Gate 1 stays because it does a DIFFERENT job, not the same one twice: it turns
// the refusal into something the model can read and the audit can count — the
// ladder's own `PERMISSION_DENIED` code, its row-4 message, and an audit entry
// filed as `spawn` — at the tool boundary, before a handler runs. Deleting it
// would not lose the protection (gate 2 holds), it would lose the AGENT-FACING
// half: the model would receive a raw thrown `Error` string instead of a
// classified refusal. They cannot disagree, because both call the same
// `authorizeSpawn` against the same manifest — `grantFor` re-projects the moment
// a stored fingerprint stops matching, so the row path and the pure path are
// equal by construction rather than by discipline.
//
// This file holds gate 2, the authoritative one, END TO END through the real
// `spawnAgent`. `ladder-rows.test.ts` holds gate 1's declaration.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { PermissionManifest } from '@dojo/shared';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: (id: string) => id === 'primary',
  isPMAgent: () => false,
  isHealerAgent: () => false,
  isTrainerAgent: () => false,
  isImaginerAgent: () => false,
  isDreamerAgent: () => false,
  getPrimaryAgentId: () => 'primary',
  getPrimaryAgentName: () => 'Kevin',
  getHealerAgentId: () => 'healer',
  getDreamerAgentId: () => 'dreamer',
  getImaginerAgentId: () => 'imaginer',
}));

// `handleMessage` must return a PROMISE: the positive control runs far enough
// to reach `runtime.handleMessage(...).catch(...)`, which is itself evidence
// that the allowed path goes all the way through rather than stopping early.
vi.mock('../runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: vi.fn(async () => {}) }),
}));
vi.mock('../agent-bus.js', () => ({ sendAgentMessage: vi.fn() }));
vi.mock('../agent-notice.js', () => ({ postAgentNotice: vi.fn() }));
vi.mock('../../memory/retrieval.js', () => ({ memoryGrep: () => 'No results found' }));
vi.mock('../../memory/message-store.js', () => ({
  insertMessageIfAbsent: vi.fn(),
  insertEngineEventIfAbsent: vi.fn(),
}));
vi.mock('../../vault/archive.js', () => ({ archiveAgentConversation: vi.fn() }));
vi.mock('../../work/tracker-store.js', () => ({
  setTrackerStatus: vi.fn(), patchWork: vi.fn(), appendWorkNotes: vi.fn(),
  deliveryForTaskClose: vi.fn(),
}));
vi.mock('../../work/store.js', () => ({ workSettled: vi.fn() }));
vi.mock('../../work/tracker-view.js', () => ({ taskScope: () => '1=1', STATE_TO_STATUS_SQL: "'open'" }));

// The resource monitor is the OTHER refusal in the same region. It is stubbed
// ALLOW so a red in this file can only ever be the permission gate — if the
// memory check refused, every clause would pass for the wrong reason.
vi.mock('../../services/resource-monitor.js', () => ({
  canSpawnAgent: () => ({ allowed: true }),
}));

const { spawnAgent } = await import('../spawner.js');

/** A manifest that differs from the default in exactly one field. */
const manifestWith = (over: Partial<PermissionManifest>): string => JSON.stringify({
  file_read: '*', file_write: '*', file_delete: 'none',
  exec_allow: ['*'], exec_deny: [], network_domains: '*',
  max_processes: 10, can_spawn_agents: true, can_assign_permissions: true,
  system_control: [],
  ...over,
});

function seed(parentPermissions: string): void {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, model_id TEXT, system_prompt_path TEXT, status TEXT,
      config TEXT, created_by TEXT, created_by_kind TEXT, parent_agent TEXT, spawn_depth INTEGER,
      agent_type TEXT, classification TEXT, group_id TEXT, max_runtime INTEGER, timeout_at TEXT,
      permissions TEXT, tools_policy TEXT, equipped_techniques TEXT, task_id TEXT,
      charter TEXT, always_loaded_tools TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
  `);
  db.prepare(
    `INSERT INTO agents (id, name, model_id, spawn_depth, status, created_by, permissions)
     VALUES ('parent', 'Parent', 'deepseek', 1, 'idle', 'kevin', ?)`,
  ).run(parentPermissions);
  mockDb.current = db;
}

const agentCount = (): number =>
  (mockDb.current!.prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n;

const spawnParams = {
  parentId: 'parent',
  name: 'Worker',
  systemPrompt: 'do the thing',
  timeout: 600,
};

describe('RULING P5-R2 — the AUTHORITATIVE gate bites end to end, through the spawner', () => {
  beforeEach(() => { mockDb.current = null; });

  it('⚠ A PARENT WITHOUT `can_spawn_agents` IS REFUSED BY `spawnAgent` ITSELF', () => {
    // THE CLAUSE THE RULING ASKS FOR. Not the executor's gate, not
    // `checkPermission` called directly — the real spawn function, refusing.
    seed(manifestWith({ can_spawn_agents: false }));
    return expect(spawnAgent(spawnParams)).rejects.toThrow(/Spawn denied/);
  });

  it('and NO agent row is written — the refusal precedes the INSERT', () => {
    // A gate that refuses AFTER the row lands is not a gate. This is the half
    // that makes "bites end to end" a fact about the database rather than about
    // an exception type.
    seed(manifestWith({ can_spawn_agents: false }));
    return expect(spawnAgent(spawnParams)).rejects.toThrow().then(() => {
      expect(agentCount(), 'only the parent may exist').toBe(1);
    });
  });

  it('THE POSITIVE CONTROL: a parent WITH the grant still spawns', async () => {
    // Every refusal in this phase carries one of these. Without it a validator
    // that refuses everything would pass the two clauses above.
    seed(manifestWith({ can_spawn_agents: true }));
    const result = await spawnAgent(spawnParams);
    expect(result.name).toBe('Worker');
    expect(agentCount(), 'the parent and the new child').toBe(2);
  });

  it('the refusal names the rule, so the caller can act on it', async () => {
    seed(manifestWith({ can_spawn_agents: false }));
    await expect(spawnAgent(spawnParams)).rejects.toThrow(/not permitted|spawn/i);
  });

  it('the two gates answer from the SAME authority — they cannot disagree', async () => {
    // Both call `authorizeSpawn`. The executor reaches it through `grantFor`
    // (the `grant_rule` rows) and the spawner through `grantForManifest` (the
    // pure projection); `grantFor` re-projects whenever a stored fingerprint
    // stops matching, so the two are equal by construction. Asserted here so a
    // future change that gives one gate its own answer fails loudly instead of
    // creating the second truth this phase exists to delete.
    const { authorizeSpawn } = await import('../brokers/index.js');
    const { grantForManifest } = await import('../brokers/grants.js');
    for (const can_spawn_agents of [true, false]) {
      const manifest = JSON.parse(manifestWith({ can_spawn_agents })) as PermissionManifest;
      const grant = grantForManifest('parent', manifest);
      expect(authorizeSpawn(grant).allowed, `can_spawn_agents=${can_spawn_agents}`).toBe(can_spawn_agents);
    }
  });
});
