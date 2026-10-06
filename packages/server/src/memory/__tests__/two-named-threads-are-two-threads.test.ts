// t109 item B — THE A2A SALIENCE DEDUPE KEYED ON THE SHARED PREFIX OF A THREAD ID.
//
// BACKLOG (2026-10-05, t90 re-review 2 out-of-scope, pre-existing), verbatim: *"A2A SALIENCE
// DEDUPE KEYS ON THE FIRST 8 CHARACTERS OF A THREAD ID on both sides (`memory/assembler.ts:1657`
// `substr(thread_id,1,8)`; `parseA2AThreadShort` → `slice(0, A2A_THREAD_SHORT_LENGTH)`,
// `packages/shared/src/markers.ts:127–131`). For the PM's NAMED thread ids
// (`thread-<hash>-<seed>`) that prefix is `thread-` plus ONE hash character, so named threads
// largely collide in the dedupe. Flagged, not diagnosed."*
//
// DIAGNOSED AT THIS HEAD. The dedupe is at `assembler.ts:1704` now, not `:1657`, and the
// mechanism is exactly as the line guessed: the stored side read `substr(thread_id,1,8)` — the
// FRONT eight characters of the full id — and the marker carried its own front eight. For every
// id `makeThreadId` mints the front eight are `thread-` plus ONE base36 hash character, so all
// named threads fall into about 36 buckets. The consequence is not cosmetic: the dedupe's job is
// to FILTER OUT A2A messages the agent has already replied to, so one reply on one named thread
// filtered the salience lift off every OTHER named thread the agent had not answered — and the
// salience lift is the whole reason a forced A2A turn can see the message it owes a reply to.
//
// THE FIX, on both sides, and the shape of it:
//   · the PRODUCER (`a2aThreadShort`, `markers.ts`) takes its eight characters from the id with
//     the shared `thread-` prefix REMOVED, so the hash leads. Same length, same wire grammar,
//     same bytes for a UUID-shaped id; only named ids move.
//   · the CONSUMER (the dedupe) selects whole FULL ids and matches through
//     `a2aThreadTokenMatches`, which accepts the current token AND the legacy front slice — so a
//     marker already sitting in an agent's history keeps resolving against its own thread.
//
// §1 the key itself: two named threads, two keys · a UUID id unchanged · legacy both ways
// §2 the dedupe, driven end to end through `assembleContext` on the real schema
// §3 the wire clause: the dedupe may not go back to a front slice

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

import {
  a2aThreadShort, a2aThreadShortLegacy, a2aThreadTokenMatches, parseA2AThreadShort,
  A2A_THREAD_SHORT_LENGTH,
} from '@dojo/shared';
import { assembleContext } from '../assembler.js';
import { runMigrations } from '../../db/migrations.js';

const AGENT = 'agent-b';
const MODEL = 'model-b';
const PEER = 'peer-agent';

/** Two ids of the shape `makeThreadId` produces: `thread-<base36 hash>-<seed>`. Different
 *  seeds and different hashes — but the two hashes begin with the SAME character, which the
 *  front slice is all that reaches: `thread-` plus one hash char is only ~36 buckets, so this
 *  is not a contrived pair, it is one in thirty-six of every pair on the box. */
