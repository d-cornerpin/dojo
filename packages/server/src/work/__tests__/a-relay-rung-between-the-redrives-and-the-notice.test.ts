// UX-REPAIR ROUND 12 / T48 — THE LADDER'S NEW RUNG, AS THE LADDER ITSELF SEES IT.
//
// ── THE DEFECT (round-12 S5, `round12/S5-catalog.md` §8.5–§8.8) ──
// `work/join-drive.ts` climbed redrive ×3 → stuck-notice → platform-trouble. After three
// failed asks it moved to ANNOUNCING failure while the full deliverable content sat in the
// join's landed pieces, already in the engine's hands. Telling the owner "I could not finish
// it" while holding both finished pieces is the shape this rung removes.
//
// ── WHAT IS PINNED HERE AND WHAT IS PINNED NEXT DOOR ──
// This file is the PURE half: the decision function, the structural predicate that gates it,
// and the one preface line the engine is allowed to compose. The delivery itself — the owner
// lane, the ask close, the exactly-once guard — is driven end to end in
// `agent/__tests__/the-engine-ships-the-pieces-itself.test.ts` over the real spine.
//
// requirement preserved: `JOIN_REDRIVE_BOUND` stays 3 and `STUCK_NOTICE_RETRY_BOUND` stays
// carried from `MAX_FLOOR_STEER_ATTEMPTS`. Nothing here moves a threshold (#14); the rung is
// INSERTED between two existing ones and the missing-piece ladder is asserted UNCHANGED.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-join-relay-rung-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  JOIN_REDRIVE_BOUND, STUCK_NOTICE_RETRY_BOUND, ENGINE_RELAY_BOUND, JOIN_DRIVE_ENTRY,
  recordJoinDrive, nextJoinDriveRung, everyPieceLandedWithContent, engineRelayPreface,
} from '../join-drive.js';

const AGENT = 'kevin';
const ASK = 'ask:relay-rung';

/** Spend the whole redrive rung, exactly as `resolveCompilePendingJoins` spends it. */
function exhaustTheRedrives(): void {
  for (let i = 1; i <= JOIN_REDRIVE_BOUND; i++) {
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: i, bound: JOIN_REDRIVE_BOUND, turnNumber: 4900 + i });
  }
}

const landed = (n: number): Array<{ state: string; content: string | null }> =>
  Array.from({ length: n }, (_, i) => ({ state: 'done', content: `piece ${i} body` }));

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

describe('T48: the rung between redrive-exhaustion and the stuck notice', () => {
  it('THE S5 SHAPE: three redrives spent and every piece back with content -> `engine-relay`', () => {
    exhaustTheRedrives();
    const rung = nextJoinDriveRung(ASK, { everyPieceLanded: everyPieceLandedWithContent(landed(2)) });
    expect(rung.rung).toBe('engine-relay');
    expect(rung.attempt).toBe(1);
    expect(rung.bound).toBe(ENGINE_RELAY_BOUND);
    expect(rung.redrives).toBe(JOIN_REDRIVE_BOUND);
  });

  it('the rung is spent ONCE: after it is recorded the ladder resumes at the stuck notice', () => {
    exhaustTheRedrives();
    recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.engineRelay, { attempt: 1, bound: ENGINE_RELAY_BOUND });
    const rung = nextJoinDriveRung(ASK, { everyPieceLanded: true });
    expect(rung.rung).toBe('stuck-notice');
    expect(rung.attempt).toBe(1);
    expect(rung.bound).toBe(STUCK_NOTICE_RETRY_BOUND);
  });

  it('CONTROL — the missing-piece ladder is BYTE-IDENTICAL: no relay rung, stuck-notice then '
    + 'platform-trouble, each on its own bound', () => {
    exhaustTheRedrives();
    // A join that completed with a piece that carried nothing (an abandoned/failed child) is
    // still missing a deliverable. It walks exactly the ladder it walked before T48.
    const missing = [{ state: 'done', content: 'the one that came back' }, { state: 'abandoned', content: null }];
    expect(everyPieceLandedWithContent(missing)).toBe(false);
    for (let i = 1; i <= STUCK_NOTICE_RETRY_BOUND; i++) {
      const r = nextJoinDriveRung(ASK, { everyPieceLanded: everyPieceLandedWithContent(missing) });
      expect(r.rung).toBe('stuck-notice');
      expect(r.attempt).toBe(i);
      expect(r.bound).toBe(STUCK_NOTICE_RETRY_BOUND);
      recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.stuckNotice, { attempt: i, bound: STUCK_NOTICE_RETRY_BOUND });
    }
    expect(nextJoinDriveRung(ASK, { everyPieceLanded: false }).rung).toBe('platform-trouble');
  });

  it('CONTROL — the caller that names nothing gets the pre-T48 ladder, unchanged', () => {
    // `nextJoinDriveRung(workId)` is the pre-T48 call shape. It must never reach the relay.
    exhaustTheRedrives();
    expect(nextJoinDriveRung(ASK).rung).toBe('stuck-notice');
  });

  it('the redrive rung still comes FIRST — the relay never steals a drive the model could use', () => {
    for (let i = 1; i <= JOIN_REDRIVE_BOUND; i++) {
      expect(nextJoinDriveRung(ASK, { everyPieceLanded: true }).rung).toBe('redrive');
      recordJoinDrive(ASK, JOIN_DRIVE_ENTRY.redrive, { attempt: i, bound: JOIN_REDRIVE_BOUND, turnNumber: 5000 + i });
    }
    expect(nextJoinDriveRung(ASK, { everyPieceLanded: true }).rung).toBe('engine-relay');
  });
});

