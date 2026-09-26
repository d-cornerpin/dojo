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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-renamed-agent-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import { clearPlatformConfigCache, getDashboardHiddenAgentIds } from '../../config/platform.js';
import {
  DREAMER_AGENT_ALWAYS_LOADED, SUB_AGENT_ALWAYS_LOADED, getAgentAlwaysLoadedTools,
} from '../tool-docs.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
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

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — THE CENSUS: no shipped surface may compare an agent row's NAME to a literal.
//
// Four sites existed; this is what stops the fifth. It reads the shipped surfaces only (tests do not
// ship — `packages/server/tsconfig.json` excludes them — and the audit established that comments DO,
// because `removeComments` is unset), and it names the file and line when it fires.
// ════════════════════════════════════════════════════════════════════════════════════════

const SHIPPED_ROOTS = [
  path.join(SRC),                                                    // packages/server/src
  path.join(SRC, '..', '..', 'shared', 'src'),
  path.join(SRC, '..', '..', 'dashboard', 'src'),
];

function shippedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules' || e.name === 'dist') continue;
        walk(abs);
        continue;
      }
      if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name)) out.push(abs);
    }
  };
  for (const r of SHIPPED_ROOTS) walk(r);
  return out;
}

/**
 * THE SIX ROLE NAMES, READ FROM THE PLATFORM'S OWN DECLARATION — never copied here.
 *
 * The census needs to tell `row.name === 'Dreamer'` (the defect) from `h.name === 'From'` (a Gmail
 * header) and `e.name === 'AbortError'` (a DOM error). The discriminator is not a hand-kept exclusion
 * list: it is whether the right-hand literal is one of the DEFAULT SERVICE-AGENT DISPLAY NAMES the
 * platform ships, and `config/platform.ts` is where those are declared. Parsed out of it at test time
 * so a seventh role is covered the day it is added, and so this file holds no second copy of the
 * product's vocabulary. (The first cut of this census matched any capitalised literal and reported 29
 * offenders — 25 of them Gmail headers and error names. A census that cries wolf gets deleted.)
 */
function roleNamesFromPlatform(): string[] {
  const src = fs.readFileSync(path.join(SRC, 'config', 'platform.ts'), 'utf8');
  const names = [...src.matchAll(/get\('(\w+)_agent_name',\s*'([A-Za-z]+)'\)/g)].map((m) => m[2]);
  return [...new Set(names)];
}