const THREAD_A = 'thread-1kq3za-review-01';
const THREAD_B = 'thread-1wtp4m-review-02';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 THE KEY
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the dedupe key', () => {
  it('⚠ B: two distinct NAMED threads no longer share a key', () => {
    // The defect, stated as an identity: the FRONT slices ARE equal.
    expect(a2aThreadShortLegacy(THREAD_A), 'the shape of the bug, pinned')
      .toBe(a2aThreadShortLegacy(THREAD_B));
    expect(a2aThreadShortLegacy(THREAD_A)).toBe('thread-1');
    // The fix: the varying region leads, so the two keys differ.
    expect(a2aThreadShort(THREAD_A)).not.toBe(a2aThreadShort(THREAD_B));
    expect(a2aThreadShort(THREAD_A)).toBe('1kq3za-r');
    expect(a2aThreadShort(THREAD_B)).toBe('1wtp4m-r');
  });

  it('the key is still exactly A2A_THREAD_SHORT_LENGTH characters — the marker shape is untouched', () => {
    for (const t of [THREAD_A, THREAD_B]) {
      expect(a2aThreadShort(t).length).toBe(A2A_THREAD_SHORT_LENGTH);
    }
  });

  it('a UUID-shaped thread id is byte-identical to the pre-t109 key', () => {
    const uuid = '9f2c1a04-7b3e-4f21-a8d5-6c0e1b2d3f44';
    expect(a2aThreadShort(uuid)).toBe(a2aThreadShortLegacy(uuid));
    expect(a2aThreadShort(uuid)).toBe('9f2c1a04');
  });

  it('⚠ B, BOTH DIRECTIONS: a LEGACY marker still resolves, and a legacy marker for the OTHER thread does not', () => {
    // A marker written before t109 carries the front slice.
    const legacyToken = a2aThreadShortLegacy(THREAD_A);
    expect(a2aThreadTokenMatches(legacyToken, THREAD_A), 'history keeps working').toBe(true);
    // ⚠ THE HONEST RESIDUAL, stated rather than hidden: a legacy token cannot distinguish two
    // named threads — that information was never written down — so it still matches both. What
    // the fix guarantees is that a CURRENT token never does.
    expect(a2aThreadTokenMatches(legacyToken, THREAD_B), 'a legacy token carries no more information than it ever did').toBe(true);
    expect(a2aThreadTokenMatches(a2aThreadShort(THREAD_A), THREAD_B), 'but a current token is exact').toBe(false);
    expect(a2aThreadTokenMatches(a2aThreadShort(THREAD_A), THREAD_A)).toBe(true);
  });

  it('an empty or absent token matches nothing', () => {
    expect(a2aThreadTokenMatches('', THREAD_A)).toBe(false);
    expect(a2aThreadTokenMatches(a2aThreadShort(THREAD_A), '')).toBe(false);
  });

  it('`parseA2AThreadShort` is unchanged — it reads whatever the marker carries', () => {
    expect(parseA2AThreadShort(`[A2A:QUESTION thread:${a2aThreadShort(THREAD_A)} from:Peer] hi`))
      .toBe('1kq3za-r');
    expect(parseA2AThreadShort(`[A2A:QUESTION thread:${a2aThreadShortLegacy(THREAD_A)} from:Peer] hi`))
      .toBe('thread-1');
    expect(parseA2AThreadShort('no marker here')).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 THE DEDUPE, END TO END
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Driven through the real `assembleContext` on the real migrated schema, because the defect is
// not in the key function — it is in what the assembly DOES with it. The agent has replied on
// thread A and NOT on thread B; the forced A2A turn must still surface B.

function seedBox(): void {
  const db = mockDb.current!;
  db.prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db.prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'm', 'M', 128000, 4096, '["tools"]')`,
  ).run(MODEL);
  db.prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Zargo', 'idle', ?)")
    .run(AGENT, MODEL);
  db.prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Maddy', 'idle', ?)")
    .run(PEER, MODEL);
}

/** One inbound A2A row, with the structural columns AND the prose marker the readers parse. */
function seedInbound(id: string, threadId: string, token: string, at: number): void {
  mockDb.current!.prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, source_agent_id, content,
                           display_kind, display_tier, a2a_thread_id, a2a_intent,
                           a2a_requires_response, turn_number, provenance, authorized, created_at)
     VALUES (?, ?, 'user', 'a2a', ?, ?, ?, 'a2a', 'agent-only', ?, 'QUESTION', 1, 1, 'live', 1, ?)`,
  ).run(
    id, AGENT, PEER, PEER,
    `[A2A:QUESTION thread:${token} from:Maddy] can you confirm the ${id} number?`,
    threadId, at,
  );
}

/** The agent's recorded reply on a thread — the row the dedupe reads. `thread_id` holds the
 *  FULL id, which is what `recordA2AReply` writes. */
