// ════════════════════════════════════════════════════════════════════════════════════════
// A RENAMED SERVICE AGENT KEEPS WORKING — the owner's rule, made mechanical.
//
// THE RULE (owner, 2026-09-26, verbatim): *"nothing about your code should be reliant on any specific
// agent names"*. Users name their agents whatever they like; the platform ships DEFAULT names
// (`config/platform.ts:62-174` — `Agent`, `PM`, `Trainer`, `Imaginer`, `Healer`, `Dreamer`) and every
// one of them is a config value the owner can change in the Settings panel. A comparison against the
// display-name LITERAL therefore breaks two ways at once, and both are real:
//
//   · RENAME the service agent and it silently loses what the platform grants it;
//   · NAME YOUR OWN agent "Dreamer" and it silently gains it.
//
// The v3.2.0 audit found four such sites. The two in `agent/spawner.ts` are one-token deletions (the
// id predicate is already evaluated beside the name on the same line) and the dashboard one is in
// `Settings.tsx`; the one that is unit-testable end to end is `tools/tool-docs.ts`'s
// `getDefaultForAgent`, whose own neighbouring lines resolve EVERY other service agent by config id
// and whose own comment at the site admitted the exception — *"Non-system agents: check by name
// (Dreamer) or classification"*.
//
// ── WHAT WAS RED, AND ON WHAT ────────────────────────────────────────────────────────────
// Both behavioural clauses below were written first and measured against the pre-fix tree on a
// scratch (in-memory) database, which is the same shape the dev box would give:
//
//   renamed Dreamer  (id `dreamer`, name `Sandman`)  ->  got SUB_AGENT_ALWAYS_LOADED (9 tools),
//                                                        LOST 3 of the 12 the Dreamer is granted,
//                                                        including `vault_write` and `dream_log`
//   impostor         (id `agent-77`, name `Dreamer`) ->  got DREAMER_AGENT_ALWAYS_LOADED, i.e. a
//                                                        user's own agent was handed the Dreamer's
//                                                        vault loadout by naming itself after it
//
// ── AND A CENSUS, BECAUSE FOUR SITES MEANS THE SHAPE RECURS ──────────────────────────────
// §3 forbids the shape itself across every shipped surface, so the fifth site cannot be written
// quietly. It is the rule's second half enforced by machine rather than by review.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-renamed-agent-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache, getDashboardHiddenAgentIds } from '../../config/platform.js';
import {
  DREAMER_AGENT_ALWAYS_LOADED, SUB_AGENT_ALWAYS_LOADED, getAgentAlwaysLoadedTools,
} from '../tool-docs.js';
const db = (): Database.Database => mockDb.current!;

