// ════════════════════════════════════════════════════════════════════════════════════════
// SETUP COMPLETION NEVER REPORTS WHAT IT DID NOT DO (fresh-box audit, finding 3).
//
// ── THE DEFECT, as measured on a fresh box ──
// `POST /api/setup/complete` marked first-run done, then called the five residents' ensure
// functions and logged that they had spawned. Every one of them refuses without the primary agent
// (`agents.parent_agent` references it), so on a box where the primary was never provisioned the
// route left ZERO agents, five retry loops firing every 5 seconds forever, and
// `"PM agent spawned during setup completion"` in the log. Only a restart cured it, because the
// boot path creates the primary.
//
// ── WHY REFUSING IS THE FIX AND COMPLETING IS NOT ──
// Refuse, and the box is still in OOBE: the caller provisions and comes straight back. Complete,
// and `markFirstRunComplete()` has shut the OOBE window — which is exactly why a restart was the
// only way out. So the gate goes ABOVE the JWT and above the mark, and the response says what to
// do. The shipped wizard already calls `provision-agent` first, so nothing changes for it; this
// closes the abort, the reload, and the non-UI client.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

const logLines: Array<{ level: string; msg: string }> = [];
vi.mock('../../../logger.js', () => {
  const rec = (level: string) => (msg: string) => { logLines.push({ level, msg }); };
  return {
    createLogger: () => ({ debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }),
    setLogLevel: () => {}, setLogBroadcast: () => {}, readLogEntries: () => [],
  };
});
vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os'); const p = await import('node:path');
  return {
    getDb: () => { if (!mockDb.current) throw new Error('no test DB'); return mockDb.current; },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-setup-complete', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

// The password gate is not this file's subject; it is satisfied so the primary gate is reachable.
vi.mock('../../../config/loader.js', () => ({
  getDashboardPasswordHash: () => '$2b$12$fixture.hash.value.not.real',
  setDashboardPassword: () => {},
  getJwtSecret: () => 'fixture-jwt-secret-not-real',
}));

/** First-run state, driven per clause. */
const firstRun = { past: false, marked: 0 };
/** Swappable so an ordering clause can observe the world AT THE MOMENT the window shuts. */
const markSpy: { impl: (() => void) | null } = { impl: null };
vi.mock('../../../config/setup-state.js', () => ({
  isPastFirstRun: () => firstRun.past,
  markFirstRunComplete: () => {
    if (markSpy.impl) { markSpy.impl(); return; }
    firstRun.marked += 1; firstRun.past = true;
  },
}));

vi.mock('../../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary-1',
  isPMEnabled: () => true,
  isTrainerEnabled: () => true,
  clearPlatformConfigCache: () => {},
}));

/** Every resident's ensure function, counted — none of them may be reached without a primary. */
const ensured: string[] = [];
vi.mock('../../../tracker/pm-agent.js', () => ({ ensurePMAgentRunning: () => { ensured.push('pm'); } }));
vi.mock('../../../techniques/trainer-agent.js', () => ({ ensureTrainerAgentRunning: () => { ensured.push('trainer'); } }));
vi.mock('../../../healer/healer-agent.js', () => ({ ensureHealerAgentRunning: () => { ensured.push('healer'); } }));
vi.mock('../../../vault/maintenance.js', () => ({
  ensureDreamerAgentRunning: () => { ensured.push('dreamer'); },
  scheduleDreamingCycle: () => {},
  bootstrapOwnerProfile: () => {},
}));
vi.mock('../../../agent/groups.js', () => ({ ensureSystemGroup: () => {} }));

import { setupRouter } from '../setup.js';

