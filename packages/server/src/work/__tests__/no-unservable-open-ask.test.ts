// ════════════════════════════════════════════════════════════════════════════════
// SWEEP CORE-2 item 5, BATCH A — AN IGNORED SENDER OPENS NO TICKET, AND NO OPEN ASK
// MAY EXIST THAT THE PLATFORM'S OWN RULES MAKE UNSERVABLE.
//
// The owner decided this on 2026-08-05 and sharpened it at the Phase-6 exit review: the fix
// lands at the CAUSE, not at the counter. *"Don't make the automatic ticket rule apply to
// unknown/ignored senders. That's literally what 'ignored' means."* Four requirements, and
// each has its own section below:
//
//   1. INGEST — a message from a sender the platform is required to ignore is RECORDED and
//      stamped per OR4 (audit visibility; nothing vanishes without a trace) and files NO
//      work/ask row. Nothing may claim work is owed to somebody who will never be served.
//   2. THE STAND-DOWN LAW counts only the tickets that exist, in the owner's decided
//      precedence: main user first, safe senders second, other agents third.
//   3. A STRUCTURAL INVARIANT, census-shaped, so the class cannot recur — extended with the
//      two arms TB3 §8.2 measured: an ask owed by a TERMINATED agent, and an ask BELOW its
//      own agent's session boundary.
//   4. REMEDIATION with a denominator — the existing population is closed by the fix's own
//      pass, with a named reason per class.
//
// ⚠ NO AGEING (owner, 2026-08-05). The main user's open asks never expire. A
// provably-dead-but-open ask is a DEFECT the structural invariant hunts, never a thing to
// age away. §5 is the grep that keeps a clock out of every arm this task added.
//
// ── WHAT WAS RED AT `e1108c7`, AND WHY (the cause, re-derived here rather than inherited) ──
// `isOwnerAsk` asked `deriveOrigin` for the authorized-human verdict, and `deriveOrigin`'s
// structured trust input is `inbound_meta`. Every one of the five channel producers writes
// `inbound_meta` with `recordInboundMeta()` — AFTER the INSERT that opens the ticket. So at
// the one instant the gate runs, the meta is always absent, `deriveOrigin` falls through to
// its legacy prose shim (branch 4, the `[SOURCE: IMESSAGE FROM …]` marker), and that branch
// returns `authorized: true` unconditionally. The producers' own structural verdict —
// `messages.authorized`, stamped IN the insert — was sitting in the same object, unread.
//
// MEASURED on the owner's own body at `e1108c7` (read-only): 49 open/claimed asks, and
// EVERY ONE of them structurally unservable — 30 whose sender the platform must ignore, 12
// below their agent's session boundary, 7 owed by a terminated agent, ZERO servable.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-unservable-ask-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../../memory/message-store.js';
import {
  abandonUnservableAsks, unservableOpenAskCensus, askIdForMessage, openAsk,
} from '../store.js';
import { selfWakeStandDown, humanAsksOpen } from '../work-reaper.js';

const REPO = path.resolve(__dirname, '..', '..', '..', '..', '..');
const SRC = path.join(REPO, 'packages/server/src');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');

const AGENT = 'kevin';
const CONV = 'conv-1';

/** The shape the iMessage bridge hands the writer, verbatim in the fields that matter:
 *  `channel`, `senderId` and `authorized` are stamped IN the insert (OR4/T4), and
 *  `inbound_meta` is written by `recordInboundMeta` AFTERWARDS — which is exactly why the
 *  gate could never see it. The `[SOURCE: …]` opener is the real one, so the legacy prose
 *  shim in `deriveOrigin` takes its branch here just as it does in production. */
const imessageInbound = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm-stranger', agentId: AGENT, role: 'user',
  content: '[SOURCE: IMESSAGE FROM +15559990001 - this person texted YOUR OWN iMessage account'
    + ' (the DOJO bridge - YOUR phone, not the user\'s).] can you send me the door code?',
  lane: 'owner', channel: 'imessage', senderId: '+15559990001',
  authorized: false, conversationId: CONV,
  ...over,
});