/** An agent row: the id the platform resolves by, and the name a user may change. */
function seedAgent(id: string, name: string, classification = 'ronin'): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, session_started_at)
     VALUES (?, ?, 'idle', ?, '1970-01-01')`,
  ).run(id, name, classification);
}
/**
 * A config write, INCLUDING the cache invalidation the real write door performs.
 *
 * `config/platform.ts` memoises the whole platform block ("Cached lookups (invalidated on set)"), and
 * the product's own writers call `clearPlatformConfigCache()` — `prompt/agent-rename.ts:165` does it
 * on a rename, `gateway/routes/setup.ts:114` and `migration/import.ts:328` on their writes. A test
 * that pokes the row with raw SQL and skips the invalidation is testing a stale cache, not a rename:
 * the third clause below was RED for exactly that reason before this helper existed, which is worth
 * recording because it looked like a product defect for a minute and was not.
 */
const setConfig = (key: string, value: string): void => {
  db().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
  clearPlatformConfigCache();
};

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  clearPlatformConfigCache();   // a fresh DB is a fresh platform config
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE RENAME. The platform's own agent, under a name the owner chose.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 a renamed service agent keeps the loadout the platform grants it', () => {
  it('RED BEFORE THE FIX: the Dreamer renamed to "Sandman" still gets the Dreamer loadout', () => {
    // The rename a user performs in Settings: the ROW keeps its id, the NAME changes.
    setConfig('dreamer_agent_id', 'dreamer');
    seedAgent('dreamer', 'Sandman');

    const got = getAgentAlwaysLoadedTools('dreamer');
    expect(got.sort(), 'a renamed Dreamer lost its granted tools — the name was the key')
      .toEqual([...DREAMER_AGENT_ALWAYS_LOADED].sort());
    // Named explicitly, because losing these is what the defect actually costs the user.
    for (const tool of DREAMER_AGENT_ALWAYS_LOADED) expect(got).toContain(tool);
  });

  it('the default name still works — a rename is not required to be resolved', () => {
    setConfig('dreamer_agent_id', 'dreamer');
    seedAgent('dreamer', 'Dreamer');
    expect(getAgentAlwaysLoadedTools('dreamer').sort()).toEqual([...DREAMER_AGENT_ALWAYS_LOADED].sort());
  });

  it('a RE-KEYED Dreamer is resolved by its configured id, whatever it is called', () => {
    // The other half of rename-safety: the owner may also move the id.
    setConfig('dreamer_agent_id', 'night-shift');
    seedAgent('night-shift', 'Dozy');
    expect(getAgentAlwaysLoadedTools('night-shift').sort())
      .toEqual([...DREAMER_AGENT_ALWAYS_LOADED].sort());
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE IMPOSTOR. A user's own agent may be called anything, and must gain nothing by it.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 naming your own agent after a service agent grants it nothing', () => {
  it('RED BEFORE THE FIX: a user agent NAMED "Dreamer" does not get the Dreamer loadout', () => {
    setConfig('dreamer_agent_id', 'dreamer');
    seedAgent('dreamer', 'Dreamer');
    seedAgent('agent-77', 'Dreamer');           // the user's own, same name, different id

    const got = getAgentAlwaysLoadedTools('agent-77');
    expect(got.sort(), 'a user agent was handed the Dreamer loadout by naming itself after it')
      .toEqual([...SUB_AGENT_ALWAYS_LOADED].sort());
    // The privilege that must not travel by name: the Dreamer's vault tools.
    const dreamerOnly = DREAMER_AGENT_ALWAYS_LOADED.filter((t) => !SUB_AGENT_ALWAYS_LOADED.includes(t));
    expect(dreamerOnly.length, 'this clause is vacuous unless the loadouts differ').toBeGreaterThan(0);
    for (const tool of dreamerOnly) expect(got).not.toContain(tool);
  });

  it('and the impostor still gets its own classification\'s loadout — nothing is taken away', () => {
    setConfig('dreamer_agent_id', 'dreamer');
    seedAgent('agent-77', 'Dreamer', 'apprentice');
    expect(getAgentAlwaysLoadedTools('agent-77').sort()).toEqual([...SUB_AGENT_ALWAYS_LOADED].sort());
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2c — THE FIFTH SITE, WHICH LIVED INSIDE THE ACCESSOR MODULE (review H2).
//
// `config/platform.ts` is the module every other fix in this file routes THROUGH, and it carried a
// name comparison of its own: `getDashboardHiddenAgentIds()` ran
//
//     SELECT id FROM agents WHERE name IN ('Dreamer', 'Healer')
//
// beside its config-id read, as a "legacy name match" for historical agents. The rename direction was
// safe (the config arm still resolves a renamed service agent), but the IMPOSTOR direction was not: a
// user's own agent merely CALLED `Healer` or `Dreamer` lands in the dashboard-hidden set, and its
// tracker tasks vanish from the owner's view — silently, with no error anywhere.
//
// ⚠ AND §3's BANNER WAS FALSE WHILE THIS SITE SAT IN THE TREE. It said "Four sites existed; this is
// what stops the fifth", and the fifth was already there: the census matched only
// `name === 'Literal'`, so a name inside a SQL string was invisible to it. The widening is in §3, with
// the same fixture-table treatment the reader got — because a census whose headline outruns its
// matcher is worse than no census: it tells the next author the shape is covered.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2c the dashboard-hidden set is resolved by config id, never by display name', () => {
  it('RED BEFORE THE FIX: a user agent NAMED "Healer" is not hidden from the tracker', () => {
    setConfig('healer_agent_id', 'healer');
    setConfig('dreamer_agent_id', 'dreamer');
    setConfig('pm_agent_id', 'pm');
    seedAgent('healer', 'Healer');            // the real one, resolved by id
    seedAgent('agent-88', 'Healer');          // the user's own, same name, different id

    const hidden = getDashboardHiddenAgentIds();
    expect(hidden.has('healer'), 'the configured Healer is still hidden').toBe(true);
    expect(hidden.has('agent-88'),
      'a user agent called "Healer" was hidden from the tracker — its tasks vanish from the owner\'s view')
      .toBe(false);
  });

  it('RED BEFORE THE FIX: the same for a user agent named "Dreamer"', () => {
    setConfig('dreamer_agent_id', 'dreamer');
    seedAgent('dreamer', 'Dreamer');
    seedAgent('agent-99', 'Dreamer');
    const hidden = getDashboardHiddenAgentIds();
    expect(hidden.has('dreamer')).toBe(true);
    expect(hidden.has('agent-99')).toBe(false);
  });

  it('a RENAMED service agent stays hidden — the config arm is what does the work', () => {
    setConfig('healer_agent_id', 'healer');
    seedAgent('healer', 'Doc Holiday');
    expect(getDashboardHiddenAgentIds().has('healer')).toBe(true);
  });

  it('the set still holds all three roles, and still excludes Trainer and Imaginer by charter', () => {
    for (const [k, v] of [['pm_agent_id', 'pm'], ['healer_agent_id', 'healer'], ['dreamer_agent_id', 'dreamer'],
      ['trainer_agent_id', 'trainer'], ['imaginer_agent_id', 'imaginer']]) setConfig(k, v);
    const hidden = getDashboardHiddenAgentIds();
    expect([...hidden].sort()).toEqual(['dreamer', 'healer', 'pm']);
  });
});
