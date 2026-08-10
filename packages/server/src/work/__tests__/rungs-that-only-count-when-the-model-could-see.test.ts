// UX-REPAIR ROUND 2 / T10 — A RUNG IS SPENT ONLY WHEN THE MODEL HAD A TURN TO SPEND IT ON.
//
// ── THE DEFECT (investigation-round2.md §1, measured on the box) ──
// The join ladder's counter is a COUNT of `join_redrive` audit rows. On S4 (2026-08-10) the
// reaper fired one at 06:17:10 while turn 4553 was still running and the turn-end drain fired
// another at 06:18:01 — two rungs of three, neither of which the model could act on, because
// the compile order was not in either turn's assembled context. A ladder whose rungs a sweep
// can burn between turns is not a ladder.
//
// ── THE DISCIPLINE, CARRIED NOT INVENTED ──
// `work/run-deliver-drive.ts:76-92` already solved this exact class after run `bmslqef2w3r`
// burned a whole ladder in ten seconds: it counts DISTINCT TURNS, not rows. This file pins the
// same unit on the join ladder, plus the two things that make the accounting readable — a
// visible `join_redrive_deferred` marker for the pass that did not spend a rung, and the
// attempt signal in the steer text itself (`run-deliver-drive.ts:196` already does this; the
// join steer was byte-identical on all four sends, so the model was never told it was attempt
// 2 or 3).
//
// requirement preserved (`join-drive.ts:24-27`, pinned at `join-settlement.test.ts:742`):
// JOIN_REDRIVE_BOUND stays 3. Nothing here moves a threshold (#14).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-join-rung-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  JOIN_REDRIVE_BOUND, STUCK_NOTICE_RETRY_BOUND, JOIN_DRIVE_ENTRY,
  joinDriveCount, recordJoinDrive, nextJoinDriveRung, joinRedriveIsBlind, compileSteerText,
} from '../join-drive.js';

const AGENT = 'kevin';
const ASK = 'ask:rung-test';

const auditEntries = (workId: string): Array<{ entry_kind: string; turn_number: number | null }> =>
  (mockDb.current!.prepare(
    `SELECT json_extract(payload,'$.entry_kind') AS entry_kind,
            json_extract(payload,'$.turn_number') AS turn_number
       FROM work_events WHERE work_id = ? AND kind = 'audit' ORDER BY id`,
  ).all(workId) as Array<{ entry_kind: string; turn_number: number | null }>);

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`).run(AGENT);
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, opened_at, updated_at, title)
     VALUES (?, 'ask', ?, 'owner', 'ask', ?, 'claimed', 'ask',
             0, 0, 1786000000000, 1786000000000, 'the owner ask')`,
  ).run(ASK, AGENT, ASK);
});