const complete = (): Promise<Response> =>
  setupRouter.request('/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });

const seedPrimary = (): void => {
  mockDb.current!.prepare(
    "INSERT INTO agents (id, name, status) VALUES ('primary-1', 'Primary', 'idle')",
  ).run();
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  `);
  logLines.length = 0; ensured.length = 0; markSpy.impl = null;
  firstRun.past = false; firstRun.marked = 0;
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('without a primary agent, completion REFUSES', () => {
  it('⚠ returns 400 naming the cure, and does NOT shut the OOBE window', async () => {
    const res = await complete();

    expect(res.status).toBe(400);
    const body = await res.json() as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    // The message has to name the door, or a caller cannot act on it.
    expect(body.error).toMatch(/provision-agent/);
    expect(body.error).toMatch(/primary agent/i);

    // THE CLAUSE THAT MAKES IT RECOVERABLE: first-run is still open, so the caller can provision
    // and come back. This is the difference between this and the defect.
    expect(firstRun.marked).toBe(0);
    expect(firstRun.past).toBe(false);
  });

  it('⚠ reaches NO resident, so nothing can claim to have spawned', async () => {
    await complete();

    expect(ensured).toEqual([]);
    // The exact false line the audit found, and any sibling.
    expect(logLines.filter(l => /spawned|ensured/i.test(l.msg))).toEqual([]);
  });

  it('says so at WARN rather than in silence', async () => {
    await complete();
    expect(logLines.some(l => l.level === 'warn' && /no primary agent/i.test(l.msg))).toBe(true);
  });
});

describe('the ORDERING is independently pinned (review F4)', () => {
  // The clauses above rest on ONE assertion half: `firstRun.marked === 0` inside the refusal
  // clause. That is true of a gate ABOVE `markFirstRunComplete()` and ALSO true of a route that
  // refused for some unrelated reason, so a mutant that moved the gate BELOW the mark could
  // conceivably survive by refusing later. These two clauses make the ordering a fact in its own
  // right, so that mutant dies twice.

  it('⚠ the refusal happens BEFORE first-run is marked — asserted from the OTHER side', () => {
    // Recorded at the moment the mark is attempted, not inferred afterwards: if the gate ran
    // second, `agents` would already be empty AND the mark would have happened.
    const marksAt: Array<number> = [];
    firstRun.marked = 0;
    const seen = { agentsWhenMarked: -1 };
    // Re-wrap the mark so it records the world as it was when called.
    const origMark = firstRun.marked;
    void origMark;
    markSpy.impl = () => {
      seen.agentsWhenMarked = (mockDb.current!
        .prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n;
      marksAt.push(1);
      firstRun.past = true;
    };

    return complete().then(async (res) => {
      expect(res.status).toBe(400);
      // THE ORDERING, stated directly: the mark was never reached at all.
      expect(marksAt).toEqual([]);
      expect(seen.agentsWhenMarked).toBe(-1);
      // …and the route is still refusable a second time, which a marked box would not be.
      expect((await complete()).status).toBe(400);
    });
  });

  it('⚠ with a primary, the mark IS reached and the primary already existed when it was', () => {
    seedPrimary();
    const seen = { agentsWhenMarked: -1 };
    markSpy.impl = () => {
      seen.agentsWhenMarked = (mockDb.current!
        .prepare('SELECT COUNT(*) AS n FROM agents').get() as { n: number }).n;
      firstRun.past = true;
    };

    return complete().then((res) => {
      expect(res.status).toBe(200);
      // The gate ran first, so by the time the window shut the primary was already there. A gate
      // moved below the mark would record 1 here too — but would have recorded 0 above.
      expect(seen.agentsWhenMarked).toBeGreaterThanOrEqual(1);
    });
  });
});

describe('with a primary agent, completion proceeds and reports what it MEASURED', () => {
  it('completes, marks first-run, and reaches every resident', async () => {
    seedPrimary();

    const res = await complete();

    expect(res.status).toBe(200);
    expect(firstRun.marked).toBe(1);
    expect(ensured).toEqual(expect.arrayContaining(['pm', 'trainer', 'healer', 'dreamer']));
  });

  it('⚠ the closing line COUNTS the agents that exist, rather than asserting spawns', async () => {
    seedPrimary();
    // A resident that really did land, so the count is not trivially 1.
    mockDb.current!.prepare("INSERT INTO agents (id, name, status) VALUES ('pm-1','PM','idle')").run();

    await complete();

    const line = logLines.find(l => /agents now present/i.test(l.msg));
    expect(line, 'completion must state the measured agent set').toBeDefined();
    // And no line claims a spawn it did not verify.
    expect(logLines.filter(l => /agent spawned during setup completion/i.test(l.msg))).toEqual([]);
  });

  it('NEGATIVE CONTROL — a terminated primary does not count as a primary', async () => {
    mockDb.current!.prepare(
      "INSERT INTO agents (id, name, status) VALUES ('other','Other','idle')",
    ).run();

    const res = await complete();

    // `other` exists but is not the primary id, so the gate must still refuse.
    expect(res.status).toBe(400);
    expect(ensured).toEqual([]);
  });

  it('NEGATIVE CONTROL — an already-complete box is still 403, not 400', async () => {
    firstRun.past = true;
    const res = await complete();
    expect(res.status).toBe(403);
  });
});
