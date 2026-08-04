// PHASE-6 T0D Step 3 — THE TITLE FALLBACK: THE DECISION, AS A TEST.
//
// The survey named this the class's second open half: `resolveIdIn` falls back to
// a TITLE match when the id search finds nothing, so an id that no longer exists
// can resolve to a DIFFERENT row that happens to be titled that way. Refusing
// stale ids at the doors while this stands would be a half-measure with a
// documented escape hatch.
//
// ── THE DECISION: IT STANDS, AND THE REASON IS AN INCIDENT ──
// The fallback is a recorded correctness floor (`schema.ts:731-742`, the
// 2026-07-17 PM 189-call spin): the weak model routinely passes the human
// readable TITLE it saw in a listing where an id is expected, and hard-failing
// that sent the PM into a retry loop on the same string. Deleting it re-opens a
// closed incident, which roadmap non-negotiable #2 forbids without converting
// its requirement into a test first — so this file converts it.
//
// ── AND THE HAZARD MEASURES ZERO, WHICH IS A MEASUREMENT AND NOT A HOPE ──
// The fallback is scoped THREE ways, and each is a clause below: it runs only
// after the id/prefix search found nothing, only against the caller's OWN rows,
// and only over `kind IN ('task','project')`. On the dev body at this commit:
// 340 tracker rows, of which 0 have an id-shaped title, 0 have a title equal to
// any other row's id, and 0 have a title equal to their own id. The 37 ask rows
// whose title IS their own id — T0B's ID-FIRST filing — are `kind='ask'` and are
// therefore outside the resolver's scope entirely, by construction rather than
// by luck.
//
// ── WHAT THIS TASK CHANGES: THE REFUSAL NAMES IT ──
// A model that passed a title and got `not_found` was told the id was not found
// and nothing else, so retrying the same title is the obvious next move — the
// 189-call spin from the other side. The refusal now says the title was tried
// too, which is the difference between steering a confused model and trapping
// one.

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
    getDbPath: () => path.join(os.tmpdir(), 'dojo-id-resolution-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { runMigrations } from '../../db/migrations.js';
import { resolveTaskId, formatResolveError } from '../schema.js';

const MINE = 'kevin';
const THEIRS = 'sensei';
const T = 1_700_000_000_000;

function seedTask(id: string, title: string, agentId = MINE): void {
  mockDb.current!.prepare(`
    INSERT INTO work (id, kind, agent_id, assignee_agent, requester, requester_id,
                      root_kind, root_id, state, intent, wakes, closes_thread,
                      title, opened_at, updated_at, provenance)
    VALUES (?, 'task', ?, ?, 'agent', ?, 'tracker', ?, 'open', 'tracker', 0, 0, ?, ?, ?, 'live')
  `).run(id, agentId, agentId, agentId, id, title, T, T);
}

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
});

describe('the title fallback: the requirement it encodes, kept as a test', () => {
  it('resolves the TITLE a weak model passed where an id belongs (the 2026-07-17 spin)', () => {
    seedTask('11111111-1111-4111-8111-111111111111', 'Mechanical Keyboards Research');
    const r = resolveTaskId('Mechanical Keyboards Research', MINE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('NEVER competes with a real id — the id search wins outright', () => {
    // The row whose ID is asked for, and a DIFFERENT row titled with that id.
    seedTask('22222222-2222-4222-8222-222222222222', 'the real one');
    seedTask('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222');
    const r = resolveTaskId('22222222-2222-4222-8222-222222222222', MINE);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.id).toBe('22222222-2222-4222-8222-222222222222');
  });

  it('is scoped to the caller’s own rows — another agent’s title does not resolve', () => {
    seedTask('44444444-4444-4444-8444-444444444444', 'Their Private Thing', THEIRS);
    expect(resolveTaskId('Their Private Thing', MINE).ok).toBe(false);
    // CONTROL: the same title DOES resolve for its owner, so the refusal above
    // is about the scope and not about the string.
    expect(resolveTaskId('Their Private Thing', THEIRS).ok).toBe(true);
  });

  it('does not run at all for an unscoped caller', () => {
    seedTask('55555555-5555-4555-8555-555555555555', 'Unscoped Lookup');
    expect(resolveTaskId('Unscoped Lookup').ok).toBe(false);
  });
});

describe('the refusal names the fallback, so a confused model is steered rather than trapped', () => {
  it('says the title was tried too when the caller was scoped', () => {
    seedTask('66666666-6666-4666-8666-666666666666', 'something else');
    const r = resolveTaskId('A Title That Is Not There', MINE);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('not_found');
    const text = formatResolveError('task', 'A Title That Is Not There', r);
    // The model must be able to tell "your id is wrong" from "neither your id
    // nor your title matched anything you own" — the second one means stop
    // retrying the string and go and list.
    expect(text).toMatch(/title/i);
    expect(text).toContain('no task of yours matches it as a title either');
    expect(text).toContain("work_update(action='list')");
  });

  it('does NOT claim a title was tried when it was not', () => {
    // Unscoped: the fallback cannot run, so saying it was tried would be a lie
    // in exactly the direction this whole task is closing.
    const r = resolveTaskId('A Title That Is Not There');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(formatResolveError('task', 'A Title That Is Not There', r))
      .not.toContain('as a title either');
  });

  it('leaves the other three refusal shapes exactly as they were', () => {
    expect(formatResolveError('task', '', { ok: false, reason: 'empty' }))
      .toBe('Error: task id is required.');
    expect(formatResolveError('task', 'ab', { ok: false, reason: 'too_short' }))
      .toContain('is too short');
    expect(formatResolveError('task', 'aaa', { ok: false, reason: 'ambiguous', matches: ['aaa1', 'aaa2'] }))
      .toContain('matches multiple tasks');
  });
});
