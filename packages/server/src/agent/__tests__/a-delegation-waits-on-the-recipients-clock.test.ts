// ════════════════════════════════════════════════════════════════════════════════════════
// A DELEGATION WAITS ON THE RECIPIENT'S CLOCK.
// (t103 item B — OWNER RULING 2026-10-05, decision #1: "A2A reply-patience scales with the
//  recipient's model speed (reuse the PM-ladder machinery)".)
//
// ── WHAT WAS MEASURED AT `09514572` ──────────────────────────────────────────────────
// `MAX_A2A_TURN_RETRIES = 2`, a FIXED count, decided when a delegate was declared gone. The
// dedicated A2A turns are queued back to back by `queueSelfWake`, which is why live-test report
// #3 saw the synthetic `ABANDONED` land "within roughly thirty to sixty seconds of each send".
// A provider declaring that ONE legitimate call may take ten minutes got the same two turns as
// a cloud model that answers in two seconds.
//
// ── THE RULE THIS FILE IS ────────────────────────────────────────────────────────────
//   §1  a SLOW-model recipient gets proportionally more turns, off the provider's own
//       declaration and nothing invented;
//   §2  the KEYSTONE, mirroring t90's R6: an UNDECLARED provider gets exactly today's constant.
//       Arithmetic, not a promise;
//   §3  ONE-DIRECTIONAL — the adversarial shape (a provider declaring a 1-second patience)
//       cannot bring the give-up forward. This is `a-floor-never-shortens-the-ladder`'s twin;
//   §4  the WIRE, both directions: the runtime's cap comes from this function, the machinery is
//       REUSED and not forked, and the owner-facing notice's "how long it waited" is read off
//       the CLOCK — so it stays truthful whatever the budget becomes.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
  closeDb: vi.fn(),
}));

import { a2aRetryBudgetFor } from '../a2a-patience.js';
import { MAX_A2A_TURN_RETRIES } from '../turn-state.js';
import { patienceFloorFor } from '../../tracker/assignee-patience.js';
import { STREAM_FIRST_CHUNK_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS } from '../stream-patience.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '../..');

