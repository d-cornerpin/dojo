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

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { revertCountExpr, awaitingUserVerdictExpr } from '../tracker-view.js';
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



// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE STAMP IS THE COMPANION'S ID, FOR EVERY WRITER. Migration 189c's trigger stamps a
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




  it('the shared fixture\'s trigger IS the migration\'s trigger (30 fixture-built files rely on it)', () => {
    const body = (src: string): string => {
      const m = /CREATE TRIGGER(?: IF NOT EXISTS)? adjudications_event_seq([\s\S]*?END;)/.exec(src);
      expect(m, 'trigger present').not.toBeNull();
      return m![1].replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    };
    const mig = fs.readFileSync(path.join(SRC, 'db', 'migrations', '189c_verdict_event_sequence.sql'), 'utf8');
    const fixture = fs.readFileSync(path.join(SRC, 'work', '__tests__', 'work-fixture.ts'), 'utf8');
    expect(body(fixture)).toBe(body(mig));
  });

});

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

