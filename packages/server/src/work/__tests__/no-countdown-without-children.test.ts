// ════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 item 5, BATCH C — NO COUNTDOWN WITHOUT CHILDREN.
//
// The orchestrator's post-TB3 adjudication (SWEEP-A §POST-TB3 item 4), from TB3 §8.4:
//
//   > 14 `done` asks carry `remaining_children > 0` with ZERO child rows — a countdown that
//   > can never reach zero. All 14 have finalized serving turns, so the crash-window arm can
//   > never see them and they cannot storm; they are simply a shape the ledger should not
//   > contain. Item: a structural invariant (no countdown without children) + a one-shot
//   > dated clear, same non-falsifying shape as the orphan-flag clear.
//
// ── WHERE THE FOURTEEN CAME FROM, TRACED AT `e1108c7` RATHER THAN GUESSED ──
// `ask:7a4810b1…` carries `remaining_children = 2`; its own `join_opened` events name two
// threads; the two `piece:` rows those threads mint are GONE, and so are their `work_events`.
// The producer is the HARNESS TEARDOWN, not the product: `dojo-test-kit/behavioral/runner.mjs`
// (~:119) deletes `work` rows whose `result_delivery_id` belongs to a swept peer and whose
// agent is a harness agent — which is exactly a settled join PIECE — while the PARENT ask,
// whose receipt is its own delivery, survives with its countdown. All 14 are on the harness
// bot. That is why this file's invariant is a CENSUS and not a schema trigger: the only
// producer on this box is an out-of-process teardown, and a refusing trigger would abort the
// harness sweep (migration 151's own comment records that exact abort, one class earlier).
//
// ── AND THE PRODUCT'S OWN PATH TO THE SAME SHAPE, WHICH IS CLOSED HERE ──
// `openDelegationJoin` wrote `remaining_children = ids.length` where `ids` was pushed to
// UNCONDITIONALLY after an `INSERT OR IGNORE` — the silent-discard class `insertMessage`'s own
// R1 header names ("IGNORE swallows NOT NULL and CHECK failures as well as UNIQUE ones"). The
// countdown counted children ATTEMPTED. It now counts the children that actually EXIST and
// are still open, which is the same number on every ordinary open and a smaller, truthful one
// otherwise.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-phantom-countdown-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  openAsk, openDelegationJoin, phantomCountdownCensus, clearPhantomCountdowns, joinState,
} from '../store.js';

const AGENT = 'kevin';
const CONV = 'conv-1';
const NOW = 1786000000000;

const db = (): Database.Database => mockDb.current!;

