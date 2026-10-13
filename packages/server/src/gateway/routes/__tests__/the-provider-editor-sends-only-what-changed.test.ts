// ════════════════════════════════════════════════════════════════════════════════════════
// THE PER-PROVIDER EDITOR'S ANTI-TRAP, DRIVEN AGAINST THE REAL DOORS.
//
// T66b states the editor's invariant as "TWO DOORS, ONE SAVE": each write door owns its own
// columns so neither can rewrite the other's, and a field the user did not touch is NEVER
// MENTIONED in any request. The second half is the anti-trap, and until this task nothing
// checked it — `packages/dashboard` has no test runner, so every rule inside `Settings.tsx`
// was a rule nothing held.
//
// The reading-speed override beside the engine's own measurement is REFUSED BY NAME on the
// identity door, so an only-what-changed bug here is not cosmetic: it either 400s the whole save
// or silently clears a number its owner deliberately set. (Its sibling field, the unattended
// budget, was deleted by t137 with the total-time cap it set — OR-LONG-JOBS.)
//
// ── WHY THIS FILE LIVES IN `packages/server` ──
// The decision it tests is a pure module in the dashboard (`lib/provider-edits.ts`), imported
// here directly — the same arrangement `agent/access/__tests__/the-panel-speaks-plainly.test.ts`
// already uses for `dashboard/src/lib/access-summary.ts`. The form's rule and the door's rule
// are then checked against EACH OTHER in one file, which is the only place that agreement can
// be observed at all.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

vi.mock('../../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-provider-editor-doors');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-provider-editor-doors', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { configRouter } from '../config.js';
import {
  numberEditsFor,
  parseReadingSpeed,
  THROUGHPUT_MIN_TOK_PER_SEC,
  THROUGHPUT_MAX_TOK_PER_SEC,
} from '../../../../../dashboard/src/lib/provider-edits.js';

const db = (): Database.Database => mockDb.current!;

