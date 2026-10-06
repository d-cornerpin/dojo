// t109 item A — THE HOP CAP WAS A LIFETIME BUDGET, THE DROP WAS QUIET, AND THE TABLE NEVER
// GOT CLEANED.
//
// BACKLOG (2026-10-05, t90 fix round 2 concern 1), verbatim: *"`a2a_threads.hop_count` is never
// aged or reset, so ANY long-lived A2A thread hits `THREAD_HOP_CAP = 8` (`work/store.ts:1006`)
// and every later delivery is silently dropped with `HOP_LIMIT_EXCEEDED` as a RETURN, not a
// throw (`a2a-transport.ts:586–587`) — the PM's periodic re-drive now sidesteps it with a fresh
// thread per interval and says a drop out loud (t90 `b67cd244`), but the general form stands for
// every other caller. Decide: age the counter per interval, reset on a successful reply, or make
// the drop loud everywhere. ALSO: `a2a_threads` has no purge or aging anywhere (the only DELETE
// is in a test)."*
//
// RE-DERIVED AT THIS HEAD before the fix. The line's two line numbers had moved (the cap is
// `work/store.ts:1021`, the drop `a2a-transport.ts:585–587`) and one of its claims needed
// correcting: the hop count lives in TWO stores, not one — `work.hop_count` for a thread anybody
// delegated on (D2's rekey) and `a2a_threads.hop_count` for every other thread, read through
// `getThreadHopCount`'s fallback. NEITHER aged. So both halves are claused here.
//
// ── THE DECISION, AND WHY IT IS NOT RESET-ON-REPLY ───────────────────────────────────────────
// Reset-on-successful-reply is the option that sounds right and measures wrong: a RELAY — the
// runaway the cap exists against — is a message forwarded along a chain A→B→C→D, and every hop
// of a relay has a DIFFERENT sender, so "reset when the other side speaks" would reset on every
// hop of exactly the thing being capped. The discriminator that actually separates a healthy
// long thread from a runaway is TIME, so the cap became eight hops inside a ROLLING WINDOW
// (`THREAD_HOP_WINDOW_MS`, carried from `JOIN_TTL_MINUTES`), plus the loud drop everywhere, plus
// the purge. All three are in this file.
//
// §1 the aging, on the spine store · §2 the aging, on the fallback store
// §3 the loud drop, and the two enumerated exemptions, counted both ways
// §4 the purge, and the live work row it must refuse to purge
// §5 the wire clause: the window is carried, not re-chosen

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

/** The transport's own log is where a drop is said, so it is CAPTURED rather than silenced. */
const log = vi.hoisted(() => {
  const calls = { debug: [] as unknown[][], info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
  return {
    calls,
    logger: {
      debug: (...a: unknown[]) => { calls.debug.push(a); },
      info: (...a: unknown[]) => { calls.info.push(a); },
      warn: (...a: unknown[]) => { calls.warn.push(a); },
      error: (...a: unknown[]) => { calls.error.push(a); },
    },
  };
});
vi.mock('../../logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../logger.js')>()),
  createLogger: () => log.logger,
}));

vi.mock('../../memory/embeddings.js', () => ({
  generateEmbedding: vi.fn(async () => {
    const v = new Float32Array(8);
    for (let i = 0; i < 8; i++) v[i] = i + 1;
    return v;
  }),
  queueEmbedding: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: () => false,
  isPMAgent: () => false,
  isHealerAgent: () => false,
  isDreamerAgent: () => false,
  getOwnerName: () => 'Owner',
  getPrimaryAgentId: () => 'primary',
}));
const handleMessage = vi.fn(async () => {});
vi.mock('../runtime.js', () => ({ getAgentRuntime: () => ({ handleMessage }) }));
vi.mock('../../memory/conversations.js', () => ({
  resolveOrCreateConversation: vi.fn(() => 'conv-stub'),
}));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertMessageIfAbsent: vi.fn(() => ({
    seq: 1, id: 'stub', lane: 'a2a', displayKind: 'a2a', displayTier: 'agent-only',
    tokenCount: 1, createdAt: '2026-07-28 00:00:00', sentAt: 1_800_000_000_000,
  })),
}));

import {
  THREAD_HOP_CAP, THREAD_HOP_WINDOW_MS, JOIN_TTL_MINUTES, JOIN_MAX_AGE_DAYS,
  hopWindowLapsed, purgeDeadA2AThreads,
} from '../../work/store.js';

const SENDER = 'primary';
const RECEIVER = 'worker';
const THREAD = 'thread-t109a-0';

