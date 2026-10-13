// ════════════════════════════════════════════════════════════════════════════════════════
// t142 — `<state>_validated` IS DECIDED BY THE SEQUENCE, NOT THE CLOCK.
//
// `validatedExpr` scopes a verdict to "at or after the row last entered that state". At
// 00a2b34d it compared `adjudications.created_at >= MAX(work_events.created_at)` — a CLOCK —
// while `work_events` carries a SEQUENCE, against the codebase's own written law
// (`work/override-requests.ts`: "Ordering is by `work_events.id`, never by `created_at` …
// a sequence exists here, so a clock is the wrong instrument").
//
// The defect is a millisecond tie. A block the PM upheld, resolved forward, and then blocked
// AGAIN on a fresh obstacle inside the same millisecond reads as UPHELD: the old verdict
// leaks into the new episode. Three real readers, three wrong answers, driven here:
//
//   · the owner-escalation sentence tells the owner "Your PM checked it and confirmed the
//     block is real" about a block nobody has checked;
//   · the blocked-work disposal door refuses the assignee's own ordinary close-out as if an
//     authority had ruled on it;
//   · the tracker row the board and the PM read reports `blocked_validated = 1`.
//
// The clock is frozen for the whole file (`vi.setSystemTime`), so every write lands in ONE
// millisecond — the tie is the fixture, stated, not raced.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t142-seq-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not under test */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: () => Promise.resolve() }),
}));

import { runMigrations } from '../../db/migrations.js';
import { transition } from '../store.js';
import {
  upholdClaim, setTrackerStatus, throwBackClaim, resetRevertCount, requestUserVerdict, clearUserVerdict,
} from '../tracker-store.js';
import { validatedExpr, taskScope, revertCountExpr, awaitingUserVerdictExpr } from '../tracker-view.js';
import { selectRowsForOwnerEscalation, ownerEscalationAlertLine } from '../validation-drive.js';

const ASSIGNEE = 'quillon';
const PM = 'pm-agent';
const T = 1_700_000_000_000;
const NOW = T + 60 * 60_000;
const CUTOFF = NOW - 5 * 60_000;

function seedWork(id: string): void {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state,
                       intent, wakes, closes_thread, title, priority, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'owner', 'tracker', ?, 'claimed', 'do-it', 1, 0,
             'reconcile the seed-tray inventory', 'normal', ?, ?)`,
  ).run(id, ASSIGNEE, id, T, T);
}

function move(id: string, to: 'blocked' | 'claimed' | 'paused', extra: Record<string, unknown> = {}): void {
  const r = transition(id, {
    to, by: 'agent', actorId: ASSIGNEE, reason: `-> ${to}`,
    note: to === 'blocked' ? 'the inventory spreadsheet is locked by another editor' : undefined,
    ...extra,
  });
  expect(r.kind, `${id} -> ${to}`).toBe('applied');
}

/** The board's / PM's reading of the row, through the one builder every reader calls. */
const validated = (id: string, state: 'blocked' | 'paused' | 'done'): number =>
  (mockDb.current!.prepare(
    `SELECT ${validatedExpr('w', state)} AS v FROM work w WHERE ${taskScope('w')} AND w.id = ?`,
  ).get(id) as { v: number }).v;

/** blocked -> PM upholds -> resolved forward -> blocked AGAIN, all in one millisecond. */
function upheldThenReblocked(id: string): void {
  seedWork(id);
  move(id, 'blocked');
  upholdClaim(id, 'blocked', 'pm', PM, 'PM confirmed the block is real');
  move(id, 'claimed');
  move(id, 'blocked');
  mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(T, id);
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Quillon', 'idle')`).run(ASSIGNEE);
  vi.setSystemTime(new Date(NOW));
});

describe('§1 THE WITNESS: a same-millisecond tie is read by the clock, wrongly', () => {
  it('was RED at 00a2b34d: the board reads a fresh, unchecked block as PM-upheld', () => {
    upheldThenReblocked('t-tie');
    expect(validated('t-tie', 'blocked'), 'the verdict belonged to the PREVIOUS block').toBe(0);
  });

  it('was RED at 00a2b34d: the owner is told "Your PM checked it" about a block nobody checked', () => {
    upheldThenReblocked('t-tie-owner');
    const row = selectRowsForOwnerEscalation(CUTOFF, []).find((r) => r.id === 't-tie-owner');
    expect(row, 'the re-blocked row is a candidate').toBeDefined();
    const line = ownerEscalationAlertLine({
      title: row!.title, status: row!.status, since: row!.updated, agentName: 'Quillon',
      steers: 2, failures: row!.failures, blockedValidated: row!.blocked_validated === 1,
      obstacle: row!.obstacle,
    });
    expect(line).not.toContain('confirmed the block is real');
    expect(line).toContain('has not been able to confirm');
  });

  it('was RED at 00a2b34d: the disposal door refuses the assignee\'s own close-out as "ruled"', () => {
    upheldThenReblocked('t-tie-door');
    // The assignee's own disposal of its own UNRULED block is the normal close-out path the
    // gate promises to leave alone (`blockedDisposalRefusal`: "the normal close-out path").
    const r = setTrackerStatus('t-tie-door', 'cancelled', {
      by: 'agent', actorId: ASSIGNEE, reason: 'the owner withdrew the request; standing it down',
    });
    expect(r.kind, 'the assignee owns an unruled block').toBe('applied');
  });

  it('was RED at 00a2b34d: the same tie on a PAUSE leaks the old blessing too', () => {
    seedWork('t-tie-pause');
    move('t-tie-pause', 'paused');
    upholdClaim('t-tie-pause', 'paused', 'pm', PM, 'the pause is legitimate');
    move('t-tie-pause', 'claimed');
    move('t-tie-pause', 'paused');
    expect(validated('t-tie-pause', 'paused'), 'a fresh pause is unvalidated').toBe(0);
  });
});

