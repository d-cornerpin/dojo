// ════════════════════════════════════════════════════════════════════════════════════════
// A CRASHED RUN DOES NOT LEAVE ITS TURN OPEN — t93 fix round 1 (review I-1).
//
// ── THE DEFECT, AND IT IS A BOOT-ORDER GAP ──────────────────────────────────────────────
// `turns` rows open at pickup and close in the turn's `finally`. A process killed mid-turn
// runs no `finally`, so the row keeps `ended_at IS NULL` for ever — `work/occurrences.ts`
// measured 22 of them on one agent and 279 across seven on a lived-in box, "every one of them
// a turn some crash or restart never closed", and had to narrow a live-turn guard to the
// occurrence because the per-agent question is permanently true. `terminated` is the enum's
// word for exactly this and it had never been written once in 10,934 turns.
//
// t93's first cut wired it at the PERIODIC REAPER, and review I-1 measured that the boot
// order starves that site for the common case:
//
//   `index.ts` runs `runStartupRecoverySweep()` — which contains the reaper — BEFORE
//   `resetWorkingAgentsToIdleAtBoot()`. The reaper only reaps a `working` row whose
//   `updated_at` is past the 75-minute cliff. So a process killed mid-turn and restarted
//   INSIDE the hour — the ordinary restart, the update, the crash-loop — reached neither
//   writer: the boot sweep set the agent row `idle` and the turn row stayed open exactly as
//   before. And once the agent reads `idle`, the periodic reaper never visits it again.
//
// ── WHY THE FIX IS HERE AND NOT SOMEWHERE NEW ───────────────────────────────────────────
// `agent-status.ts`'s boot sweep is the site that KNOWS, in its own pre-existing words: "a
// process that died mid-turn leaves rows reading `working` that no run owns. Restarting is
// the only thing that can know that, so it is the only thing that does this." It repaired
// `agents` and not `turns`. The verdict is its own; the statement lives in
// `agent/v2/turn-record.ts`, the one module that writes that table.
//
// It closes every agent's open turns through the one writer: no turn survives a restart, so none can be read as
// still serving its work.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
const infos: string[] = [];

vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t93-boot-sweep', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
    info: (msg: string) => { infos.push(msg); },
  }),
}));

import { runMigrations } from '../../db/migrations.js';
import { resetWorkingAgentsToIdleAtBoot } from '../agent-status.js';

const db = (): Database.Database => mockDb.current!;