const seed = (over: Partial<{ prefill: number | null }> = {}): void => {
  db().prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, behaves_like,
                           first_chunk_timeout_ms, stream_idle_timeout_ms,
                           prefill_tokens_per_sec,
                           is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', 'http://localhost:8000/v1', 'none', 'deepseek',
            600000, 120000, ?, 1, datetime('now'), datetime('now'))
  `).run(over.prefill ?? null);
};

const row = (): Record<string, unknown> =>
  db().prepare('SELECT * FROM providers WHERE id = ?').get('local') as Record<string, unknown>;

const patch = async (path: string, body: unknown): Promise<Response> =>
  configRouter.request(path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE FORM'S HALF — only what moved is ever mentioned.
// ════════════════════════════════════════════════════════════════════════════════════════
// t137 (OR-LONG-JOBS): the per-provider unattended budget is deleted with the total-time cap it
// set, so the form holds ONE narrow-door number now. The only-what-moved rule is unchanged.
describe('the editor mentions a number only when the user moved it', () => {
  const stored = { prefillTokensPerSec: 200 };

  it('an untouched form sends NOTHING — not the stored value back, not a null', () => {
    const r = numberEditsFor(stored, { tokensPerSec: '200' });
    expect(r.ok && r.edits).toEqual({});
    // The clause that matters: the key is ABSENT, so the door is not called at all. A `null`
    // here would clear a number nobody touched, which is the trap this rule exists for.
    expect(r.ok && 'prefillTokensPerSec' in r.edits).toBe(false);
  });

  it('a moved READING SPEED sends the speed', () => {
    const r = numberEditsFor(stored, { tokensPerSec: '250' });
    expect(r.ok && r.edits).toEqual({ prefillTokensPerSec: 250 });
  });

  it('a CLEARED field is a present null — "call the door and clear it", not "do not call"', () => {
    const r = numberEditsFor(stored, { tokensPerSec: '' });
    expect(r.ok && r.edits).toEqual({ prefillTokensPerSec: null });
  });

  it('a provider that had declared nothing, and still has, mentions nothing', () => {
    const r = numberEditsFor({ prefillTokensPerSec: null }, { tokensPerSec: '  ' });
    expect(r.ok && r.edits).toEqual({});
  });

  it('refuses an unparseable field rather than sending anything', () => {
    const r = numberEditsFor(stored, { tokensPerSec: '999999999' });
    expect(r.ok).toBe(false);
  });
});

describe('the form pre-validates with the SERVER\'s own bounds', () => {
  it('the reading speed: no zero sentinel here — 0 is simply out of range', () => {
    expect(parseReadingSpeed('')).toEqual({ ok: true, value: null });
    expect(parseReadingSpeed('0').ok, 'zero means nothing here').toBe(false);
    expect(parseReadingSpeed(String(THROUGHPUT_MIN_TOK_PER_SEC)).ok).toBe(true);
    expect(parseReadingSpeed(String(THROUGHPUT_MAX_TOK_PER_SEC)).ok).toBe(true);
    expect(parseReadingSpeed(String(THROUGHPUT_MAX_TOK_PER_SEC + 1)).ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE DOORS' HALF — what the form decides, the server accepts, and nothing else moves.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('the narrow doors, and the one t137 deleted', () => {
  it('t137: the unattended-budget door is GONE, and the identity door refuses the field rather than storing it', async () => {
    seed();
    const before = row();
    expect(before, 'the column is dropped by migration 186').not.toHaveProperty('max_unattended_minutes');
    expect((await patch('/providers/local/unattended-budget', { unattendedBudgetMinutes: 240 })).status).toBe(404);
    // `.strict()` on the identity door: an old client still sending the field is told no, and
    // nothing on the row moves.
    expect((await patch('/providers/local', { unattendedBudgetMinutes: 240 })).status).toBe(400);
    const after = row();
    for (const key of Object.keys(before)) {
      if (key === 'updated_at') continue;
      expect(after[key], `${key} must be untouched`).toEqual(before[key]);
    }
  });

  it('the speed door is narrow: it moves its own number and nothing else on the row', async () => {
    seed({ prefill: null });
    const before = row();
    expect((await patch('/providers/local/prefill-throughput', { prefillTokensPerSec: 250 })).status).toBe(200);
    const after = row();
    expect(after.prefill_tokens_per_sec).toBe(250);
    for (const key of Object.keys(before)) {
      if (key === 'prefill_tokens_per_sec' || key === 'updated_at') continue;
      expect(after[key], `${key} must be untouched`).toEqual(before[key]);
    }
  });

  it('and the speed door may not be reached through the identity door — refused by name', async () => {
    // The reason the form cannot shortcut by folding it into `edit`. If this ever stops being
    // true, the editor's "two doors" invariant has quietly become one door.
    seed();
    const res = await patch('/providers/local', { prefillTokensPerSec: 250 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toMatch(/prefill-throughput/);
  });
});

describe('the measured reading is READ-ONLY — the platform observes, the form does not write', () => {
  it('no write door accepts it, under either spelling', async () => {
    seed();
    const attempts: Array<[string, unknown]> = [
      ['/providers/local', { measuredPrefillTokensPerSec: 181 }],
      ['/providers/local/prefill-throughput', { measuredPrefillTokensPerSec: 181 }],
    ];
    for (const [path, body] of attempts) {
      expect((await patch(path, body)).status, `${path} must refuse it`).toBe(400);
    }
    expect(row().measured_prefill_tokens_per_sec).toBeNull();
  });

  it('but it IS read back, so the form can show it as information', async () => {
    seed();
    db().prepare(
      "UPDATE providers SET measured_prefill_tokens_per_sec = 181.07, measured_prefill_at = datetime('now') WHERE id = 'local'",
    ).run();
    const res = await configRouter.request('/providers/local');
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { measuredPrefillTokensPerSec: number; measuredPrefillAt: string } };
    expect(body.data.measuredPrefillTokensPerSec).toBeCloseTo(181.07, 2);
    expect(body.data.measuredPrefillAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});