const seedAgent = (id: string, status: string, sessionStartedAt: string | null): void => {
  mockDb.current!.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, ?, ?)`,
  ).run(id, id, status, sessionStartedAt);
};

const seedConversation = (id: string, agentId: string): void => {
  mockDb.current!.prepare(
    `INSERT INTO conversations (id, agent_id, channel, counterparty_id) VALUES (?, ?, 'imessage', 'x')`,
  ).run(id, agentId);
};

/** Open an ask directly on a seeded root message — the shape the ledger already carries on a
 *  lived-in box, which is what the REMEDIATION arms have to reach. */
const seedAskOnMessage = (
  opts: { agentId: string; messageId: string; conversationId: string; authorized: 0 | 1; openedAt: number },
): string => {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, lane, role, content, channel,
                           sender_id, authorized, token_count, created_at, sent_at)
     VALUES (?, ?, ?, 'owner', 'user', 'hello', 'imessage', '+15550000000', ?, 1, ?, ?)`,
  ).run(opts.messageId, opts.agentId, opts.conversationId, opts.authorized, opts.openedAt, opts.openedAt);
  return openAsk({
    agentId: opts.agentId, messageId: opts.messageId, conversationId: opts.conversationId,
    requesterId: '+15550000000', openedAt: opts.openedAt, title: 'seeded',
  });
};

const NOW = 1786000000000;

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  seedAgent(AGENT, 'idle', '1970-01-01');
  seedConversation(CONV, AGENT);
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · INGEST — RECORDED, STAMPED, AND NO TICKET
// ════════════════════════════════════════════════════════════════════════════════