function seedReply(assignMessageId: string, threadId: string): void {
  mockDb.current!.prepare(
    `INSERT INTO a2a_replies (assign_message_id, agent_id, thread_id, reply_intent, replied_at)
     VALUES (?, ?, ?, 'ANSWER', datetime('now'))`,
  ).run(assignMessageId, AGENT, threadId);
}

async function a2aTurnText(): Promise<string> {
  const ctx = await assembleContext(AGENT, MODEL, { latestUserSource: null, isA2ATurn: true });
  return ctx.messages
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

describe('§2 a reply on one named thread does not hide another', () => {
  beforeEach(seedBox);

  it('⚠ B: replied on A, unreplied on B — the forced turn still sees B', async () => {
    seedInbound('msg-a', THREAD_A, a2aThreadShort(THREAD_A), 1_785_000_001_000);
    seedInbound('msg-b', THREAD_B, a2aThreadShort(THREAD_B), 1_785_000_002_000);
    seedReply('msg-a', THREAD_A);

    const text = await a2aTurnText();
    expect(text, 'the unreplied thread is what the forced turn exists for').toContain('msg-b');
    expect(text, 'and the answered one is filtered, which is the dedupe working').not.toContain('msg-a');
  });

  it('THE CONTROL, the other direction: replied on BOTH and neither is lifted', async () => {
    seedInbound('msg-a', THREAD_A, a2aThreadShort(THREAD_A), 1_785_000_001_000);
    seedInbound('msg-b', THREAD_B, a2aThreadShort(THREAD_B), 1_785_000_002_000);
    seedReply('msg-a', THREAD_A);
    seedReply('msg-b', THREAD_B);

    const text = await a2aTurnText();
    expect(text, 'a thread the agent answered stays filtered').not.toContain('msg-a');
    expect(text, 'and so does the other one — the dedupe is not simply disabled').not.toContain('msg-b');
  });

  it('⚠ B, THE LEGACY DIRECTION: a marker carrying the OLD front slice still dedupes', async () => {
    // Exactly one thread, exactly one reply, and the marker in the history is the pre-t109
    // shape. The row must still be recognised as answered.
    seedInbound('msg-old', THREAD_A, a2aThreadShortLegacy(THREAD_A), 1_785_000_001_000);
    seedReply('msg-old', THREAD_A);
    const text = await a2aTurnText();
    expect(text, 'an already-answered legacy row is still filtered').not.toContain('msg-old');
  });

  it('and an UNANSWERED legacy row is still lifted', async () => {
    seedInbound('msg-old', THREAD_A, a2aThreadShortLegacy(THREAD_A), 1_785_000_001_000);
    const text = await a2aTurnText();
    expect(text).toContain('msg-old');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 THE WIRE CLAUSE
// ════════════════════════════════════════════════════════════════════════════════════════
//
// Counted, not present-checked (G4): comments are stripped first, so the paragraph above the
// query cannot satisfy it, and the clause asserts the SHAPE of the read and its APPLICATION.

describe('§3 neither side may go back to a front slice', () => {
  const stripped = async (rel: string) => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    return readFileSync(join(here, rel), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  };

  it('the assembler selects whole thread ids and routes the match through the shared helper', async () => {
    const src = await stripped('../assembler.ts');
    expect(src, 'the bucketed read is gone')
      .not.toMatch(/substr\(\s*thread_id\s*,\s*1\s*,\s*8\s*\)/);
    expect(src, 'and the whole id is what comes back')
      .toMatch(/SELECT DISTINCT thread_id[^']*FROM a2a_replies/);
    expect(src, 'and it is APPLIED, not merely imported')
      .toMatch(/a2aThreadTokenMatches\(\s*token\s*,\s*full\s*\)/);
  });

  it('the transport writes the marker through the one producer', async () => {
    const src = await stripped('../../agent/a2a-transport.ts');
    expect(src, 'the marker token comes from `a2aThreadShort`, not from a hand-rolled slice')
      .toMatch(/const threadShort = a2aThreadShort\(threadId\);/);
    expect(src, 'and the `thread:` field in the envelope is that token')
      .toMatch(/thread:\$\{threadShort\}/);
  });
});
