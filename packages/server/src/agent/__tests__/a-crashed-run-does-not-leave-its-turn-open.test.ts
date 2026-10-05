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
// It SELECTS the crashed ids and writes through the one writer — the shape
// `terminateDuplicateAgentsByName` in the same module already uses, with its reason verbatim:
// "the statement count stays at one owner".
//
// ⚠ THE ORDER IS THE WHOLE MECHANISM, which is why §2 is a clause and not a comment: the read
// is `status = 'working'` — the same set the status UPDATE is about to repair — so running it
// AFTER that UPDATE selects nothing and closes nothing, SILENTLY. A sweep that closed zero
// rows and a boot with nothing to close are indistinguishable from the outside, which is how
// this kind of zero survives.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => p.join(o.tmpdir(), 'dojo-t93-boot-sweep', 'dojo.db'),
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

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SERVER_SRC, rel), 'utf8');
/** Comments blanked, length-preserving: every word below appears in the prose of these files. */
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));

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
    expect(resetWorkingAgentsToIdleAtBoot(), 'the return is agents repaired, never turns closed').toBe(1);
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
// §2 — COUNTING THE OTHER WAY, AND THE ORDER
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 it touches only the rows this boot is responsible for', () => {
  it('an IDLE agent\'s open row is NOT closed — the sweep is not a table sweep', () => {
    // The direction that matters for a lived-in box: 279 open rows already exist and they
    // belong to agents that are long since `idle`. Closing them here would be inventing a
    // verdict about runs nobody judged — and would make the `terminated` count meaningless.
    agent('a-idle', 'idle');
    openTurn('a-idle', 3);
    expect(resetWorkingAgentsToIdleAtBoot(), 'no agent row needed repairing').toBe(0);
    expect(rows()[0].exit_reason).toBeNull();
    expect(rows()[0].ended_at).toBeNull();
    expect(infos.filter((m) => /Closed \d+ turn record/.test(m)), 'and it says nothing').toHaveLength(0);
  });

  it('a `terminated` agent and a `paused` one are left alone too', () => {
    agent('a-done', 'terminated');
    agent('a-paused', 'paused');
    openTurn('a-done', 1);
    openTurn('a-paused', 1);
    resetWorkingAgentsToIdleAtBoot();
    expect(rows().map((x) => x.exit_reason)).toEqual([null, null]);
  });

  it('a mixed roster: only the `working` agent\'s row moves', () => {
    agent('a-crashed', 'working');
    agent('a-idle', 'idle');
    openTurn('a-crashed', 1);
    openTurn('a-idle', 1);
    expect(resetWorkingAgentsToIdleAtBoot()).toBe(1);
    expect(rows()).toEqual([
      expect.objectContaining({ agent_id: 'a-crashed', exit_reason: 'terminated' }),
      expect.objectContaining({ agent_id: 'a-idle', exit_reason: null }),
    ]);
  });

  it('⚠ THE ORDER: the crashed ids are read BEFORE the status UPDATE, or nothing closes at all', () => {
    // Not a style point. The read is `status = 'working'` — the same set the status UPDATE
    // repairs — so running it afterwards selects nothing and closes nothing, SILENTLY. Both
    // halves are asserted: the sequence is genuinely order-dependent (driven, by doing the
    // status write first and watching the sweep close nothing), and the call site genuinely
    // puts the read first (source, comments stripped).
    agent('a-crashed', 'working');
    openTurn('a-crashed', 1);
    db().prepare("UPDATE agents SET status = 'idle' WHERE status = 'working'").run();
    expect(
      resetWorkingAgentsToIdleAtBoot(),
      'nothing reads `working` any more — this is the silent zero the order prevents',
    ).toBe(0);
    expect(rows()[0].exit_reason, 'and no turn row moved either').toBeNull();

    const code = stripComments(read('agent/agent-status.ts'));
    const body = code.slice(code.indexOf('export function resetWorkingAgentsToIdleAtBoot'));
    const readAt = body.indexOf("SELECT id FROM agents WHERE status = 'working'");
    const closeAt = body.indexOf('markTurnsTerminated(');
    const idleAt = body.indexOf("UPDATE agents SET status = 'idle'");
    expect(readAt, 'the boot sweep stopped reading the crashed set').toBeGreaterThan(-1);
    expect(closeAt, 'the boot sweep stopped closing the abandoned turn rows').toBeGreaterThan(-1);
    expect(idleAt).toBeGreaterThan(-1);
    expect(readAt, 'the read must precede the status repair').toBeLessThan(idleAt);
    expect(closeAt, 'and so must the close').toBeLessThan(idleAt);
  });

  it('a boot with nothing to repair writes nothing and says nothing', () => {
    agent('a-idle', 'idle');
    expect(resetWorkingAgentsToIdleAtBoot()).toBe(0);
    expect(rows()).toEqual([]);
    expect(infos.filter((m) => /Closed \d+ turn record/.test(m))).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE TWO WRITERS COVER DIFFERENT CASES, AND THE SQL STAYS IN ONE MODULE
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 boot and reaper, and neither claims the other\'s case', () => {
  it('`agent-status.ts` holds the VERDICT and `turn-record.ts` holds the STATEMENT', () => {
    const status = stripComments(read('agent/agent-status.ts'));
    expect(status, 'the boot sweep stopped calling the writer').toMatch(/markTurnsTerminated\(c\.id\)/);
    expect(status, 'the one-module property: no second writer of `turns`').not.toMatch(/UPDATE\s+turns/);
    expect(stripComments(read('agent/runtime.ts')), 'nor in the reaper').not.toMatch(/UPDATE\s+turns/);
    // ONE statement, two callers — the whole point of selecting and writing through the owner.
    const rec = stripComments(read('agent/v2/turn-record.ts'));
    expect([...rec.matchAll(/exit_reason = 'terminated'/g)].length,
      'one statement, in the one module that writes this table').toBe(1);
  });

  it('the two sites SAY which case each covers — the first cut\'s prose claimed one filled both', () => {
    // Review I-1's second half: the docstrings asserted the reaper filled the whole 279-row
    // population. It covers the >75-minute-stale case only. A comment that outlived its
    // measurement is how the next reader re-derives the gap.
    const rec = read('agent/v2/turn-record.ts');
    expect(rec).toContain('TWO CALLERS, TWO CASES, AND NEITHER COVERS THE OTHER');
    expect(rec).toMatch(/THE >75-MINUTE-STALE CASE ONLY/);
    expect(rec).toMatch(/THE COMMON CRASH/);
    expect(read('agent/runtime.ts'), 'the reaper no longer claims the common case')
      .toMatch(/>75-MINUTE-STALE CASE ONLY/);
    // And neither pretends to drain what already exists.
    expect(rec).toMatch(/population\s*\n?\s*\*?\s*GROWING; they do not drain it/);
  });
});
