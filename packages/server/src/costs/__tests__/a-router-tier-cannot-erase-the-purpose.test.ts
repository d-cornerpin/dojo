// ════════════════════════════════════════════════════════════════════════════════════════
// A ROUTER TIER CANNOT ERASE WHAT THE CALL WAS — `cost_records.call_purpose` (migration 181).
//
// ── THE DEFECT THIS FILE PINS, WHICH IS THE HALF `a-utility-dial-is-not-an-agent-turn` DOES
//    NOT COVER ──
// BACKLOG line 61 is about telling a utility dial from a real turn, and its first half is
// closed: t88's `ModelCallParams.purpose` is declared at the one served-turn dial and every
// `recordCost` site writes `routerTier ?? purpose ?? 'completion'`, so a probe no longer lands
// as `agent_turn`. The sibling file holds that property, both ways, by evaluating the
// expression itself.
//
// But that expression is a `??` CHAIN INTO ONE COLUMN, and a chain's leftmost truth erases the
// ones behind it. `request_type` is being asked to hold three different facts:
//
//     routerTier ?? purpose ?? 'completion'
//     └─ the ROUTER'S DECISION      'light' | 'standard' | 'heavy' | 'budget_fallback'
//                   └─ the CALL'S PURPOSE   'agent_turn' | 'ask_title' | …
//                                 └─ "nobody said"
//
// So a served agent turn that went through the auto-router records `light`, and THAT IT WAS A
// TURN IS GONE FROM THE ROW. The consumer question line 61 was filed about — "how big is a real
// turn on this box" — therefore still had no predicate that answers it: `request_type =
// 'agent_turn'` silently omits every tiered turn, and `request_type IN ('light', …)` cannot tell
// a tiered turn from a tiered utility dial. Guessing from the row's SIZE is the heuristic the
// line says the kit was twice forced into, and it is what a missing axis leaves a reader.
//
// ── WHAT IS ASSERTED, AND WHY EACH DIRECTION ──
// `call_purpose` is the purpose on its own axis. The clauses below are deliberately paired so
// that neither half can be satisfied by deleting the other:
//
//   1. THE ROW SHAPE. A tiered turn stores request_type='light' AND call_purpose='agent_turn' —
//      the row that was previously unreadable. Driven through the real `recordCost` against a
//      real migrated body, not asserted about a string.
//   2. NOTHING MOVED. `request_type` is byte-identical to what it was: same expression, same
//      value on every shape. A column that holds a fact ALSO being recorded elsewhere must not
//      be quietly re-pointed, and the only way to know is to assert the old value too.
//   3. NULL IS A FACT. An undeclared dial stores NULL, not `'completion'` and not a guess. The
//      writer is forbidden from reconstructing the purpose from `request_type` — that is where
//      a plausible fiction would enter the column this whole change exists to make trustworthy.
//   4. EVERY SITE, NOT THE ONES WE REMEMBERED. The source-side clause reads `agent/model.ts`
//      and requires that the count of `callPurpose:` expressions equals the count of
//      `requestType:` expressions, and that each one reads `purpose` and NOT `routerTier`.
//      That is the BOTH-WAYS half (G4): a fifth recordCost site added tomorrow without the new
//      axis turns this red, which a presence-only clause would not.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-call-purpose', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../db/migrations.js';
import { recordCost } from '../tracker.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../../..');
const MODEL_TS = path.join(REPO_ROOT, 'packages/server/src/agent/model.ts');

const db = (): Database.Database => mockDb.current!;

/** A body with one provider, one model and one agent — the minimum `recordCost` needs. */
function seed(): void {
  const d = db();
  d.prepare(`
    INSERT INTO providers (id, name, type, auth_type, is_validated, created_at, updated_at)
    VALUES ('prov', 'Prov', 'openai', 'api_key', 1, datetime('now'), datetime('now'))
  `).run();
  d.prepare(`
    INSERT INTO models (id, provider_id, name, api_model_id, capabilities, context_window,
                        max_output_tokens, input_cost_per_m, output_cost_per_m,
                        is_enabled, created_at, updated_at)
    VALUES ('mdl', 'prov', 'Mdl', 'mdl-1', '["text","tools"]', 65536, 8192, 1.0, 3.0, 1,
            datetime('now'), datetime('now'))
  `).run();
  d.prepare(`
    INSERT INTO agents (id, name, model_id, status, created_at, updated_at)
    VALUES ('ag', 'Ag', 'mdl', 'idle', datetime('now'), datetime('now'))
  `).run();
}

/** Record one call exactly as `agent/model.ts` does, and read the two axes back. */
function recordAndRead(
  routerTier: string | undefined,
  purpose: string | undefined,
): { requestType: string | null; callPurpose: string | null } {
  recordCost({
    agentId: 'ag', modelId: 'mdl', providerId: 'prov',
    inputTokens: 1_000, outputTokens: 100, latencyMs: 2_000,
    // THE PRODUCTION EXPRESSIONS, both of them, copied as the shape under test.
    requestType: routerTier ?? purpose ?? 'completion',
    callPurpose: purpose,
  });
  const row = db().prepare(
    'SELECT request_type AS requestType, call_purpose AS callPurpose FROM cost_records ORDER BY rowid DESC LIMIT 1',
  ).get() as { requestType: string | null; callPurpose: string | null };
  return row;
}