describe('§3 the census: nothing shipped decides behaviour from an agent\'s display name', () => {
  it('the role names are DERIVED from the platform config, not copied into this test', () => {
    const roles = roleNamesFromPlatform();
    // Six today: Agent, PM, Trainer, Imaginer, Healer, Dreamer. Asserted as a shape, not a list, so
    // adding a role does not fail this clause — but losing the derivation does.
    expect(roles.length).toBeGreaterThanOrEqual(5);
    expect(roles).toContain('Dreamer');
    expect(roles).toContain('Healer');
    expect(roles.every((r) => /^[A-Z][A-Za-z]*$/.test(r))).toBe(true);
  });

  /**
   * THE SHAPES A NAME-RELIANT SITE CAN WEAR — widened after review H2 falsified the old banner.
   *
   * The first cut matched `name === 'Role'` and nothing else, so the FIFTH site (`config/platform.ts`'s
   * `SELECT id FROM agents WHERE name IN ('Dreamer', 'Healer')`) was invisible to it while sitting in
   * the tree, and the census reported 0 offenders under a heading that claimed it "stops the fifth".
   * A census whose headline outruns its matcher is worse than none: it tells the next author the shape
   * is already covered.
   *
   * Each entry is a shape with a name, so a failure says WHICH kind of reliance it found.
   */
  function nameReliantShapes(roles) {
    const R = `(?:${roles.join('|')})`;
    return [
      // row.name === 'Healer' · agent.name !== "Dreamer" · name == 'PM'
      { id: 'equality', re: new RegExp(`\\b(?:\\w+\\??\\.)?name\\s*[!=]==?\\s*['"\`]${R}['"\`]`, 'g') },
      // SQL: WHERE name IN ('Dreamer','Healer') · name = 'Healer' · name LIKE 'Dreamer'
      { id: 'name-in-sql', re: new RegExp(`\\bname\\s*(?:=|IN|LIKE)\\s*\\(?\\s*['"]${R}['"]`, 'gi') },
      // ['Dreamer','Healer'].includes(a.name) · NAMES.includes(row.name) with a role literal nearby
      { id: 'includes', re: new RegExp(`\\[[^\\]]*['"]${R}['"][^\\]]*\\]\\s*\\.includes\\s*\\([^)]*\\bname\\b`, 'g') },
      // switch (agent.name) { case 'Healer':
      { id: 'switch-case', re: new RegExp(`case\\s+['"]${R}['"]\\s*:`, 'g') },
    ];
  }

  it('no shipped file decides behaviour from a display name, in ANY of the four shapes', () => {
    const roles = roleNamesFromPlatform();
    const shapes = nameReliantShapes(roles);
    const offenders = [];
    for (const file of shippedFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        // Comments are not logic. They still ship, which is the mechanical scrub's business.
        if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
        for (const shape of shapes) {
          shape.re.lastIndex = 0;
          if (shape.re.test(line)) {
            offenders.push(`${shape.id}  ${path.relative(SRC, file)}:${i + 1}  ${line.trim().slice(0, 110)}`);
          }
        }
      });
    }
    expect(offenders, 'a shipped surface decides behaviour from a display name — use the '
      + 'rename-safe accessor in config/platform.ts (isDreamerAgent / isHealerAgent / '
      + 'getHealerAgentId) or resolve the id from config').toEqual([]);
  });

  it('THE FIXTURE TABLE: every shape caught, and role words in prose ignored', () => {
    const roles = roleNamesFromPlatform();
    const shapes = nameReliantShapes(roles);
    const fires = (line) => shapes.filter((sh) => { sh.re.lastIndex = 0; return sh.re.test(line); }).map((sh) => sh.id);

    const CAUGHT = [
      // the audit's four, verbatim
      ["if (row?.name === 'Dreamer') return DREAMER_AGENT_ALWAYS_LOADED;", 'equality'],
      ["if (!(agent.name === 'Dreamer' || isDreamer(agentId))) {", 'equality'],
      ["if (agent.name === 'Dreamer' || isDreamerAgent(agentId)) {", 'equality'],
      ["const healer = agents.data.find((a: { name: string }) => a.name === 'Healer' && a.status === 'working');", 'equality'],
      // review H2's fifth site, verbatim — invisible to the first cut
      ["      `SELECT id FROM agents WHERE name IN ('Dreamer', 'Healer')`,", 'name-in-sql'],
      // the variants the review named
      ['if (row.name !== "Healer") return;', 'equality'],
      ["if (agent.name == 'PM') hide();", 'equality'],
      ["db.prepare(`SELECT id FROM agents WHERE name = 'Healer'`)", 'name-in-sql'],
      ["db.prepare(\"SELECT id FROM agents WHERE name LIKE 'Dreamer'\")", 'name-in-sql'],
      ["if (['Dreamer', 'Healer'].includes(a.name)) return true;", 'includes'],
      ["switch (agent.name) { case 'Healer':", 'switch-case'],
    ];
    const IGNORED = [
      // role words in PROSE and in product vocabulary — the false-positive half
      "const label = 'Healer diagnostics';",
      "logger.info('the Dreamer finished its batch', { agentId });",
      "return get('healer_agent_name', 'Healer');",                       // the accessor's own default
      "if (isHealerAgent(agentId)) return HEALER_AGENT_ALWAYS_LOADED;",   // the correct form
      "const isPrimary = id === getPrimaryAgentId();",
      "const from = headers.find(h => h.name === 'From')?.value ?? '';",  // a Gmail header
      "if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;",
      "SELECT id FROM agents WHERE classification = 'sensei'",            // by role column, not name
      "if (row.name === agentName) return true;",                         // a variable, not a literal
    ];
    for (const [line, want] of CAUGHT) {
      expect(fires(line), line).toContain(want);
    }
    for (const line of IGNORED) {
      expect(fires(line), line).toEqual([]);
    }
  });

  it('the shipped corpus this census reads is real, and excludes what does not ship', () => {
    const files = shippedFiles().map((f) => path.relative(SRC, f));
    expect(files.length).toBeGreaterThan(400);
    expect(files.some((f) => f === 'tools/tool-docs.ts')).toBe(true);
    expect(files.some((f) => f.includes('dashboard/src/pages/Settings.tsx'))).toBe(true);
    expect(files.some((f) => f.includes('__tests__')), 'tests do not ship').toBe(false);
  });
});