describe('§2 THE POSITIVE CONTROLS — the tie must not cost a verdict that IS current', () => {
  it('an uphold in the same millisecond AFTER the entry is current', () => {
    seedWork('t-after');
    move('t-after', 'blocked');
    upholdClaim('t-after', 'blocked', 'pm', PM, 'PM confirmed the block is real');
    expect(validated('t-after', 'blocked')).toBe(1);
  });

  it('an AUTHORITATIVE entry carries its own verdict, in its own unit', () => {
    seedWork('t-auth');
    move('t-auth', 'blocked');
    move('t-auth', 'claimed');
    const r = transition('t-auth', {
      to: 'blocked', by: 'pm', actorId: PM, reason: 'PM forces the block', claim: 'authoritative',
    });
    expect(r.kind).toBe('applied');
    expect(validated('t-auth', 'blocked')).toBe(1);
  });

  it('a re-block AFTER the uphold, then a fresh uphold, is current again', () => {
    upheldThenReblocked('t-again');
    upholdClaim('t-again', 'blocked', 'pm', PM, 'PM checked the new obstacle too');
    expect(validated('t-again', 'blocked')).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE STAMP IS THE COMPANION'S ID, FOR EVERY WRITER. Migration 189b's trigger stamps a
// verdict with the id the NEXT work_events row receives; that is only the companion's id while
// every writer appends its companion immediately after the verdict, in the same unit. Driven
// for each writer, so a writer that ever slips an event in between reds HERE instead of
// silently mis-positioning verdicts.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 every adjudication writer\'s verdict sits exactly on its companion event', () => {
  const lastAdj = (id: string) => mockDb.current!.prepare(
    'SELECT event_seq, claim_state, verdict FROM adjudications WHERE work_id = ? ORDER BY id DESC LIMIT 1',
  ).get(id) as { event_seq: number | null; claim_state: string; verdict: string };
  const lastEvent = (id: string) => mockDb.current!.prepare(
    'SELECT id, kind FROM work_events WHERE work_id = ? ORDER BY id DESC LIMIT 1',
  ).get(id) as { id: number; kind: string };

  it('transition() — an authoritative move files its verdict on its own transition row', () => {
    seedWork('w-auth');
    const r = transition('w-auth', {
      to: 'blocked', by: 'pm', actorId: PM, reason: 'PM forces the block', claim: 'authoritative',
    });
    expect(r.kind).toBe('applied');
    const ev = lastEvent('w-auth');
    expect(ev.kind).toBe('transition');
    expect(lastAdj('w-auth').event_seq).toBe(ev.id);
  });

  it('upholdClaim — the verdict sits on its claim_upheld row', () => {
    seedWork('w-uphold');
    move('w-uphold', 'blocked');
    upholdClaim('w-uphold', 'blocked', 'pm', PM, 'confirmed');
    const ev = lastEvent('w-uphold');
    expect(ev.kind).toBe('claim_upheld');
    expect(lastAdj('w-uphold').event_seq).toBe(ev.id);
  });

  it('rejectClaim — the verdict sits on its claim_rejected row', () => {
    seedWork('w-reject');
    move('w-reject', 'blocked');
    throwBackClaim('w-reject', 'blocked', 'pm', PM, 'not a real block; try the read-only export');
    const ev = lastEvent('w-reject');
    expect(ev.kind).toBe('claim_rejected');
    const adj = lastAdj('w-reject');
    expect(adj.verdict).toBe('rejected');
    expect(adj.event_seq).toBe(ev.id);
  });

  it('no verdict is ever left unpositioned', () => {
    upheldThenReblocked('w-any');
    const n = mockDb.current!.prepare('SELECT COUNT(*) AS n FROM adjudications WHERE event_seq IS NULL')
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE CENSUS. Every `<state>_validated` reader in production goes through the ONE
// builder, so the conversion is one place; this pins the set of readers BOTH ways (a new
// reader, or a lost one, changes the count and a reviewer has to look), and pins that no
// production SQL compares an adjudication's CLOCK any more. Comments are stripped first, so
// prose describing a call is never counted as one (G4).
// ════════════════════════════════════════════════════════════════════════════════════════

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
const productionSources = new Map<string, string>();
beforeAll(() => {
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'migrations') continue;
        walk(fp);
      } else if (e.name.endsWith('.ts')) {
        productionSources.set(path.relative(SRC, fp).split(path.sep).join('/'),
          stripComments(fs.readFileSync(fp, 'utf8')));
      }
    }
  };
  walk(SRC);
});

/** The `<state>_validated` readers at the t142 head, by file. Every one calls the builder. */
const VALIDATED_READERS: Record<string, number> = {
  'tracker/pm-agent.ts': 4,
  'tracker/tools.ts': 7,
  'work/tracker-store.ts': 1,
  'work/tracker-view.ts': 5,
  'work/validation-drive.ts': 2,
};

describe('§4 census: one builder, every reader, no clock', () => {
  it('the readers are exactly these, in both directions', () => {
    const found: Record<string, number> = {};
    for (const [file, src] of productionSources) {
      // The definition is spelled `validatedExpr = (`, so only CALLS match.
      const n = (src.match(/\bvalidatedExpr\(/g) ?? []).length;
      if (n > 0) found[file] = n;
    }
    expect(found).toEqual(VALIDATED_READERS);
  });

  it('the walk is not vacuous: it read the tree and found the builder', () => {
    expect(productionSources.size).toBeGreaterThan(300);
    expect(productionSources.get('work/tracker-view.ts')).toContain('export const validatedExpr = (');
  });

  it('no production SQL compares an adjudication by its clock', () => {
    const hits: string[] = [];
    for (const [file, src] of productionSources) {
      if (/\badj\w*\.created_at\s*(>=|<=|>|<|=)/.test(src)
        || /(>=|<=|>|<)\s*\w*adj\w*\.created_at\b/.test(src)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });

  it('THE APPLICATION, not the prose: the built clause compares event_seq to an event id', () => {
    for (const state of ['blocked', 'paused', 'done'] as const) {
      const sql = validatedExpr('w', state);
      expect(sql).toContain("adj.event_seq >= COALESCE((SELECT MAX(e.id) FROM work_events e");
      expect(sql).toContain(`json_extract(e.payload, '$.to') = '${state}'`);
      expect(sql, 'no clock anywhere in the freshness clause').not.toMatch(/created_at/);
    }
    const disposal = validatedExpr('w', 'blocked', { excludeSystemClosers: true });
    expect(disposal).toContain('adj.event_seq >= ');
    expect(disposal).toContain('NOT IN');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE CENSUS FOUND TWO MORE CLOCKS IN THE SAME FILE, SAME LAW. Neither is a
// `<state>_validated` reader, both read the same event log by instant, and both decide what
// the PM and the owner are shown: the stalemate counter (`revert_count` drives the
// owner-verdict threshold, high=2 / normal=3 / low=5) and the "awaiting the owner's verdict"
// hold (which takes a row OUT of the PM's and the escalation sweep's sight). Fixed in-flight
// per the owner's v3.3 ruling ("if we find new bugs on the way, we fix them").
// ════════════════════════════════════════════════════════════════════════════════════════

const revertCount = (id: string): number =>
  (mockDb.current!.prepare(`SELECT ${revertCountExpr('w')} AS n FROM work w WHERE w.id = ?`)
    .get(id) as { n: number }).n;
const awaiting = (id: string): number =>
  (mockDb.current!.prepare(`SELECT ${awaitingUserVerdictExpr('w')} AS n FROM work w WHERE w.id = ?`)
    .get(id) as { n: number }).n;

describe('§5 the stalemate counter and the verdict hold are read by sequence too', () => {
  it('a rejection BEFORE a same-millisecond reset is not counted after it', () => {
    seedWork('r-tie');
    move('r-tie', 'blocked');
    throwBackClaim('r-tie', 'blocked', 'pm', PM, 'not a real block; try the read-only export');
    resetRevertCount('r-tie', 'owner', 'the owner ruled; the count starts again');
    expect(revertCount('r-tie'), 'the reset came after the rejection').toBe(0);
  });

  it('CONTROL: a rejection AFTER a same-millisecond reset IS counted', () => {
    seedWork('r-after');
    move('r-after', 'blocked');
    resetRevertCount('r-after', 'owner', 'fresh start');
    throwBackClaim('r-after', 'blocked', 'pm', PM, 'not a real block; try the read-only export');
    expect(revertCount('r-after')).toBe(1);
  });

  it('a verdict request filed AFTER a same-millisecond clear is still awaiting', () => {
    seedWork('v-tie');
    requestUserVerdict('v-tie', 'engine', { reverts: 3 });
    clearUserVerdict('v-tie', 'owner', 'answered');
    requestUserVerdict('v-tie', 'engine', { reverts: 3 });
    expect(awaiting('v-tie'), 'the newest request has no answer after it').toBe(1);
  });

  it('CONTROL: a clear AFTER a same-millisecond request ends the hold', () => {
    seedWork('v-clear');
    requestUserVerdict('v-clear', 'engine', { reverts: 3 });
    clearUserVerdict('v-clear', 'owner', 'answered');
    expect(awaiting('v-clear')).toBe(0);
  });
});
