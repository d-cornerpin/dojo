// ════════════════════════════════════════════════════════════════════════════════════════
// t118 ROUND 2 — THE ASK TITLE'S FIRST-INTRODUCTION RACE.
//
// WHAT REVIEW FOUND. t118 round 1 left `openAsk` alone and justified it with
// `work/ask-title.ts`'s refusal: `acceptModelTitle` runs the declared-value scrub over the
// system model's answer and REFUSES the whole title if the scrub would change it. That
// refusal is real, and genuinely stronger than redacting — but it is a HANDED-VALUE check,
// so it can only fire once a value has been registered, and the titler runs on the INBOUND
// path (`insertInboundMessageIfAbsent`, void-dispatched, awaiting a system model) BEFORE the
// turn that will call `credential_add`.
//
// So on the message that FIRST introduces a credential — the `account-setup-verify-use`
// shape, which is exactly the shape the red draw drew — nothing is registered yet and the
// guard accepts a credential-bearing title verbatim. `work.title` is broadcast to the
// dashboard and handed to the PM. The refusal was a RACE, not the property round 1's §2
// claimed, and `ask-title.ts:50-60` was already honest about the scope the lines at :220
// overstated.
//
// WHAT THIS FILE HOLDS. The three orderings, driven — not argued — and the re-vet that
// closes the one that loses:
//
//   §1  the race itself: title accepted verbatim with nothing handed (the hole), and the
//       guard still correct in the two orderings where it can fire.
//   §2  the re-vet: registration is where the process first LEARNS a value, so it is where
//       an already-minted title is re-vetted. Deterministic — no timing, no sleep.
//   §3  what it may not cost, and refusal parity rather than repair.
//   §4  both hooks are wired (the write side and the read side).
//
// FIXTURE DISCIPLINE (G1): fictional credential-shaped strings, invented here.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { acceptModelTitle, revetOpenAskTitles } from '../ask-title.js';
import { openAsk, askIdForMessage } from '../store.js';
import { createWorkTable } from './work-fixture.js';
import { noteDeclaredSecretsFromToolCalls } from '../../credentials/secret-fields.js';
import {
  noteHandedCredentialValues, forgetHandedCredentialValues,
} from '../../credentials/secret-values.js';

const AGENT = 'agent-ask-t118';

// ── THE FICTIONAL CREDENTIALS (G1) ──
const FAKE_KEY = 'sk-live-t118ask-Vn4Qd8Rm2Xs6Bp0Tz';
const FAKE_OTHER = 'tok-t118ask-Lw9Cj3Hy5Kf1Nu';

const db = (): Database.Database => mockDb.current!;

/** The title the system model answered with on a first-introduction message: it copied the
 *  value, which is what `TITLE_INSTRUCTION` asks it not to do and what nothing can prevent. */
const LEAKY_TITLE = `Store ${FAKE_KEY} for the billing provider`;

