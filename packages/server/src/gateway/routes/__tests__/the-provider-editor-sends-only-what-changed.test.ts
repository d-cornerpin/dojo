// ════════════════════════════════════════════════════════════════════════════════════════
// THE PER-PROVIDER EDITOR'S ANTI-TRAP, DRIVEN AGAINST THE REAL DOORS.
//
// T66b states the editor's invariant as "TWO DOORS, ONE SAVE": each write door owns its own
// columns so neither can rewrite the other's, and a field the user did not touch is NEVER
// MENTIONED in any request. The second half is the anti-trap, and until this task nothing
// checked it — `packages/dashboard` has no test runner, so every rule inside `Settings.tsx`
// was a rule nothing held.
//
// Two of that form's fields are new (2026-09-22): the unattended budget, whose PATCH door has
// existed since T79b with no way to reach it, and the reading-speed override beside the
// engine's own measurement. Both are REFUSED BY NAME on the identity door, so an
// only-what-changed bug here is not cosmetic: it either 400s the whole save or silently clears
// a number its owner deliberately set.
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
  const dir = p.join(o.tmpdir(), 'dojo-provider-editor-doors');
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-provider-editor-doors', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { configRouter } from '../config.js';
import {
  numberEditsFor,
  parseUnattendedMinutes,
  parseReadingSpeed,
  UNATTENDED_MIN_MINUTES,
  UNATTENDED_MAX_MINUTES,
  UNATTENDED_UNCAPPED,
  THROUGHPUT_MIN_TOK_PER_SEC,
  THROUGHPUT_MAX_TOK_PER_SEC,
} from '../../../../../dashboard/src/lib/provider-edits.js';

const db = (): Database.Database => mockDb.current!;