function schema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE a2a_threads (
      thread_id TEXT PRIMARY KEY, hop_count INTEGER DEFAULT 0, last_sender TEXT,
      last_intent TEXT, created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, agent_id TEXT, role TEXT, content TEXT,
      lane TEXT NOT NULL DEFAULT 'owner', channel TEXT, conv_key TEXT, inbound_meta TEXT,
      source_agent_id TEXT, a2a_thread_id TEXT, a2a_intent TEXT,
      created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE work (
      id TEXT PRIMARY KEY, kind TEXT, parent_id TEXT, agent_id TEXT, assignee_agent TEXT,
      root_kind TEXT, root_id TEXT, state TEXT, hop_count INTEGER NOT NULL DEFAULT 0,
      notes TEXT, result_delivery_id TEXT, remaining_children INTEGER,
      compile_pending INTEGER NOT NULL DEFAULT 0, reply_conversation_id TEXT,
      ttl_at INTEGER, opened_at INTEGER, updated_at INTEGER);
  `);
}

/** A thread row on the FALLBACK store, at the cap, last touched `agoMs` ago. */
function seedFallbackThread(threadId: string, hops: number, agoMs: number): void {
  mockDb.current!.prepare(
    `INSERT INTO a2a_threads (thread_id, hop_count, last_sender, last_intent, created_at, updated_at)
     VALUES (?, ?, ?, 'ANSWER', datetime('now'), datetime('now', ?))`,
  ).run(threadId, hops, RECEIVER, `-${Math.round(agoMs / 1000)} seconds`);
}

/** The same thread on the SPINE — a `work` row rooted on it, which is what a delegation makes.
 *  `updated_at` is INTEGER ms here, unlike the fallback store's TEXT. */
function seedSpineThread(threadId: string, hops: number, agoMs: number): void {
  const at = Date.now() - agoMs;
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, root_kind, root_id, state, hop_count, opened_at, updated_at)
     VALUES (?, 'task', ?, 'a2a_thread', ?, 'open', ?, ?, ?)`,
  ).run(`piece:${threadId}`, SENDER, threadId, hops, at, at);
}

async function deliver(threadId = THREAD, intent = 'FYI') {
  const { deliverA2AMessage } = await import('../a2a-transport.js');
  return deliverA2AMessage({
    intent: intent as never,
    threadId,
    requiresResponse: false,
    payload: `a message about the vendor list, ${Math.random()}`,
    toAgent: RECEIVER,
    fromAgent: SENDER,
  });
}

const dropLines = (level: 'info' | 'warn') =>
  log.calls[level]
    .filter((a) => String(a[0]) === 'A2A message dropped')
    .map((a) => (a[1] ?? {}) as Record<string, unknown>);