/** Source with its comments removed — G4: a clause a comment can satisfy tests the comment. */
function stripped(file: string): string {
  return fs.readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

/** `models JOIN providers` — exactly the shape `patienceFloorFor` reads. */
function seedRecipient(p: {
  agentId: string; firstChunkMs?: number | null; idleMs?: number | null;
}): void {
  const db = mockDb.current!;
  db.prepare('INSERT OR REPLACE INTO providers (id, name, first_chunk_timeout_ms, stream_idle_timeout_ms) VALUES (?, ?, ?, ?)')
    .run(`prov-${p.agentId}`, 'P', p.firstChunkMs ?? null, p.idleMs ?? null);
  db.prepare('INSERT OR REPLACE INTO models (id, provider_id, name) VALUES (?, ?, ?)')
    .run(`model-${p.agentId}`, `prov-${p.agentId}`, 'M');
  db.prepare("INSERT OR REPLACE INTO agents (id, name, status, model_id, updated_at) VALUES (?, ?, 'idle', ?, '2026-01-01')")
    .run(p.agentId, p.agentId, `model-${p.agentId}`);
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT, model_id TEXT, updated_at TEXT);
    CREATE TABLE providers (
      id TEXT PRIMARY KEY, name TEXT,
      first_chunk_timeout_ms INTEGER, stream_idle_timeout_ms INTEGER);
    CREATE TABLE models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT);
  `);
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** The undeclared-provider total, from the shipped constants rather than a typed number. */
const UNDECLARED_FLOOR_SECONDS = Math.ceil(
  (STREAM_FIRST_CHUNK_TIMEOUT_MS + STREAM_IDLE_TIMEOUT_MS) / 1000,
);

// ════════════════════ §1 A SLOW RECIPIENT IS WAITED FOR ════════════════════

describe('§1 a slow-model recipient gets proportionally more turns', () => {
  it('a ~600 s declared first chunk earns 9 turns, off the declaration and nothing else', () => {
    // The owner's own slow local row, the one report #3's sub-agent sat on.
    seedRecipient({ agentId: 'slow-one', firstChunkMs: 600_000, idleMs: 60_000 });
    const budget = a2aRetryBudgetFor('slow-one');
    expect(budget.floorSeconds).toBe(660);
    expect(budget.basis).toBe('declared');
    expect(budget.baselineSeconds).toBe(UNDECLARED_FLOOR_SECONDS);
    // ceil(2 × 660 / 150) = 9 — stated as the arithmetic, so the number cannot drift from the rule.
    expect(budget.turns).toBe(
      Math.ceil((MAX_A2A_TURN_RETRIES * 660) / UNDECLARED_FLOOR_SECONDS),
    );
    expect(budget.turns).toBe(9);
    expect(budget.turns).toBeGreaterThan(MAX_A2A_TURN_RETRIES);
  });

  it('the budget rises MONOTONICALLY with the declared patience', () => {
    // The property, not three hand-picked rows: a slower declaration never buys LESS patience.
    const rows: Array<[string, number]> = [
      ['p-150', 90_000], ['p-300', 240_000], ['p-600', 540_000], ['p-1200', 1_140_000],
    ];
    const seen: number[] = [];
    for (const [id, firstChunkMs] of rows) {
      seedRecipient({ agentId: id, firstChunkMs, idleMs: 60_000 });
      seen.push(a2aRetryBudgetFor(id).turns);
    }
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(new Set(seen).size).toBeGreaterThan(1);
    expect(seen[0]).toBe(MAX_A2A_TURN_RETRIES);          // 150 s IS the baseline
  });

  it('the floor comes from the SHIPPED resolver, so a declared pair is read the same way twice', () => {
    // Reuse, asserted as a value and not as an import: this module's answer and
    // `patienceFloorFor`'s are the same number for the same row.
    seedRecipient({ agentId: 'slow-two', firstChunkMs: 300_000, idleMs: 120_000 });
    expect(a2aRetryBudgetFor('slow-two').floorSeconds)
      .toBe(patienceFloorFor('slow-two').floorSeconds);
  });
});

// ════════════════════ §2 THE KEYSTONE — TODAY'S NUMBER, UNCHANGED ════════════════════

describe('§2 an undeclared provider gets exactly today\'s constant', () => {
  it('declares nothing → the budget IS MAX_A2A_TURN_RETRIES', () => {
    seedRecipient({ agentId: 'plain-one' });
    const budget = a2aRetryBudgetFor('plain-one');
    expect(budget.basis).toBe('default');
    expect(budget.floorSeconds).toBe(UNDECLARED_FLOOR_SECONDS);
    expect(budget.turns).toBe(MAX_A2A_TURN_RETRIES);
  });

  it('a provider declaring EXACTLY the standing defaults is also unchanged', () => {
    seedRecipient({
      agentId: 'same-one',
      firstChunkMs: STREAM_FIRST_CHUNK_TIMEOUT_MS,
      idleMs: STREAM_IDLE_TIMEOUT_MS,
    });
    expect(a2aRetryBudgetFor('same-one').turns).toBe(MAX_A2A_TURN_RETRIES);
  });

  it('an unknown agent, a null agent and a model-less agent all resolve to today\'s number', () => {
    // An unknown provider must not buy itself extra silence — the only safe direction.
    mockDb.current!
      .prepare("INSERT INTO agents (id, name, status, model_id, updated_at) VALUES ('no-model', 'n', 'idle', NULL, '2026-01-01')")
      .run();
    for (const id of [null, undefined, 'nobody', 'no-model'] as Array<string | null | undefined>) {
      expect(a2aRetryBudgetFor(id).turns, `${String(id)} did not resolve to the default`)
        .toBe(MAX_A2A_TURN_RETRIES);
      expect(a2aRetryBudgetFor(id).basis).toBe('default');
    }
  });
});

// ════════════════════ §3 ONE-DIRECTIONAL ════════════════════

describe('§3 the budget is a FLOOR — it can never bring the give-up forward', () => {
  it('a provider declaring a 1-second patience still gets today\'s two turns', () => {
    // The adversarial shape. Without the `max` this row would buy ONE turn and make the engine
    // give up sooner than it does today — the direction that costs the user an answer.
    seedRecipient({ agentId: 'fast-one', firstChunkMs: 1_000, idleMs: 0 });
    const budget = a2aRetryBudgetFor('fast-one');
    expect(budget.basis).toBe('declared');
    expect(budget.floorSeconds).toBeLessThan(UNDECLARED_FLOOR_SECONDS);
    expect(budget.turns).toBe(MAX_A2A_TURN_RETRIES);
  });

  it('NO declared row anywhere resolves below today\'s constant', () => {
    for (const ms of [0, 1, 500, 1_000, 60_000, 149_000, 150_000]) {
      seedRecipient({ agentId: `sweep-${ms}`, firstChunkMs: ms, idleMs: 0 });
      expect(a2aRetryBudgetFor(`sweep-${ms}`).turns, `${ms}ms shortened the budget`)
        .toBeGreaterThanOrEqual(MAX_A2A_TURN_RETRIES);
    }
  });
});

// ════════════════════ §4 THE WIRE, BOTH DIRECTIONS ════════════════════

describe('§4 the wire — the runtime reads this budget, and the notice reads the clock', () => {
  const runtimeSrc = stripped(path.join(SRC, 'agent/runtime.ts'));
  const patienceSrc = stripped(path.join(SRC, 'agent/a2a-patience.ts'));
  const noticeSrc = stripped(path.join(SRC, 'agent/join-failure-notice.ts'));

  it('the A2A re-trigger gates on the RESOLVED budget, not on the constant', () => {
    // The call shape AND its application (G4): the comparison the retry decision is made on.
    expect(runtimeSrc).toMatch(/const budget = a2aRetryBudgetFor\(agentId\);/);
    expect(runtimeSrc).toMatch(/if \(tries <= budget\.turns\) \{/);
  });

  it('the runtime no longer compares against MAX_A2A_TURN_RETRIES at all', () => {
    // The both-directions half. A second site that reintroduced the bare constant as a cap would
    // be a row the ruling does not reach, and this is what refuses it.
    expect(runtimeSrc).not.toMatch(/MAX_A2A_TURN_RETRIES/);
  });

  it('the budget REUSES the ladder\'s floor rather than forking it', () => {
    // No second reference speed. The whole reason the ruling says "reuse the PM-ladder
    // machinery" is that inventing one is the fix SLOW-INFERENCE ruling R1 rejected.
    expect(patienceSrc).toMatch(
      /import \{ patienceFloorFor \} from '\.\.\/tracker\/assignee-patience\.js';/,
    );
    expect(patienceSrc).toMatch(/patienceFloorFor\(null\)\.floorSeconds/);
    expect(patienceSrc).toMatch(/patienceFloorFor\(agentId\)/);
    // …and it does NOT read the provider columns itself, which is what forking would look like.
    expect(patienceSrc).not.toMatch(/first_chunk_timeout_ms/);
    expect(patienceSrc).not.toMatch(/resolveStreamPatience/);
  });

  it('the budget is a `max` against today\'s constant, in CODE', () => {
    expect(patienceSrc).toMatch(/Math\.max\(MAX_A2A_TURN_RETRIES,/);
  });

  it('the notice\'s "how long it waited" is read off the clock, so it stays truthful', () => {
    // t90's notice names an elapsed time. It must not be derived from the cap — if it were, a
    // scaled cap would make the sentence lie. It is `Date.now()` against the pieces' own
    // `opened_at`, and neither the constant nor the budget appears in that module at all.
    expect(noticeSrc).toMatch(/Date\.now\(\) - openedAtMs/);
    expect(noticeSrc).toMatch(/SELECT MIN\(opened_at\) AS at FROM work WHERE parent_id = \?/);
    expect(noticeSrc).not.toMatch(/MAX_A2A_TURN_RETRIES|a2aRetryBudgetFor/);
  });
});