beforeEach(() => {
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  seed();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('the row a router tier used to make unreadable', () => {
  it('RED-CRITICAL: a TIERED AGENT TURN still says it was a turn', () => {
    const row = recordAndRead('light', 'agent_turn');
    expect(
      row.callPurpose,
      'a served agent turn that went through the auto-router records only the TIER, so no '
      + 'predicate on this table can find real turns — which is the consumer question BACKLOG '
      + 'line 61 was filed about, and the size heuristic it says the kit fell back to twice.',
    ).toBe('agent_turn');
  });

  it('every router tier, not just the one we happened to pick', () => {
    for (const tier of ['light', 'standard', 'heavy', 'budget_fallback']) {
      expect(recordAndRead(tier, 'agent_turn').callPurpose).toBe('agent_turn');
    }
  });

  it('a TIERED UTILITY DIAL is distinguishable from a tiered turn — the other half of the ask', () => {
    // Both rows carry request_type='heavy'. Before the axis existed they were the same row.
    const turn = recordAndRead('heavy', 'agent_turn');
    const dial = recordAndRead('heavy', 'memory_summarize');
    expect(turn.requestType).toBe(dial.requestType);
    expect(turn.callPurpose).not.toBe(dial.callPurpose);
    expect(dial.callPurpose).toBe('memory_summarize');
  });

  it('an UNTIERED turn is a turn on both axes', () => {
    expect(recordAndRead(undefined, 'agent_turn'))
      .toEqual({ requestType: 'agent_turn', callPurpose: 'agent_turn' });
  });
});

describe('`request_type` is not re-pointed — the old column still answers the old way', () => {
  it('every shape stores exactly what the unchanged expression produces', () => {
    expect(recordAndRead('light', 'agent_turn').requestType).toBe('light');
    expect(recordAndRead(undefined, 'ask_title').requestType).toBe('ask_title');
    expect(recordAndRead(undefined, undefined).requestType).toBe('completion');
    expect(recordAndRead('budget_fallback', undefined).requestType).toBe('budget_fallback');
  });
});

describe('NULL is a fact about the row, not a missing value', () => {
  it('RED-CRITICAL: an UNDECLARED dial stores NULL — the writer never invents a purpose', () => {
    const row = recordAndRead(undefined, undefined);
    expect(
      row.callPurpose,
      "an undeclared dial stored a purpose it never declared. `'completion'` here would be the "
      + 'writer reconstructing from `request_type` the fact the caller withheld, which puts a '
      + 'plausible fiction in the column this change exists to make trustworthy.',
    ).toBeNull();
  });

  it('a tiered undeclared dial is also NULL — the tier is not a purpose either', () => {
    expect(recordAndRead('standard', undefined).callPurpose).toBeNull();
  });
});

describe('EVERY recordCost site carries the axis — the both-ways clause (G4)', () => {
  const src = (): string => fs.readFileSync(MODEL_TS, 'utf-8');
  /** Comments stripped first (G4): a clause satisfiable by the prose above a call tests prose. */
  const code = (): string => src()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n');

  it('the count of purpose axes equals the count of request types — a new site cannot skip it', () => {
    const requestTypes = [...code().matchAll(/requestType:\s*(.+?),\n/g)].map(m => m[1].trim());
    const purposes = [...code().matchAll(/callPurpose:\s*(.+?),\n/g)].map(m => m[1].trim());
    expect(requestTypes.length, 'the extraction anchor moved and both counts would be 0').toBeGreaterThanOrEqual(4);
    expect(
      purposes.length,
      `${requestTypes.length} recordCost sites in model.ts declare a requestType but only `
      + `${purposes.length} declare a callPurpose. A site that records cost without the purpose `
      + 'axis writes a row no turn-size reader can classify — the defect, re-entering through a '
      + 'site added later.',
    ).toBe(requestTypes.length);
  });

  it('each axis reads the DECLARATION and never the router tier', () => {
    for (const expr of [...code().matchAll(/callPurpose:\s*(.+?),\n/g)].map(m => m[1].trim())) {
      expect(expr, `\`${expr}\` must be the declared purpose`).toContain('purpose');
      expect(
        expr,
        `\`${expr}\` folds the router tier into the purpose axis. That is the conflation this `
        + 'column was added to end, reproduced inside the new column.',
      ).not.toMatch(/\brouterTier\b/);
      expect(expr, `\`${expr}\` reads the tools cargo; the cargo cannot decide the kind`).not.toMatch(/\btools\b/);
    }
  });

  it('the writer stores the column and does not derive it from `request_type`', () => {
    const tracker = fs.readFileSync(path.join(REPO_ROOT, 'packages/server/src/costs/tracker.ts'), 'utf-8');
    expect(tracker, 'the INSERT no longer names the column').toMatch(/call_purpose/);
    // The APPLICATION, not the presence: the bound value must be the param or NULL.
    expect(tracker, 'the bound value is not `callPurpose ?? null`').toMatch(/callPurpose \?\? null/);
    // The BOUND VALUE, isolated: the one line inside the INSERT's argument list that supplies
    // this column. The `const { … } = params` destructure legitimately names both fields on one
    // line, so a whole-file proximity match would test that line instead of the writer.
    const boundLine = tracker.split('\n')
      .filter(l => !/^\s*(\/\/|\*)/.test(l))
      .find(l => /^\s*callPurpose \?\? null,\s*$/.test(l));
    expect(boundLine, 'no line in the INSERT binds the column as `callPurpose ?? null`').toBeTruthy();
    expect(
      boundLine,
      'the bound value mentions requestType — the writer is reconstructing a withheld fact',
    ).not.toMatch(/requestType/);
  });
});