describe('an ignored sender opens no ask ticket at all', () => {
  it('RECORDS the message and stamps it per OR4 — nothing vanishes without a trace', () => {
    const p = insertMessage(imessageInbound() as never);
    const row = mockDb.current!.prepare('SELECT * FROM messages WHERE id = ?').get(p.id) as
      Record<string, unknown>;
    expect(row).toBeDefined();
    // The three OR4 stamps the producer decided are on the row, unchanged by this gate.
    expect(row.channel).toBe('imessage');
    expect(row.sender_id).toBe('+15559990001');
    expect(row.authorized).toBe(0);
  });

  it('files NO work/ask row for that message', () => {
    const p = insertMessage(imessageInbound() as never);
    const ask = mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(p.id));
    expect(ask).toBeUndefined();
    expect(
      mockDb.current!.prepare(`SELECT count(*) AS n FROM work WHERE kind = 'ask'`).get(),
    ).toEqual({ n: 0 });
  });

  // THE NEGATIVE CONTROL, same shape, one column different. Without this the clause above
  // would pass just as well against a gate that stopped opening tickets for everybody.
  it('an AUTHORIZED sender on the same channel still opens one', () => {
    const p = insertMessage(imessageInbound({ id: 'm-friend', authorized: true }) as never);
    const ask = mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(p.id));
    expect(ask).toBeDefined();
  });

  // OR4 IS THE ONE AUTHORITY: the verdict is the producer's own ingest stamp, never a second
  // classification of the prose. A row whose trust was never stamped keeps the previous
  // behaviour exactly — that is what makes this a NARROWING and not a new classifier.
  it('an unstamped row is unchanged — the gate adds no new opinion of its own', () => {
    const m = imessageInbound({ id: 'm-unstamped' }) as Record<string, unknown>;
    delete m.authorized;
    const p = insertMessage(m as never);
    const ask = mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(askIdForMessage(p.id));
    expect(ask).toBeDefined();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · THE STAND-DOWN LAW — ONLY THE TICKETS THAT EXIST, IN THE OWNER'S PRECEDENCE
// ════════════════════════════════════════════════════════════════════════════════

describe('the stand-down law counts only the tickets that exist', () => {
  it('an ignored sender never enters the count, so the agent is not stood down by a stranger', () => {
    insertMessage(imessageInbound() as never);
    const v = selfWakeStandDown(AGENT);
    expect(v.humanAsksOpen).toBe(0);
    expect(v.standDown).toBe(false);
  });

  it('reports its tiers in the owner\'s decided precedence: main user, safe senders, other agents', () => {
    const v = selfWakeStandDown(AGENT);
    // The ORDER is the law, so it is asserted as an order and not as a bag of fields.
    expect(Object.keys(v.tiers)).toEqual(['mainUser', 'safeSenders', 'otherAgents']);
  });

  it('a real person\'s ticket still stands the self-wakes down, and is counted as the main user', () => {
    insertMessage(imessageInbound({ id: 'm-real', authorized: true }) as never);
    const v = selfWakeStandDown(AGENT);
    expect(v.standDown).toBe(true);
    expect(v.humanAsksOpen).toBe(1);
    expect(v.tiers.mainUser + v.tiers.safeSenders + v.tiers.otherAgents).toBe(1);
  });

  it('the tier total always equals the number the law stands down on', () => {
    seedAskOnMessage({ agentId: AGENT, messageId: 'm-a', conversationId: CONV, authorized: 1, openedAt: NOW });
    seedAskOnMessage({ agentId: AGENT, messageId: 'm-b', conversationId: CONV, authorized: 1, openedAt: NOW + 1 });
    const v = selfWakeStandDown(AGENT);
    expect(v.tiers.mainUser + v.tiers.safeSenders + v.tiers.otherAgents).toBe(humanAsksOpen(AGENT));
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · THE STRUCTURAL INVARIANT — A CENSUS THAT MUST BE EMPTY
// ════════════════════════════════════════════════════════════════════════════════

describe('no open ask may exist that the platform\'s own rules make unservable', () => {
  it('names an ask whose sender the platform is required to ignore', () => {
    seedAskOnMessage({ agentId: AGENT, messageId: 'm-ig', conversationId: CONV, authorized: 0, openedAt: NOW });
    expect(unservableOpenAskCensus().map((r) => r.cls)).toEqual(['ignored-sender']);
  });

  it('names an ask owed by a TERMINATED agent (TB3 §8.2, 7 measured)', () => {
    seedAgent('dead', 'terminated', null);
    seedConversation('conv-dead', 'dead');
    seedAskOnMessage({ agentId: 'dead', messageId: 'm-d', conversationId: 'conv-dead', authorized: 1, openedAt: NOW });
    expect(unservableOpenAskCensus().map((r) => r.cls)).toEqual(['dead-agent']);
  });

  it('names an ask BELOW its own agent\'s session boundary (TB3 §8.2, 11 measured)', () => {
    seedAgent('reset', 'idle', '2026-08-01 00:00:00');
    seedConversation('conv-reset', 'reset');
    seedAskOnMessage({
      agentId: 'reset', messageId: 'm-b1', conversationId: 'conv-reset', authorized: 1,
      openedAt: Date.UTC(2026, 6, 1),   // a month BELOW the boundary
    });
    expect(unservableOpenAskCensus().map((r) => r.cls)).toEqual(['below-session-boundary']);
  });

  it('is EMPTY for a servable ask — the census is not simply naming everything', () => {
    seedAskOnMessage({ agentId: AGENT, messageId: 'm-ok', conversationId: CONV, authorized: 1, openedAt: NOW });
    expect(unservableOpenAskCensus()).toEqual([]);
  });

  it('is empty for a CLOSED ask of every unservable shape — it hunts OPEN obligations only', () => {
    seedAgent('dead2', 'terminated', null);
    seedConversation('conv-dead2', 'dead2');
    const id = seedAskOnMessage({
      agentId: 'dead2', messageId: 'm-d2', conversationId: 'conv-dead2', authorized: 1, openedAt: NOW,
    });
    mockDb.current!.prepare(
      `UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = ?`,
    ).run(NOW, id);
    expect(unservableOpenAskCensus()).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · REMEDIATION — ONE REAPER, NAMED REASONS, A DENOMINATOR PER CLASS
// ════════════════════════════════════════════════════════════════════════════════

describe('the unservable reaper closes the existing population with a named reason each', () => {
  const seedAllThree = (): void => {
    seedAskOnMessage({ agentId: AGENT, messageId: 'm-ig', conversationId: CONV, authorized: 0, openedAt: NOW });
    seedAgent('dead', 'terminated', null);
    seedConversation('conv-dead', 'dead');
    seedAskOnMessage({ agentId: 'dead', messageId: 'm-d', conversationId: 'conv-dead', authorized: 1, openedAt: NOW });
    seedAgent('reset', 'idle', '2026-08-01 00:00:00');
    seedConversation('conv-reset', 'reset');
    seedAskOnMessage({
      agentId: 'reset', messageId: 'm-b1', conversationId: 'conv-reset', authorized: 1,
      openedAt: Date.UTC(2026, 6, 1),
    });
  };

  it('reports a DENOMINATOR per class, and the census is empty afterwards', () => {
    seedAllThree();
    expect(unservableOpenAskCensus()).toHaveLength(3);
    const r = abandonUnservableAsks();
    expect(r.abandoned).toBe(3);
    expect(r.byClass['ignored-sender']).toBe(1);
    expect(r.byClass['dead-agent']).toBe(1);
    expect(r.byClass['below-session-boundary']).toBe(1);
    expect(unservableOpenAskCensus()).toEqual([]);
  });

  it('every closure is a RECORDED move whose reason names its class', () => {
    seedAllThree();
    abandonUnservableAsks();
    const reasons = (mockDb.current!.prepare(
      `SELECT json_extract(payload, '$.reason') AS reason FROM work_events
        WHERE kind = 'transition' AND json_extract(payload, '$.to') = 'abandoned' ORDER BY id`,
    ).all() as Array<{ reason: string }>).map((r) => r.reason);
    expect(reasons).toHaveLength(3);
    expect(reasons.some((r) => /ignore/i.test(r))).toBe(true);
    expect(reasons.some((r) => /terminated/i.test(r))).toBe(true);
    expect(reasons.some((r) => /session/i.test(r))).toBe(true);
    // The record is never falsified: every reason says "unservable" so the whole set is
    // findable as one class months later.
    expect(reasons.every((r) => r.startsWith('unservable — '))).toBe(true);
  });

  it('is idempotent — a second pass finds nothing, because the predicate is structural', () => {
    seedAllThree();
    expect(abandonUnservableAsks().abandoned).toBe(3);
    expect(abandonUnservableAsks().abandoned).toBe(0);
  });

  it('leaves a SERVABLE ask alone — the pass acts only on the census it publishes', () => {
    seedAskOnMessage({ agentId: AGENT, messageId: 'm-ok', conversationId: CONV, authorized: 1, openedAt: NOW });
    expect(abandonUnservableAsks().abandoned).toBe(0);
    expect(
      mockDb.current!.prepare(`SELECT state FROM work WHERE kind = 'ask'`).get(),
    ).toEqual({ state: 'open' });
  });

  it('clears the stand-down confound: an agent held open by strangers alone falls to zero', () => {
    for (let i = 0; i < 5; i++) {
      seedAskOnMessage({
        agentId: AGENT, messageId: `m-s${i}`, conversationId: CONV, authorized: 0, openedAt: NOW + i,
      });
    }
    expect(selfWakeStandDown(AGENT).standDown).toBe(true);   // the confound, before
    abandonUnservableAsks();
    expect(selfWakeStandDown(AGENT).standDown).toBe(false);  // and after
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 · NO AGEING, AND THE BOOT SWARM GUARD IS UNTOUCHED
// ════════════════════════════════════════════════════════════════════════════════

describe('no ageing anywhere in this task\'s arms (owner ruling, 2026-08-05)', () => {
  /** `abandonUnservableAsks`'s source, from `{` to the matching `}` at column 0. */
  const reaperSource = (): string => {
    const src = read('work/store.ts');
    const at = src.indexOf('export function abandonUnservableAsks');
    expect(at).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf('\n}\n', at));
  };

  it('the unservable reaper carries no clock — no minutes, hours or days literal', () => {
    expect(reaperSource()).not.toMatch(/-\s*\d+\s*(minute|hour|day)/i);
    expect(reaperSource()).not.toMatch(/unixepoch\('now'/);
  });

  it('the census carries no clock either — an ask is unservable structurally or not at all', () => {
    const src = read('work/store.ts');
    const at = src.indexOf('const UNSERVABLE_OPEN_ASK_SELECT');
    expect(at).toBeGreaterThan(-1);
    const sql = src.slice(at, src.indexOf('`;', at));
    expect(sql).not.toMatch(/-\s*\d+\s*(minute|hour|day)/i);
    expect(sql).not.toMatch(/unixepoch\('now'/);
  });

  // THE OWNER'S STANDING REFUSAL (DESIGN-2BUGS §1b): the reboot-swarm guard is untouched.
  // Asserted by its two load-bearing facts rather than by a line number, so a move does not
  // fail this and an edit does.
  it('the boot swarm guard still holds its own 30-minute floor and its hold limit', () => {
    const src = read('work/work-reaper.ts');
    expect(src).toContain('const HUMAN_HOLD_LIMIT = 5;');
    expect(src).toContain(`w.opened_at < (unixepoch('now', '-30 minutes') * 1000)`);
    expect(src).toContain('boot staleness sweep: older than 30 minutes at startup and beyond the hold limit');
  });
});