/** A real owner ask on a real root message — the parent every join hangs from. */
const seedAsk = (id: string): string => {
  db().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, lane, role, content, channel,
                           sender_id, authorized, token_count, created_at, sent_at)
     VALUES (?, ?, ?, 'owner', 'user', 'do the thing', 'dashboard', 'owner', 1, 1, ?, ?)`,
  ).run(id, AGENT, CONV, NOW, NOW);
  return openAsk({
    agentId: AGENT, messageId: id, conversationId: CONV, requesterId: 'owner',
    openedAt: NOW, title: 'seeded',
  });
};

/** Close a row the way the ledger really does — `done` needs a receipt and a closed_at.
 *  One delivery per row, because `deliveries.id` is unique and two asks are two answers. */
let deliverySeq = 0;
const markDone = (workId: string): void => {
  const deliveryId = `d-${++deliverySeq}`;
  db().prepare(
    `INSERT INTO deliveries (id, agent_id, conversation_id, tool, channel, outcome, created_at)
     VALUES (?, ?, ?, 'chat', 'dashboard', 'delivered', ?)`,
  ).run(deliveryId, AGENT, CONV, NOW);
  db().prepare(
    `UPDATE work SET state = 'done', closed_at = ?, result_delivery_id = ? WHERE id = ?`,
  ).run(NOW, deliveryId, workId);
};

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  deliverySeq = 0;
  runMigrations();
  d.pragma('foreign_keys = ON');
  d.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Kevin', 'idle')`).run(AGENT);
  d.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id)
     VALUES (?, ?, 'dashboard', 'owner')`,
  ).run(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE STRUCTURAL INVARIANT — a census that must be empty
// ════════════════════════════════════════════════════════════════════════════════

describe('no countdown without children', () => {
  it('names a row whose countdown outlived every child it was counting', () => {
    const ask = seedAsk('m-1');
    openDelegationJoin({
      agentId: AGENT, parentWorkId: ask, replyConversationId: CONV, ttlAt: NOW + 3_600_000,
      threads: [{ threadId: 't-1' }, { threadId: 't-2' }],
    });
    markDone(ask);
    expect(phantomCountdownCensus()).toEqual([]);            // children still there: legitimate
    db().prepare(`DELETE FROM work_events WHERE work_id LIKE 'piece:%'`).run();
    db().prepare(`DELETE FROM work WHERE parent_id = ?`).run(ask);   // the harness teardown's shape
    expect(phantomCountdownCensus()).toEqual([{ id: ask, remainingChildren: 2 }]);
  });

  it('is EMPTY for a live join whose children are all still there', () => {
    const ask = seedAsk('m-2');
    openDelegationJoin({
      agentId: AGENT, parentWorkId: ask, replyConversationId: CONV, ttlAt: NOW + 3_600_000,
      threads: [{ threadId: 't-1' }],
    });
    expect(phantomCountdownCensus()).toEqual([]);
  });

  it('is EMPTY for a row that never had a countdown at all', () => {
    seedAsk('m-3');
    expect(phantomCountdownCensus()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · THE CLEAR — dated, recorded, and it falsifies nothing
// ════════════════════════════════════════════════════════════════════════════════

describe('the phantom-countdown clear', () => {
  const seedPhantom = (msgId: string): string => {
    const ask = seedAsk(msgId);
    openDelegationJoin({
      agentId: AGENT, parentWorkId: ask, replyConversationId: CONV, ttlAt: NOW + 3_600_000,
      threads: [{ threadId: `${msgId}-t1` }],
    });
    markDone(ask);
    db().prepare(`DELETE FROM work_events WHERE work_id LIKE 'piece:%'`).run();
    db().prepare(`DELETE FROM work WHERE parent_id = ?`).run(ask);
    return ask;
  };

  it('clears the countdown and reports its denominator', () => {
    seedPhantom('m-1');
    seedPhantom('m-2');
    expect(phantomCountdownCensus()).toHaveLength(2);
    expect(clearPhantomCountdowns().cleared).toBe(2);
    expect(phantomCountdownCensus()).toEqual([]);
  });

  it('FALSIFIES NOTHING: the state, the receipt and the close time are untouched', () => {
    const ask = seedPhantom('m-1');
    const before = db().prepare('SELECT state, closed_at, result_delivery_id FROM work WHERE id = ?').get(ask);
    clearPhantomCountdowns();
    const after = db().prepare('SELECT state, closed_at, result_delivery_id FROM work WHERE id = ?').get(ask);
    expect(after).toEqual(before);
  });

  it('is a RECORDED move, DATED, with its reason — never a silent UPDATE', () => {
    const ask = seedPhantom('m-1');
    clearPhantomCountdowns();
    const ev = db().prepare(
      `SELECT kind, actor, payload, created_at FROM work_events
        WHERE work_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(ask) as { kind: string; actor: string; payload: string; created_at: number };
    expect(ev.kind).toBe('audit');
    const p = JSON.parse(ev.payload) as { marker: string; remaining_children: number; reason: string };
    expect(p.marker).toBe('phantom_countdown_cleared');
    expect(p.remaining_children).toBe(1);      // what it said before, kept on the record
    expect(p.reason).toMatch(/no child rows/i);
    expect(ev.created_at).toBeGreaterThan(0);  // dated
  });

  it('is idempotent — the second pass finds nothing, by predicate and not by bookkeeping', () => {
    seedPhantom('m-1');
    expect(clearPhantomCountdowns().cleared).toBe(1);
    expect(clearPhantomCountdowns().cleared).toBe(0);
  });

  it('leaves a LIVE join alone — a real countdown is not a phantom', () => {
    const ask = seedAsk('m-2');
    openDelegationJoin({
      agentId: AGENT, parentWorkId: ask, replyConversationId: CONV, ttlAt: NOW + 3_600_000,
      threads: [{ threadId: 't-1' }, { threadId: 't-2' }],
    });
    expect(clearPhantomCountdowns().cleared).toBe(0);
    expect(joinState(ask)?.remaining).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · THE PRODUCT'S OWN PATH TO THE CLASS, CLOSED AT THE WRITER
// ════════════════════════════════════════════════════════════════════════════════

describe('openDelegationJoin counts the children that EXIST, never the ones attempted', () => {
  it('an ordinary open is unchanged — N threads, N children, countdown N', () => {
    const ask = seedAsk('m-1');
    const ids = openDelegationJoin({
      agentId: AGENT, parentWorkId: ask, replyConversationId: CONV, ttlAt: NOW + 3_600_000,
      threads: [{ threadId: 't-1' }, { threadId: 't-2' }, { threadId: 't-3' }],
    });
    expect(ids).toHaveLength(3);
    expect(joinState(ask)?.remaining).toBe(3);
    expect(
      db().prepare('SELECT count(*) AS n FROM work WHERE parent_id = ?').get(ask),
    ).toEqual({ n: 3 });
    expect(phantomCountdownCensus()).toEqual([]);
  });

  it('a child that did NOT land is not counted, and the ids do not claim it either', () => {
    const ask = seedAsk('m-1');
    // The silent-discard shape, forced at the seam that produces it: the row for `t-2` is
    // already present under a DIFFERENT parent, so `INSERT OR IGNORE` is a no-op for this one
    // and the countdown must not include it.
    const other = seedAsk('m-2');
    db().prepare(
      `INSERT INTO work (id, kind, parent_id, agent_id, requester, requester_id, root_kind,
                         root_id, state, intent, wakes, closes_thread, opened_at, updated_at)
       VALUES (?, 'task', ?, ?, 'agent', ?, 'a2a_thread', 't-2', 'open', 'ASSIGN', 1, 0, ?, ?)`,
    ).run(`piece:${ask}:t-2`, other, AGENT, AGENT, NOW, NOW);

    const ids = openDelegationJoin({
      agentId: AGENT, parentWorkId: ask, replyConversationId: CONV, ttlAt: NOW + 3_600_000,
      threads: [{ threadId: 't-1' }, { threadId: 't-2' }],
    });
    expect(ids).toEqual([`piece:${ask}:t-1`]);
    expect(joinState(ask)?.remaining).toBe(1);
  });

  it('a re-open does not double-count a sibling that has already settled', () => {
    const ask = seedAsk('m-1');
    openDelegationJoin({
      agentId: AGENT, parentWorkId: ask, replyConversationId: CONV, ttlAt: NOW + 3_600_000,
      threads: [{ threadId: 't-1' }],
    });
    db().prepare(
      `INSERT INTO deliveries (id, agent_id, conversation_id, tool, channel, outcome, created_at)
       VALUES ('d-p', ?, ?, 'chat', 'dashboard', 'delivered', ?)`,
    ).run(AGENT, CONV, NOW);
    db().prepare(
      `UPDATE work SET state = 'done', closed_at = ?, result_delivery_id = 'd-p' WHERE id = ?`,
    ).run(NOW, `piece:${ask}:t-1`);
    // The second open adds one NEW thread. The settled sibling cannot decrement again, so the
    // countdown is 1 — the shape that produced `remaining_children = 2` on `ask:7a4810b1…`.
    openDelegationJoin({
      agentId: AGENT, parentWorkId: ask, replyConversationId: CONV, ttlAt: NOW + 3_600_000,
      threads: [{ threadId: 't-1' }, { threadId: 't-2' }],
    });
    expect(joinState(ask)?.remaining).toBe(1);
  });
});