beforeEach(() => {
  handleMessage.mockClear();
  mockDb.current?.close();
  const db = new Database(':memory:');
  mockDb.current = db;
  schema(db);
  db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Zargo', 'active')`).run(SENDER);
  db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Maddy', 'active')`).run(RECEIVER);
  for (const k of ['debug', 'info', 'warn', 'error'] as const) log.calls[k].length = 0;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 THE AGING, ON THE SPINE STORE (`work.hop_count`)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 a thread at the cap, on the spine', () => {
  it('⚠ A: a thread quiet for longer than the window delivers again — the hops aged out', async () => {
    seedSpineThread(THREAD, THREAD_HOP_CAP, THREAD_HOP_WINDOW_MS + 60_000);
    const res = await deliver();
    expect(res.delivered, 'a healthy long-lived thread is not a runaway loop').toBe(true);
    expect(dropLines('warn'), 'and nothing was dropped to say out loud').toEqual([]);
    // The counter RESTARTED rather than continuing from 8 — the write-side half of the aging.
    const row = mockDb.current!.prepare(
      `SELECT hop_count FROM work WHERE root_kind = 'a2a_thread' AND root_id = ?`,
    ).get(THREAD) as { hop_count: number };
    expect(row.hop_count, 'the count restarts at 1, it does not resume at 9').toBe(1);
  });

  it('⚠ A, THE OTHER DIRECTION: the cap still bites INSIDE the window', async () => {
    seedSpineThread(THREAD, THREAD_HOP_CAP, 60_000);
    const res = await deliver();
    expect(res.delivered, 'eight hops in one window is the runaway the cap exists for').toBe(false);
    expect(res.reason).toBe('HOP_LIMIT_EXCEEDED');
    // And the count is NOT bumped by a refused delivery.
    const row = mockDb.current!.prepare(
      `SELECT hop_count FROM work WHERE root_kind = 'a2a_thread' AND root_id = ?`,
    ).get(THREAD) as { hop_count: number };
    expect(row.hop_count).toBe(THREAD_HOP_CAP);
  });

  it('a thread one hop under the cap delivers inside the window, and counts', async () => {
    seedSpineThread(THREAD, THREAD_HOP_CAP - 1, 60_000);
    expect((await deliver()).delivered).toBe(true);
    const row = mockDb.current!.prepare(
      `SELECT hop_count FROM work WHERE root_kind = 'a2a_thread' AND root_id = ?`,
    ).get(THREAD) as { hop_count: number };
    expect(row.hop_count, 'inside the window a hop still increments').toBe(THREAD_HOP_CAP);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 THE AGING, ON THE FALLBACK STORE (`a2a_threads.hop_count`)
// ════════════════════════════════════════════════════════════════════════════════════════
//
// A thread nobody delegated on has NO work row, and that is the majority of threads. The
// BACKLOG line named this store and only this store; the spine store was the one the line's own
// line numbers pointed at. Both must age or the cap means two different things depending on
// whether anyone happened to open a work row.

describe('§2 a thread at the cap, with no work row at all', () => {
  it('⚠ A: quiet for longer than the window — it delivers, and the fallback count restarts', async () => {
    seedFallbackThread(THREAD, THREAD_HOP_CAP, THREAD_HOP_WINDOW_MS + 60_000);
    expect((await deliver()).delivered).toBe(true);
    const row = mockDb.current!.prepare('SELECT hop_count FROM a2a_threads WHERE thread_id = ?')
      .get(THREAD) as { hop_count: number };
    expect(row.hop_count, 'restarted at 1 on the fallback store too').toBe(1);
  });

  it('⚠ A, THE OTHER DIRECTION: inside the window the fallback cap still bites', async () => {
    seedFallbackThread(THREAD, THREAD_HOP_CAP, 60_000);
    const res = await deliver();
    expect(res.delivered).toBe(false);
    expect(res.reason).toBe('HOP_LIMIT_EXCEEDED');
  });

  it('`hopWindowLapsed` treats a NULL instant as lapsed — the safe direction is to deliver', () => {
    expect(hopWindowLapsed(null)).toBe(true);
    expect(hopWindowLapsed(undefined)).toBe(true);
    expect(hopWindowLapsed(Date.now())).toBe(false);
    expect(hopWindowLapsed(Date.now() - THREAD_HOP_WINDOW_MS - 1_000)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 THE DROP IS LOUD EVERYWHERE — and the quiet set is ENUMERATED, not assumed
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 a dropped message is said out loud', () => {
  it('⚠ A: HOP_LIMIT_EXCEEDED is a WARN, not an info — the message vanished', async () => {
    seedFallbackThread(THREAD, THREAD_HOP_CAP, 60_000);
    await deliver();
    const warns = dropLines('warn');
    expect(warns.length, 'said once, at warn').toBe(1);
    expect(warns[0].reason).toBe('HOP_LIMIT_EXCEEDED');
    expect(dropLines('info'), 'and NOT at info, which is where it used to hide').toEqual([]);
  });

  it('⚠ A: AGENT_NOT_FOUND is a WARN too — a purged recipient is the C-site reason', async () => {
    const res = await deliver('thread-t109a-missing');
    // Delivered to a recipient that exists; now the one that does not.
    expect(res.delivered).toBe(true);
    for (const k of ['info', 'warn'] as const) log.calls[k].length = 0;
    const { deliverA2AMessage } = await import('../a2a-transport.js');
    const gone = await deliverA2AMessage({
      intent: 'FYI' as never, threadId: 'thread-t109a-gone', requiresResponse: false,
      payload: 'nobody is there', toAgent: 'no-such-agent', fromAgent: SENDER,
    });
    expect(gone.delivered).toBe(false);
    expect(gone.reason).toBe('AGENT_NOT_FOUND');
    const warns = dropLines('warn');
    expect(warns.length).toBe(1);
    expect(warns[0].reason).toBe('AGENT_NOT_FOUND');
  });

  it('THE CONTROL: the two drops the sender is TOLD about stay at info', async () => {
    // AWAITING_REPLY — the sender's own unanswered wake intent is the most recent delivery.
    seedFallbackThread('thread-t109a-latch', 1, 60_000);
    mockDb.current!.prepare('UPDATE a2a_threads SET last_sender = ?, last_intent = ? WHERE thread_id = ?')
      .run(SENDER, 'QUESTION', 'thread-t109a-latch');
    const res = await deliver('thread-t109a-latch', 'QUESTION');
    expect(res.reason, 'precondition: the latch fired').toBe('AWAITING_REPLY');
    expect(dropLines('warn'), 'the protection working is not a warning').toEqual([]);
    const infos = dropLines('info');
    expect(infos.length).toBe(1);
    expect(infos[0].reason).toBe('AWAITING_REPLY');
  });

  it('⚠ A, BOTH DIRECTIONS: the quiet set is a CLOSED list, so a new reason lands at warn', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'a2a-transport.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    // The set literal, read off the source rather than imported — it is module-private on
    // purpose, and what matters is that it is a LIST and a short one.
    const m = /DROPS_THE_SENDER_IS_TOLD_ABOUT[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(src);
    expect(m, 'the enumerated quiet set must still exist').not.toBeNull();
    const quiet = [...m![1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]).sort();
    expect(quiet, 'exactly the two the sender is told about, synchronously, in its tool result')
      .toEqual(['AWAITING_REPLY', 'SEMANTIC_DUPLICATE']);

    // And the DEFAULT is warn: the ternary's false arm is the warn, not the other way round.
    expect(src, 'an unlisted reason must fall to warn, never to info')
      .toMatch(/DROPS_THE_SENDER_IS_TOLD_ABOUT\.has\(reason\)\s*\?\s*logger\.info/);
    // Every reason the transport can return, minus the quiet two, is therefore loud. Counted
    // so a new `logDrop(` reason cannot be added without this clause noticing the arithmetic.
    const reasons = new Set([...src.matchAll(/logDrop\(envelope, '([A-Z_]+)'\)/g)].map((x) => x[1]));
    expect(reasons.size, 'the census of drop reasons the transport actually emits')
      .toBeGreaterThanOrEqual(5);
    const loud = [...reasons].filter((r) => !quiet.includes(r));
    expect(loud.sort()).toEqual(
      ['AGENT_NOT_FOUND', 'HOP_LIMIT_EXCEEDED', 'MALFORMED_ENVELOPE', 'PERSIST_SKIPPED'],
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 THE PURGE — and the row it must REFUSE to purge
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 dead a2a_threads rows get disposed of', () => {
  it('⚠ A: a row past JOIN_MAX_AGE_DAYS with no work row goes', () => {
    seedFallbackThread('thread-old-and-dead', 3, (JOIN_MAX_AGE_DAYS + 1) * 24 * 3_600_000);
    expect(purgeDeadA2AThreads()).toBe(1);
    expect(mockDb.current!.prepare('SELECT COUNT(*) AS n FROM a2a_threads').get())
      .toEqual({ n: 0 });
  });

  it('⚠ A, THE OTHER DIRECTION: a row INSIDE the horizon stays', () => {
    seedFallbackThread('thread-recent', 3, 60_000);
    expect(purgeDeadA2AThreads()).toBe(0);
    expect(mockDb.current!.prepare('SELECT COUNT(*) AS n FROM a2a_threads').get())
      .toEqual({ n: 1 });
  });

  it('⚠ A, THE GUARD THAT MATTERS: an ANCIENT row whose work is still live stays', () => {
    // A delegated thread's hop count is on the spine and its ask may still be outstanding. Age
    // alone must never take the thread row out from under live work.
    seedFallbackThread('thread-old-but-working', 3, (JOIN_MAX_AGE_DAYS + 30) * 24 * 3_600_000);
    seedSpineThread('thread-old-but-working', 3, (JOIN_MAX_AGE_DAYS + 30) * 24 * 3_600_000);
    expect(purgeDeadA2AThreads()).toBe(0);
    expect(mockDb.current!.prepare('SELECT COUNT(*) AS n FROM a2a_threads').get())
      .toEqual({ n: 1 });
  });

  it('it is WIRED to a clock, not merely written — the reaper declares it', async () => {
    const { REAPER_KINDS } = await import('../../work/work-reaper.js');
    const kind = REAPER_KINDS.find((k) => k.id === 'dead-a2a-threads');
    expect(kind, 'a sweep with no clock is a sweep that never runs').toBeDefined();
    expect(kind!.everyMs, 'on the hourly clock its sibling prune already declared').toBe(3_600_000);
    expect(kind!.wakes, 'disposing of dead rows speaks to nobody').toBe(false);
    expect(kind!.cadenceFrom.length, 'and the period is sourced, not chosen').toBeGreaterThan(40);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 THE WINDOW IS CARRIED, NOT RE-CHOSEN (#14)
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 the window is an identity, not an agreement', () => {
  it('THREAD_HOP_WINDOW_MS *is* JOIN_TTL_MINUTES — so the two cannot drift apart', () => {
    expect(THREAD_HOP_WINDOW_MS).toBe(JOIN_TTL_MINUTES * 60_000);
  });

  it('and it is a real window, not a disabled cap', () => {
    expect(THREAD_HOP_WINDOW_MS).toBeGreaterThan(0);
    expect(Number.isFinite(THREAD_HOP_WINDOW_MS)).toBe(true);
  });
});