const seed = (over: Partial<{ prefill: number | null; unattended: number | null }> = {}): void => {
  db().prepare(`
    INSERT INTO providers (id, name, type, base_url, auth_type, behaves_like,
                           first_chunk_timeout_ms, stream_idle_timeout_ms,
                           prefill_tokens_per_sec, max_unattended_minutes,
                           is_validated, created_at, updated_at)
    VALUES ('local', 'Local DS4', 'openai-compatible', 'http://localhost:8000/v1', 'none', 'deepseek',
            600000, 120000, ?, ?, 1, datetime('now'), datetime('now'))
  `).run(over.prefill ?? null, over.unattended ?? null);
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
describe('the editor mentions a number only when the user moved it', () => {
  const stored = { prefillTokensPerSec: 200, unattendedBudgetMinutes: 120 };

  it('an untouched form sends NOTHING — not the stored values back, not nulls', () => {
    const r = numberEditsFor(stored, { tokensPerSec: '200', unattendedMinutes: '120' });
    expect(r.ok && r.edits).toEqual({});
    // The clause that matters: the keys are ABSENT, so neither door is called at all. A `null`
    // here would clear a number nobody touched, which is the trap this rule exists for.
    expect(r.ok && 'prefillTokensPerSec' in r.edits).toBe(false);
    expect(r.ok && 'unattendedBudgetMinutes' in r.edits).toBe(false);
  });

  it('a moved BUDGET sends the budget and nothing else', () => {
    const r = numberEditsFor(stored, { tokensPerSec: '200', unattendedMinutes: '240' });
    expect(r.ok && r.edits).toEqual({ unattendedBudgetMinutes: 240 });
    expect(r.ok && 'prefillTokensPerSec' in r.edits).toBe(false);
  });

  it('a moved READING SPEED sends the speed and nothing else', () => {
    const r = numberEditsFor(stored, { tokensPerSec: '250', unattendedMinutes: '120' });
    expect(r.ok && r.edits).toEqual({ prefillTokensPerSec: 250 });
    expect(r.ok && 'unattendedBudgetMinutes' in r.edits).toBe(false);
  });

  it('a CLEARED field is a present null — "call the door and clear it", not "do not call"', () => {
    const r = numberEditsFor(stored, { tokensPerSec: '', unattendedMinutes: '' });
    expect(r.ok && r.edits).toEqual({ prefillTokensPerSec: null, unattendedBudgetMinutes: null });
  });

  it('a provider that had declared nothing, and still has, mentions nothing', () => {
    const blank = { prefillTokensPerSec: null, unattendedBudgetMinutes: null };
    const r = numberEditsFor(blank, { tokensPerSec: '', unattendedMinutes: '  ' });
    expect(r.ok && r.edits).toEqual({});
  });

  it('ZERO is a real declaration on the budget and a real change from blank', () => {
    const blank = { prefillTokensPerSec: null, unattendedBudgetMinutes: null };
    const r = numberEditsFor(blank, { tokensPerSec: '', unattendedMinutes: '0' });
    expect(r.ok && r.edits).toEqual({ unattendedBudgetMinutes: UNATTENDED_UNCAPPED });
  });

  it('refuses the whole batch on an unparseable field rather than sending half of it', () => {
    const r = numberEditsFor(stored, { tokensPerSec: '999999999', unattendedMinutes: '240' });
    expect(r.ok).toBe(false);
  });
});

describe('the form pre-validates with the SERVER\'s own bounds', () => {
  it('the budget: blank, 0, and the declared range — everything else is a sentence, not a 400', () => {
    expect(parseUnattendedMinutes('')).toEqual({ ok: true, value: null });
    expect(parseUnattendedMinutes('0')).toEqual({ ok: true, value: 0 });
    expect(parseUnattendedMinutes(String(UNATTENDED_MIN_MINUTES))).toEqual({ ok: true, value: UNATTENDED_MIN_MINUTES });
    expect(parseUnattendedMinutes(String(UNATTENDED_MAX_MINUTES))).toEqual({ ok: true, value: UNATTENDED_MAX_MINUTES });
    expect(parseUnattendedMinutes(String(UNATTENDED_MIN_MINUTES - 1)).ok).toBe(false);
    expect(parseUnattendedMinutes(String(UNATTENDED_MAX_MINUTES + 1)).ok).toBe(false);
    expect(parseUnattendedMinutes('30.5').ok).toBe(false);
    expect(parseUnattendedMinutes('soon').ok).toBe(false);
  });

  it('the reading speed: no zero sentinel here — 0 is simply out of range', () => {
    expect(parseReadingSpeed('')).toEqual({ ok: true, value: null });
    expect(parseReadingSpeed('0').ok, 'unlike the budget, zero means nothing here').toBe(false);
    expect(parseReadingSpeed(String(THROUGHPUT_MIN_TOK_PER_SEC)).ok).toBe(true);
    expect(parseReadingSpeed(String(THROUGHPUT_MAX_TOK_PER_SEC)).ok).toBe(true);
    expect(parseReadingSpeed(String(THROUGHPUT_MAX_TOK_PER_SEC + 1)).ok).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE DOORS' HALF — what the form decides, the server accepts, and nothing else moves.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('the budget door still enforces its own validation, whatever the form did', () => {
  it('accepts what the form would send and touches NOTHING else on the row', async () => {
    seed({ prefill: 200, unattended: 120 });
    const before = row();
    const res = await patch('/providers/local/unattended-budget', { unattendedBudgetMinutes: 240 });
    expect(res.status).toBe(200);
    const after = row();
    expect(after.max_unattended_minutes).toBe(240);
    for (const key of Object.keys(before)) {
      if (key === 'max_unattended_minutes' || key === 'updated_at') continue;
      expect(after[key], `${key} must be untouched`).toEqual(before[key]);
    }
  });

  it('stores 0 as NO CAP, and clears back to the standard hour with null', async () => {
    seed({ unattended: 120 });
    expect((await patch('/providers/local/unattended-budget', { unattendedBudgetMinutes: 0 })).status).toBe(200);
    expect(row().max_unattended_minutes).toBe(0);
    expect((await patch('/providers/local/unattended-budget', { unattendedBudgetMinutes: null })).status).toBe(200);
    expect(row().max_unattended_minutes).toBeNull();
  });

  it('REFUSES the values the form refuses, and does not mutate on the way out', async () => {
    seed({ unattended: 120 });
    for (const bad of [UNATTENDED_MIN_MINUTES - 1, UNATTENDED_MAX_MINUTES + 1, 30.5, -1]) {
      const res = await patch('/providers/local/unattended-budget', { unattendedBudgetMinutes: bad });
      expect(res.status, `${bad} must be refused`).toBe(400);
      expect(row().max_unattended_minutes, 'a refusal is not a write').toBe(120);
    }
  });

  it('the speed door is the same door for the other number, and equally narrow', async () => {
    seed({ prefill: null, unattended: 120 });
    const before = row();
    expect((await patch('/providers/local/prefill-throughput', { prefillTokensPerSec: 250 })).status).toBe(200);
    const after = row();
    expect(after.prefill_tokens_per_sec).toBe(250);
    for (const key of Object.keys(before)) {
      if (key === 'prefill_tokens_per_sec' || key === 'updated_at') continue;
      expect(after[key], `${key} must be untouched`).toEqual(before[key]);
    }
  });

  it('and NEITHER door may be reached through the identity door — both are refused by name', async () => {
    // The reason the form cannot shortcut by folding these into `edit`. If this ever stops
    // being true, the editor's "two doors" invariant has quietly become one door.
    seed();
    for (const body of [{ unattendedBudgetMinutes: 240 }, { prefillTokensPerSec: 250 }]) {
      const res = await patch('/providers/local', body);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(/unattended-budget|prefill-throughput/);
    }
  });
});

describe('the measured reading is READ-ONLY — the platform observes, the form does not write', () => {
  it('no write door accepts it, under either spelling', async () => {
    seed();
    const attempts: Array<[string, unknown]> = [
      ['/providers/local', { measuredPrefillTokensPerSec: 181 }],
      ['/providers/local/prefill-throughput', { measuredPrefillTokensPerSec: 181 }],
      ['/providers/local/unattended-budget', { measuredPrefillTokensPerSec: 181 }],
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