const agent = (id: string, status: string): void => {
  db().prepare('INSERT INTO agents (id, name, status) VALUES (?, ?, ?)').run(id, id.toUpperCase(), status);
};
const openTurn = (agentId: string, turn: number): void => {
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, started_at, answered) VALUES (?, ?, datetime('now'), 0)`,
  ).run(agentId, turn);
};
const closedTurn = (agentId: string, turn: number, reason: string, answered = 0): void => {
  db().prepare(
    `INSERT INTO turns (agent_id, turn_number, started_at, ended_at, exit_reason, answered)
     VALUES (?, ?, datetime('now'), datetime('now'), ?, ?)`,
  ).run(agentId, turn, reason, answered);
};
const rows = (): Array<{ agent_id: string; turn_number: number; exit_reason: string | null; answered: number; ended_at: string | null }> =>
  db().prepare('SELECT agent_id, turn_number, exit_reason, answered, ended_at FROM turns ORDER BY agent_id, turn_number')
    .all() as never;
const statusOf = (id: string): string =>
  (db().prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;

beforeEach(() => {
  infos.length = 0;
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.pragma('foreign_keys = ON');
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE COMMON CRASH: killed mid-turn, restarted inside the hour
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the boot sweep closes the turn the dead process abandoned', () => {
  it('RED→GREEN: a `working` agent with an open turn gets `terminated`, answered 0, and the boot log says so', () => {
    agent('a-crashed', 'working');
    openTurn('a-crashed', 41);

    expect(resetWorkingAgentsToIdleAtBoot(), 'the agent repair is unchanged').toBe(1);

    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].exit_reason, 'the engine ended this turn by dying; it is not a chosen silence').toBe('terminated');
    expect(r[0].answered, 'nothing was delivered, and that is a separate column').toBe(0);
    expect(r[0].ended_at, 'the row must no longer be open').not.toBeNull();
    expect(statusOf('a-crashed'), 'and the agent row is still repaired').toBe('idle');
    // The boot record names the count: a sweep that closed nine and one that closed nothing
    // must be distinguishable from the log alone.
    expect(infos.filter((m) => /Closed 1 turn record\(s\) left open/.test(m)), infos.join(' | ')).toHaveLength(1);
    expect(infos.some((m) => m.includes("as 'terminated'"))).toBe(true);
  });

  it('EVERY open turn of the crashed run closes, not just the last one', () => {
    // A killed process can leave more than one open row for an agent (a crash during a second
    // turn, a history that was cleared and restarted). `markTurnDied` is scoped to one turn
    // because it HAS the number; this sweep does not and must not leave the others.
    agent('a-crashed', 'working');
    openTurn('a-crashed', 7);
    openTurn('a-crashed', 8);
    // ⚠ AND THE RETURN IS THE *AGENT* COUNT, which only THIS fixture can tell apart: one
    // agent, two turns. Every other clause here has them equal, so a refactor that returned
    // `turnsClosed` would pass them all and make `index.ts`'s boot line say "Reset 2 agent(s)"
    // about one agent. The two counts mean different things and the caller reads one of them.
    // Both started after the dead process did, by its boot stamp: both are its turns.
    expect(resetWorkingAgentsToIdleAtBoot(Date.now() - 3_600_000), 'the return is agents repaired, never turns closed').toBe(1);
    expect(rows().map((x) => x.exit_reason)).toEqual(['terminated', 'terminated']);
    expect(infos.filter((m) => /Closed 2 turn record\(s\)/.test(m)), 'and the turns are counted in the log')
      .toHaveLength(1);
  });

  it('an already-finalized turn of the same agent is left exactly as it stands', () => {
    agent('a-crashed', 'working');
    closedTurn('a-crashed', 5, 'answered', 1);
    openTurn('a-crashed', 6);
    resetWorkingAgentsToIdleAtBoot();
    expect(rows()).toEqual([
      expect.objectContaining({ turn_number: 5, exit_reason: 'answered', answered: 1 }),
      expect.objectContaining({ turn_number: 6, exit_reason: 'terminated', answered: 0 }),
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — NO TURN SURVIVES A RESTART: every agent's open rows close, whatever the agent's status
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 every open turn closes at boot, of every agent', () => {
  it('an IDLE agent\'s open row is closed too, and no agent row needed repairing', () => {
    // A row left open by an idle agent would otherwise read as a turn still serving its work for ever.
    agent('a-idle', 'idle');
    openTurn('a-idle', 3);
    expect(resetWorkingAgentsToIdleAtBoot(), 'no agent row needed repairing').toBe(0);
    expect(rows()[0].exit_reason).toBe('terminated');
    expect(rows()[0].ended_at).not.toBeNull();
  });

  it('a `terminated` agent and a `paused` one have theirs closed as well', () => {
    agent('a-done', 'terminated');
    agent('a-paused', 'paused');
    openTurn('a-done', 1);
    openTurn('a-paused', 1);
    resetWorkingAgentsToIdleAtBoot();
    expect(rows().map((x) => x.exit_reason)).toEqual(['terminated', 'terminated']);
    expect(statusOf('a-paused'), 'only a working agent is set idle').toBe('paused');
  });

  it('a mixed roster: both rows close, and only the `working` agent is repaired', () => {
    agent('a-crashed', 'working');
    agent('a-idle', 'idle');
    openTurn('a-crashed', 1);
    openTurn('a-idle', 1);
    expect(resetWorkingAgentsToIdleAtBoot()).toBe(1);
    expect(rows()).toEqual([
      expect.objectContaining({ agent_id: 'a-crashed', exit_reason: 'terminated' }),
      expect.objectContaining({ agent_id: 'a-idle', exit_reason: 'terminated' }),
    ]);
  });

  it('a boot with nothing to repair writes nothing and says nothing', () => {
    agent('a-idle', 'idle');
    expect(resetWorkingAgentsToIdleAtBoot()).toBe(0);
    expect(rows()).toEqual([]);
    expect(infos.filter((m) => /Closed \d+ turn record/.test(m))).toHaveLength(0);
  });
});