function applySchema(d: Database.Database): void {
  createWorkTable(d);
  d.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY, name TEXT, status TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT OR IGNORE INTO agents (id, name, status) VALUES ('agent-ask-t118', 'Asker', 'idle');
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY);
  `);
}

/** Open a real ask carrying the title the titler accepted. This is the state the race
 *  produces: the row is durable, the title is live, and no value is registered yet. */
function openAskWithTitle(messageId: string, title: string): string {
  return openAsk({
    agentId: AGENT, messageId, requesterId: 'owner', conversationId: null,
    title, openedAt: Date.now(),
  });
}

const titleOf = (workId: string): string | null =>
  (db().prepare('SELECT title FROM work WHERE id = ?').get(workId) as { title: string | null } | undefined)
    ?.title ?? null;

/** The whole database, swept for one value — the ritual's own method. */
function sweepForValue(needle: string): string[] {
  const hits: string[] = [];
  const tables = db().prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    let cols: Array<{ name: string }>;
    try {
      cols = db().prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    } catch { continue; }
    for (const c of cols) {
      try {
        const r = db().prepare(
          `SELECT COUNT(*) AS n FROM "${name}" WHERE CAST("${c.name}" AS TEXT) LIKE ?`,
        ).get(`%${needle}%`) as { n: number };
        if (r.n > 0) hits.push(`${name}.${c.name} (${r.n} row(s))`);
      } catch { /* not a text carrier */ }
    }
  }
  return hits;
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  applySchema(db());
  forgetHandedCredentialValues();
});

afterEach(() => forgetHandedCredentialValues());

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE RACE, DRIVEN IN ALL THREE ORDERINGS
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the mint-time refusal can only fire on a value already handed', () => {
  it('THE HOLE: with nothing yet handed, a credential-bearing title is ACCEPTED verbatim', () => {
    // No registration has happened — the first-introduction message. This is not a bug in
    // `acceptModelTitle`; it is the stated scope of a handed-value scrub
    // (`ask-title.ts:50-60`). It is a bug in relying on it as a property, which is what
    // t118's §2 row 13 did.
    expect(acceptModelTitle(AGENT, LEAKY_TITLE)).toBe(LEAKY_TITLE);
  });

  it('the guard IS correct once the value is registered (refused, whole title dropped)', () => {
    noteHandedCredentialValues(AGENT, [FAKE_KEY]);
    // `null` means "the ticket keeps its own identifier" — a refusal, never a repair.
    expect(acceptModelTitle(AGENT, LEAKY_TITLE)).toBeNull();
  });

  it('and has no false positive: a clean title is accepted with the value registered', () => {
    noteHandedCredentialValues(AGENT, [FAKE_KEY]);
    expect(acceptModelTitle(AGENT, 'Store the billing provider key')).toBe(
      'Store the billing provider key',
    );
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE RE-VET CLOSES THE LOSING ORDERING, DETERMINISTICALLY
//
// No sleeps and no timing: the ordering is written out by the test. Title first, credential
// second — the ordering the race produces and the one the mint-time guard cannot see.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 registration re-vets titles minted before the value was known', () => {
  it('RED BEFORE THE FIX: the ask gets its own identifier back when the credential lands', () => {
    const workId = openAskWithTitle('msg-race-1', LEAKY_TITLE);

    // The state the race leaves behind, asserted so this clause cannot pass vacuously.
    expect(titleOf(workId)).toBe(LEAKY_TITLE);
    expect(sweepForValue(FAKE_KEY).length).toBeGreaterThan(0);

    // THE TURN'S FIRST `credential_add`, through the REAL registration path — the declared
    // secret field is resolved by the platform's own table, not asserted here.
    noteDeclaredSecretsFromToolCalls(AGENT, [
      { name: 'credential_add', arguments: { service_name: 'billing', credentials: { api_key: FAKE_KEY } } },
    ]);
    revetOpenAskTitles(AGENT);

    // REFUSAL PARITY: the ticket's own id, not a placeholder-bearing title (rule 3 in
    // `ask-title.ts`'s header — a title that had to be scrubbed is a title the model copied
    // from, and what it copied the rest of is not knowable).
    expect(titleOf(workId)).toBe(workId);
    expect(titleOf(workId)).toBe(askIdForMessage('msg-race-1'));
    expect(sweepForValue(FAKE_KEY)).toEqual([]);
  });

  it('the registration path really recognises the declared field (non-vacuity)', () => {
    const workId = openAskWithTitle('msg-race-2', LEAKY_TITLE);
    // A tool call whose secret-bearing argument is NOT a declared secret field registers
    // nothing, so the re-vet has nothing to match and the title stands. Without this, the
    // clause above could be passing because `revetOpenAskTitles` rewrites titles
    // unconditionally.
    noteDeclaredSecretsFromToolCalls(AGENT, [
      { name: 'write_file', arguments: { path: '/tmp/x', content: FAKE_KEY } },
    ]);
    revetOpenAskTitles(AGENT);
    expect(titleOf(workId)).toBe(LEAKY_TITLE);
  });

  it('only the carrying ask is touched: a clean title opened in the same window is untouched', () => {
    const leaky = openAskWithTitle('msg-race-3', LEAKY_TITLE);
    const clean = openAskWithTitle('msg-race-4', 'Set up the billing provider');

    noteHandedCredentialValues(AGENT, [FAKE_KEY]);
    revetOpenAskTitles(AGENT);

    expect(titleOf(leaky)).toBe(leaky);
    expect(titleOf(clean)).toBe('Set up the billing provider');
  });

  it('two values in one window are both caught, and the count is reported', () => {
    const a = openAskWithTitle('msg-race-5', `Store ${FAKE_KEY} now`);
    const b = openAskWithTitle('msg-race-6', `And rotate ${FAKE_OTHER} after`);

    noteHandedCredentialValues(AGENT, [FAKE_KEY, FAKE_OTHER]);
    expect(revetOpenAskTitles(AGENT)).toBe(2);

    expect(titleOf(a)).toBe(a);
    expect(titleOf(b)).toBe(b);
    expect(sweepForValue(FAKE_KEY)).toEqual([]);
    expect(sweepForValue(FAKE_OTHER)).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — WHAT THE RE-VET MAY NOT COST
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the ordinary ask is untouched', () => {
  it('an agent that has handled nothing keeps every title, and the re-vet reports zero', () => {
    const workId = openAskWithTitle('msg-plain-1', 'Put together the quarterly summary');
    expect(revetOpenAskTitles(AGENT)).toBe(0);
    expect(titleOf(workId)).toBe('Put together the quarterly summary');
  });

  it('a value handled by a DIFFERENT agent does not rewrite this agent\'s titles', () => {
    const workId = openAskWithTitle('msg-plain-2', LEAKY_TITLE);
    noteHandedCredentialValues('some-other-agent', [FAKE_KEY]);
    expect(revetOpenAskTitles(AGENT)).toBe(0);
    expect(titleOf(workId)).toBe(LEAKY_TITLE);
  });

  it('an ask still carrying its own id as its title is not rewritten (nothing to do)', () => {
    const workId = openAskWithTitle('msg-plain-3', askIdForMessage('msg-plain-3'));
    noteHandedCredentialValues(AGENT, [FAKE_KEY]);
    expect(revetOpenAskTitles(AGENT)).toBe(0);
    expect(titleOf(workId)).toBe(workId);
  });
});
