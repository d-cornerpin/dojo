// ════════════════════════════════════════════════════════════════════════════
// THE THRASH GATE READS THE WHOLE CALL (owner ruling, 2026-09-22)
//
// THE LIVE DEFECT, DRIVEN. The owner's production agent made FIVE
// `user_gmail_search` calls on one turn with five different date-range queries —
// `after:2026/09/08 before:2026/09/11`, then /11–/14, /14–/17, /17–/20, /20–/23 —
// each returning different mail. The thrash gate fired anyway:
//
//   'You've called user_gmail_search({"max_results":40}) 5× on this turn…
//    You already have the result from the first call'
//
// The signature showed ONLY `max_results`. `query` had been dropped by
// `canonicalToolSignature`'s prose-field allow-list, so five distinct asks
// collapsed to one identity and the engine both REFUSED genuine work and
// ASSERTED something untrue about work it had not done.
//
// This file drives the REAL detector (`detectTaskThrashing`, over real `messages`
// rows) rather than a re-implementation of its counting, because the counting is
// the half that turns a collapsed signature into a refusal.
//
// THE CONTROL IS AS LOAD-BEARING AS THE FIX. Test (2b) re-runs the identical
// shape with five BYTE-IDENTICAL calls and demands the gate still fires. A fix
// that widened the identity until nothing ever matched would pass (2a) and fail
// the gate's actual job.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join(o.tmpdir(), 'dojo-thrash-whole-call');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-thrash-whole-call', 'dojo.db'),
  };
});
vi.mock('../../../gateway/ws.js', () => ({
  broadcast: () => {},
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../../db/migrations.js';
import { detectTaskThrashing } from '../loop.js';
import { canonicalToolSignature } from '../classifiers/loop.js';

const AGENT = 'agent-under-test';

const db = (): Database.Database => {
  if (!mockDb.current) throw new Error('no db');
  return mockDb.current;
};

/** One assistant row carrying one `tool_use` block, exactly the shape the
 *  detector parses out of `messages.content`. */
function recordCall(name: string, input: Record<string, unknown>, n: number): void {
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, content, turn_number, created_at)
     VALUES (?, ?, 'assistant', ?, 1, ?)`,
  ).run(
    `m-${n}`,
    AGENT,
    JSON.stringify([{ type: 'tool_use', id: `tu-${n}`, name, input }]),
    // `created_at` is epoch-integer on this schema (its CHECK says so); the
    // detector orders on it, so the rows land in call order.
    1_790_000_000_000 + n * 1000,
  );
}

/** The owner's five live calls, verbatim from the production transcript. */
const OWNER_LIVE_QUERIES = [
  'after:2026/09/08 before:2026/09/11',
  'after:2026/09/11 before:2026/09/14',
  'after:2026/09/14 before:2026/09/17',
  'after:2026/09/17 before:2026/09/20',
  'after:2026/09/20 before:2026/09/23',
];

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  d.prepare("INSERT INTO agents (id, name, status) VALUES (?, 'Test Agent', 'working')").run(AGENT);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('2a — the owner\'s exact live shape', () => {
  it('⚠ FIVE user_gmail_search CALLS WITH FIVE DIFFERENT DATE RANGES ARE NOT THRASH', () => {
    OWNER_LIVE_QUERIES.forEach((query, i) => {
      recordCall('user_gmail_search', { query, max_results: 40 }, i + 1);
    });

    const verdict = detectTaskThrashing(AGENT);

    expect(
      verdict.thrashing,
      `the engine refused five distinct searches. Signature seen: ${verdict.signature ?? '(none)'}`,
    ).toBe(false);
  });

  it('the five calls carry five DISTINCT signatures, and each one contains its query', () => {
    const sigs = OWNER_LIVE_QUERIES.map((query) =>
      canonicalToolSignature('user_gmail_search', { query, max_results: 40 }));
    expect(new Set(sigs).size).toBe(5);
    for (const [i, sig] of sigs.entries()) {
      expect(sig, 'the signature dropped the query field again').toContain(OWNER_LIVE_QUERIES[i]);
      // …and it is not the string the owner was shown.
      expect(sig).not.toBe('user_gmail_search:{"max_results":40}');
    }
  });

  it('the canonical twin behaves identically — the fix is not a user_-prefix patch', () => {
    OWNER_LIVE_QUERIES.forEach((query, i) => {
      recordCall('gmail_search', { query, max_results: 40 }, i + 1);
    });
    expect(detectTaskThrashing(AGENT).thrashing).toBe(false);
  });
});

describe('2b — THE CONTROL: the gate still does its real job', () => {
  it('⚠ FIVE BYTE-IDENTICAL CALLS ARE STILL CAUGHT', () => {
    for (let i = 1; i <= 5; i++) {
      recordCall('user_gmail_search', { query: OWNER_LIVE_QUERIES[0], max_results: 40 }, i);
    }

    const verdict = detectTaskThrashing(AGENT);

    // NOTHING ABOUT THE FIX IS ASSERTED HERE, deliberately. This test must pass
    // under the planted key-dropping signature too — that is what makes it a
    // control rather than a second copy of (2a). A "fix" that widened the identity
    // until nothing ever matched would pass (2a) and fail this.
    expect(verdict.thrashing, 'the gate stopped catching a genuine repeat').toBe(true);
    expect(verdict.toolName).toBe('user_gmail_search');
    expect(verdict.count).toBe(5);
  });

  it('and the refusal it will echo names the actual ask', () => {
    for (let i = 1; i <= 5; i++) {
      recordCall('user_gmail_search', { query: OWNER_LIVE_QUERIES[0], max_results: 40 }, i);
    }
    // The gate's message says "you already called this tool with these exact
    // arguments". That sentence is checkable only because the signature it
    // matched on carries the arguments — which is the (2a) fix, asserted here
    // rather than inside the control above.
    expect(detectTaskThrashing(AGENT).signature).toContain(OWNER_LIVE_QUERIES[0]);
  });

  it('four identical calls trip it (the declared threshold is unmoved)', () => {
    for (let i = 1; i <= 4; i++) {
      recordCall('file_read', { path: '/tmp/same.txt' }, i);
    }
    expect(detectTaskThrashing(AGENT).thrashing).toBe(true);
  });

  it('three identical calls do NOT trip it (the threshold is a threshold, not a slope)', () => {
    for (let i = 1; i <= 3; i++) {
      recordCall('file_read', { path: '/tmp/same.txt' }, i);
    }
    expect(detectTaskThrashing(AGENT).thrashing).toBe(false);
  });
});

describe('2c — length-capping still distinguishes', () => {
  it('⚠ TWO 500-CHAR QUERIES DIFFERING ONLY AT THE TAIL ARE NOT THE SAME SEARCH', () => {
    const head = `subject:(quarterly revenue reconciliation) ${'x'.repeat(437)}`;
    const a = `${head}${'alpha'.repeat(4)}`;
    const b = `${head}${'omega'.repeat(4)}`;
    expect(a.length).toBe(500);
    expect(b.length).toBe(500);
    expect(a.slice(0, 480)).toBe(b.slice(0, 480));

    expect(canonicalToolSignature('user_gmail_search', { query: a }))
      .not.toBe(canonicalToolSignature('user_gmail_search', { query: b }));
  });

  it('…and four of them plus a fifth repeat still only flags the REPEAT', () => {
    const base = 'x'.repeat(490);
    for (let i = 1; i <= 4; i++) {
      recordCall('user_gmail_search', { query: `${base}-variant-${i}` }, i);
    }
    expect(detectTaskThrashing(AGENT).thrashing).toBe(false);

    // Now spin on ONE of them four times over.
    for (let i = 5; i <= 8; i++) {
      recordCall('user_gmail_search', { query: `${base}-variant-1` }, i);
    }
    const verdict = detectTaskThrashing(AGENT);
    expect(verdict.thrashing).toBe(true);
    // 1 original + 4 repeats of variant-1
    expect(verdict.count).toBe(5);
  });
});