describe('T48: "every piece landed with content" is STRUCTURE, never a reading of the prose', () => {
  it('all done with content -> true; an empty piece, a whitespace piece, a non-done piece -> false', () => {
    expect(everyPieceLandedWithContent(landed(2))).toBe(true);
    expect(everyPieceLandedWithContent(landed(3))).toBe(true);
    expect(everyPieceLandedWithContent([{ state: 'done', content: 'a' }, { state: 'done', content: '' }])).toBe(false);
    expect(everyPieceLandedWithContent([{ state: 'done', content: 'a' }, { state: 'done', content: '   \n ' }])).toBe(false);
    expect(everyPieceLandedWithContent([{ state: 'done', content: 'a' }, { state: 'failed', content: 'a' }])).toBe(false);
    expect(everyPieceLandedWithContent([{ state: 'done', content: 'a' }, { state: 'open', content: 'a' }])).toBe(false);
  });

  it('a join with NO pieces is not a join whose pieces are all back', () => {
    expect(everyPieceLandedWithContent([])).toBe(false);
  });

  it('the predicate reads STATE and CONTENT and nothing else — a hand-off-shaped note that '
    + 'landed as a real piece is not classified by the engine', () => {
    // The prose-classification ban: T43c re-points the join edge on a DECLARED hand-off, so an
    // outstanding hand-off is a piece that never settled. This predicate does not read words.
    expect(everyPieceLandedWithContent([
      { state: 'done', content: 'I passed this to kevin.' },
      { state: 'done', content: 'the actual research' },
    ])).toBe(true);
  });
});

describe('T48: the ONE line the engine composes', () => {
  it('the named preface, verbatim, for the measured two-piece shape', () => {
    expect(engineRelayPreface(2)).toBe(
      'Both results are in as delivered by the helpers — I could not get them combined, '
      + 'so here they are in full:',
    );
  });

  it('the same sentence, count-agreeing, past two — the only variable byte is the quantifier', () => {
    expect(engineRelayPreface(3)).toBe(
      'All 3 results are in as delivered by the helpers — I could not get them combined, '
      + 'so here they are in full:',
    );
    expect(engineRelayPreface(3).slice(engineRelayPreface(3).indexOf(' results are in')))
      .toBe(engineRelayPreface(2).slice(engineRelayPreface(2).indexOf(' results are in')));
  });

  it('0 PREFIX BYTES: the owner-delivery lane carries no engine tag', () => {
    expect(engineRelayPreface(2).startsWith('[')).toBe(false);
    expect(engineRelayPreface(2)).not.toMatch(/^\s*\[(System|Engine)/);
  });
});