describe('T10: a rung is spent only on a pass the model could act on', () => {
  it('THE S4 SHAPE: the reaper mid-turn, then the turn-end drain of that SAME turn — the second '
    + 'pass is blind and does not spend', () => {
    // 06:17:10 reaper tick, turn 4553 in flight: the first real placement of the owed step.
    expect(joinRedriveIsBlind(ASK, 4553)).toBe(false);
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: 1, bound: JOIN_REDRIVE_BOUND, turnNumber: 4553 });
    // 06:18:01 turn 4553's own end — the model has not run a turn since the steer landed.
    expect(joinRedriveIsBlind(ASK, 4553)).toBe(true);
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redriveDeferred, { attempt: 1, bound: JOIN_REDRIVE_BOUND, turnNumber: 4553 });
    // 06:19:50 turn 4554's end — a turn HAS run with the steer in its context.
    expect(joinRedriveIsBlind(ASK, 4554)).toBe(false);
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: 2, bound: JOIN_REDRIVE_BOUND, turnNumber: 4554 });

    expect(joinDriveCount(ASK, JOIN_DRIVE_ENTRY.redrive)).toBe(2);
    expect(nextJoinDriveRung(ASK)).toMatchObject({ rung: 'redrive', attempt: 3 });
    // the deferral is VISIBLE on the row's own history, not an absence
    expect(auditEntries(ASK).map((e) => e.entry_kind))
      .toEqual(['join_redrive', 'join_redrive_deferred', 'join_redrive']);
  });

  it('drives on separate turns each spend their own rung, and the bound still lands at 3', () => {
    for (const turn of [4553, 4554, 4555]) {
      expect(joinRedriveIsBlind(ASK, turn)).toBe(false);
      const d = nextJoinDriveRung(ASK);
      expect(d.rung).toBe('redrive');
      recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: d.attempt, bound: d.bound, turnNumber: turn });
    }
    expect(joinDriveCount(ASK, JOIN_DRIVE_ENTRY.redrive)).toBe(JOIN_REDRIVE_BOUND);
    expect(nextJoinDriveRung(ASK).rung).toBe('stuck-notice');
  });

  it('THE STALL GUARD: a turn gets ONE deferral, then the ladder accepts the key is not moving', () => {
    // The last rung exists for an agent that is not speaking at all — and that agent's turn key
    // never moves. If "wait for a new turn" were unbounded, the ladder would go silent for
    // exactly the case it was built to catch. One grace pass, then it spends.
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: 1, bound: JOIN_REDRIVE_BOUND, turnNumber: 7 });
    expect(joinRedriveIsBlind(ASK, 7)).toBe(true);
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redriveDeferred, { attempt: 1, bound: JOIN_REDRIVE_BOUND, turnNumber: 7 });
    expect(joinRedriveIsBlind(ASK, 7)).toBe(false);
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: 2, bound: JOIN_REDRIVE_BOUND, turnNumber: 7 });
    expect(joinRedriveIsBlind(ASK, 7)).toBe(false);
  });

  it('a pass with no turn number at all is never treated as blind (it can never be free)', () => {
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: 1, bound: JOIN_REDRIVE_BOUND });
    expect(joinRedriveIsBlind(ASK, null)).toBe(false);
  });

  it('the blind test is scoped to its own row and its own marker', () => {
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.stuckNotice, { attempt: 1, bound: STUCK_NOTICE_RETRY_BOUND, turnNumber: 9 });
    expect(joinRedriveIsBlind(ASK, 9)).toBe(false);
  });

  it('BACK-COMPAT: the counter is still a plain COUNT, so nothing on a lived-in body is handed back', () => {
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: 1, bound: JOIN_REDRIVE_BOUND });
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: 2, bound: JOIN_REDRIVE_BOUND });
    expect(joinDriveCount(ASK, JOIN_DRIVE_ENTRY.redrive)).toBe(2);
  });

  it('a deferred pass is not counted as a redrive by the ladder', () => {
    for (let i = 0; i < 5; i++) {
      recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redriveDeferred, { attempt: 1, bound: JOIN_REDRIVE_BOUND, turnNumber: 4553 });
    }
    expect(joinDriveCount(ASK, JOIN_DRIVE_ENTRY.redrive)).toBe(0);
    expect(nextJoinDriveRung(ASK)).toMatchObject({ rung: 'redrive', attempt: 1 });
  });

  it('the stuck-notice rung keeps its own bound and its own marker', () => {
    for (const turn of [1, 2, 3]) {
      recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: 1, bound: JOIN_REDRIVE_BOUND, turnNumber: turn });
    }
    const d = nextJoinDriveRung(ASK);
    expect(d.rung).toBe('stuck-notice');
    expect(d.bound).toBe(STUCK_NOTICE_RETRY_BOUND);
  });
});

describe('T10: the compile steer tells the model which attempt this is, and asks for the owner FIRST', () => {
  const pieces = ['Piece 1 (from Ticky, thread 1a952a39): "Squarespace is $276/yr"',
                  'Piece 2 (from Kevin, thread 34430191): "WordPress needs hosting"'];

  it('a redrive states its attempt and its bound, exactly as the sibling ladder does', () => {
    const text = compileSteerText({ total: 2, pieces, attempt: 2, bound: JOIN_REDRIVE_BOUND });
    expect(text).toContain('steer 2 of 3');
  });

  it('the join-completion steer carries no attempt signal (no rung has been spent yet)', () => {
    const text = compileSteerText({ total: 2, pieces, attempt: null, bound: JOIN_REDRIVE_BOUND });
    expect(text).not.toContain('steer');
  });

  it('THE IMPERATIVE COMES FIRST, before the quoted pieces', () => {
    // The events lane renders an awareness row as a 400-char gist (`memory/lanes.ts:308`,
    // applied at `assembler.ts:1099-1111`), so an order whose instruction sits AFTER two
    // 1,200-char piece quotes is cut off before the model reaches it. Measured on S4: the
    // model quoted only the steer's opening sentence and went to `history_get` for the rest.
    const text = compileSteerText({ total: 2, pieces, attempt: 1, bound: JOIN_REDRIVE_BOUND });
    const order = text.indexOf('Compose ONE reply to the owner now');
    const firstPiece = text.indexOf('Piece 1');
    expect(order).toBeGreaterThanOrEqual(0);
    expect(firstPiece).toBeGreaterThanOrEqual(0);
    expect(order).toBeLessThan(firstPiece);
    expect(text.slice(0, 400)).toContain('Compose ONE reply to the owner now');
  });

  it('every recorded requirement of the steer text survives', () => {
    const text = compileSteerText({ total: 2, pieces, attempt: 1, bound: JOIN_REDRIVE_BOUND });
    // incident-derived wording, carried unchanged (bmrpxzuhxvh, bmrplgdg33l)
    expect(text).toContain('The owner has NOT been answered yet');
    expect(text).toContain('character for character');
    expect(text).toContain('Do NOT search, open files, run commands, or call any tools first');
    expect(text).toContain('If a piece reads as a failure, say so honestly in the same reply');
    // the pieces are still quoted VERBATIM
    for (const p of pieces) expect(text).toContain(p);
  });
});
