// ════════════════════════════════════════════════════════════════════════════════
// TECHNIQUES BECOME A REAL GRANT SECTION (UX-ACCESS A4, scope item 2) — RED-first.
//
// A1 §6.4, A2 §6.6 and A3 §7.3 each recorded the same thing and each declined
// it. A3's words: *"The techniques section is the existing control, not a grant.
// The plan's A4 owns wiring techniques INTO the object."*
//
// THE CENSUS FINDING THAT SHAPES THIS FILE: `agents.equipped_techniques` is a
// PRE-LOAD list, never an allow-list, and nothing anywhere asked WHICH agent was
// reading a technique. `checkTechniqueAccess` took `(technique, agentGroupId)`
// and answered `published ⇒ everybody`, in the file's own words *"// Everyone
// can use published techniques"*.
//
// FOUR SEAMS, and the file is organised by them, because missing any one leaks
// the technique through a different hole:
//   1. the published INDEX in the system prompt (advertisement)
//   2. the MATCHER, which injects a strong match's whole body UNASKED
//   3. `use_technique` / `technique_read` (the door)
//   4. the EQUIPPED pre-load (four unvalidated write paths feed it)
//
// MIGRATION: the section is OPTIONAL on the wire and an absent one reads `'*'`.
// A1 materialized 111 rows with three sections; a reader that demanded a fourth
// would have thrown every one of them back to the derivation. §5 holds that.
//
// RED AT `ac945a99`: `techniqueGrantOf` / `mayUseTechnique` do not exist,
// `generateTechniqueIndex` takes no argument, and an agent granted nothing still
// reads every published technique.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-a4-techniques', 'dojo.db'),
  };
});

vi.mock('../../../config/platform.js', async () => {
  const actual = await vi.importActual<typeof import('../../../config/platform.js')>('../../../config/platform.js');
  return {
    ...actual,
    isPrimaryAgent: (id: string) => id === 'primary',
    isPMAgent: (id: string) => id === 'pm',
    isHealerAgent: () => false,
    isTrainerAgent: () => false,
    isTrainerEnabled: () => false,
    getPrimaryAgentId: () => 'primary',
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { generateTechniqueIndex } from '../../../techniques/index-builder.js';
import { executeTechniqueRead, executeListTechniques } from '../../../techniques/tools.js';
import { renderEquippedTechniques } from '../../../prompt/assembler.js';
import { forgetAccessGrants, mayUseTechnique, techniqueGrantFor, holdsTechniqueGrant } from '../read.js';
import { deriveLegacyGrants } from '../derive.js';
import { grantExcesses, mergeGrants, clampGrantsTo, grantsDelta, validateGrants } from '../authorize.js';
import { ACCESS_PRESETS } from '../presets.js';
import {
  MOST_RESTRICTIVE_GRANTS, cloneGrants, techniqueGrantOf, techniqueGranted, holdsAnyTechniqueGrant,
} from '@dojo/shared';
import type { AccessGrants } from '@dojo/shared';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const db = (): Database.Database => mockDb.current!;

let tmpRoot = '';

function technique(id: string, name: string, body = `# ${name}\n\nDo the thing.\n`): void {
  const dir = path.join(tmpRoot, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'TECHNIQUE.md'), body, 'utf-8');
  db().prepare(
    `INSERT INTO techniques (id, name, description, state, tags, directory_path, enabled, version, usage_count)
     VALUES (?, ?, ?, 'published', '[]', ?, 1, 1, 0)`,
  ).run(id, name, `${name} does a thing`, dir);
}

function agent(id: string, mutate?: (g: AccessGrants) => void, equipped: string[] = []): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, created_by, spawn_depth, equipped_techniques, session_started_at)
     VALUES (?, ?, 'idle', 'apprentice', ?, 1, ?, '1970-01-01')`,
  ).run(id, id, id === 'primary' ? 'system' : 'primary', JSON.stringify(equipped));
  forgetAccessGrants();
  if (!mutate) return;
  const g = deriveLegacyGrants(id);
  mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

/** Write a grants object with the `techniques` key REMOVED — the exact shape A1
 *  materialized onto 111 live rows. */
function agentWithPreA4Grants(id: string): void {
  agent(id);
  const g = deriveLegacyGrants(id) as Record<string, unknown>;
  delete g.techniques;
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  forgetAccessGrants();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dojo-a4-tech-'));
  technique('alpha', 'Alpha Procedure');
  technique('beta', 'Beta Procedure');
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE MODEL — the fourth section, and the absent-means-`'*'` rule
// ════════════════════════════════════════════════════════════════════════════════

describe('the techniques section of the grants object', () => {
  it('⚠ AN ABSENT SECTION READS `\'*\'` — the pre-A4 fact, not an empty grant', () => {
    const pre = cloneGrants(MOST_RESTRICTIVE_GRANTS) as Record<string, unknown>;
    delete pre.techniques;
    const g = pre as unknown as AccessGrants;
    expect(techniqueGrantOf(g)).toBe('*');
    expect(techniqueGranted(g, 'anything')).toBe(true);
    expect(holdsAnyTechniqueGrant(g)).toBe(true);
  });

  it('ruling 2\'s default grants NONE — a standing procedure is granted explicitly', () => {
    expect(MOST_RESTRICTIVE_GRANTS.techniques).toEqual([]);
    expect(techniqueGranted(MOST_RESTRICTIVE_GRANTS, 'alpha')).toBe(false);
    expect(holdsAnyTechniqueGrant(MOST_RESTRICTIVE_GRANTS)).toBe(false);
  });

  it('the A1 SNAPSHOT answers `\'*\'`, because that is what HEAD measured', () => {
    // `checkTechniqueAccess` took no agent id, the index took none, and the
    // matcher offered every published technique to every non-PM agent. The
    // honest snapshot of "which techniques does this agent hold" is therefore
    // "all of them", which is what makes A4 invisible to the 111 live rows.
    agent('anyone');
    expect(techniqueGrantFor('anyone')).toBe('*');
    expect(mayUseTechnique('anyone', 'alpha')).toBe(true);
    expect(holdsTechniqueGrant('anyone')).toBe(true);
  });

  it('a row stored BEFORE A4 (no key at all) still holds everything', () => {
    agentWithPreA4Grants('legacy');
    expect(techniqueGrantFor('legacy')).toBe('*');
    expect(mayUseTechnique('legacy', 'beta')).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · SEAM 1 — THE ADVERTISED INDEX
// ════════════════════════════════════════════════════════════════════════════════

describe('seam 1 — the published index', () => {
  it('⚠ THE INDEX IS FILTERED TO THE GRANT', () => {
    agent('narrow', (g) => { g.techniques = ['alpha']; });
    const index = generateTechniqueIndex('narrow');
    expect(index).toContain('Alpha Procedure');
    expect(index).not.toContain('Beta Procedure');
  });

  it('an agent granted NOTHING gets no index at all, not an empty header', () => {
    agent('none', (g) => { g.techniques = []; });
    expect(generateTechniqueIndex('none')).toBe('');
  });

  it('`\'*\'` sees both — the pre-A4 answer, byte for byte with the no-argument call', () => {
    agent('wide', (g) => { g.techniques = '*'; });
    expect(generateTechniqueIndex('wide')).toBe(generateTechniqueIndex());
  });

  it('the no-argument call is still the FULL list — a caller with no agent is not narrowed', () => {
    const index = generateTechniqueIndex();
    expect(index).toContain('Alpha Procedure');
    expect(index).toContain('Beta Procedure');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · SEAM 3 + the browse verb — THE DOOR
// ════════════════════════════════════════════════════════════════════════════════

describe('seam 3 — the use_technique door', () => {
  it('⚠ AN UNGRANTED TECHNIQUE IS REFUSED, AND THE SENTENCE SAYS WHY', () => {
    agent('narrow', (g) => { g.techniques = ['alpha']; });
    const out = executeTechniqueRead('narrow', 'Narrow', null, { name: 'beta', action: 'read_file' });
    expect(out).toContain('not in this agent\'s technique grants');
    expect(out).toContain('The request was not performed');
    // It does NOT leak the body.
    expect(out).not.toContain('Do the thing');
  });

  it('POSITIVE CONTROL: the granted one opens', () => {
    agent('narrow', (g) => { g.techniques = ['alpha']; });
    const out = executeTechniqueRead('narrow', 'Narrow', null, { name: 'alpha', action: 'outline' });
    expect(out).not.toContain('not in this agent\'s technique grants');
    expect(out).toContain('Alpha Procedure');
  });

  it('the GRANT is asked before the STATE rule, so the message is about the grant', () => {
    // A technique that is both ungranted AND unpublished must read as ungranted:
    // telling the agent "it is a draft" when the real answer is "you may not run
    // it" sends it to the Trainer to publish something it still could not use.
    db().prepare("UPDATE techniques SET state = 'draft' WHERE id = 'beta'").run();
    agent('narrow', (g) => { g.techniques = ['alpha']; });
    const out = executeTechniqueRead('narrow', 'Narrow', null, { name: 'beta', action: 'outline' });
    expect(out).toContain('not in this agent\'s technique grants');
    expect(out).not.toContain('state: draft');
  });

  it('the STATE rule is UNCHANGED for a granted technique — A4 added a door, it did not move one', () => {
    // A draft belonging to SOMEBODY ELSE'S build squad: the second clause of
    // `checkTechniqueAccess` is `buildSquadId === agentGroupId`, so a null-vs-null
    // fixture would pass the squad rule and prove nothing.
    db().prepare("INSERT INTO agent_groups (id, name, description, created_by) VALUES ('squad-x', 'Squad X', '', 'primary')").run();
    db().prepare("UPDATE techniques SET state = 'draft', build_squad_id = 'squad-x' WHERE id = 'beta'").run();
    agent('wide', (g) => { g.techniques = '*'; });
    const out = executeTechniqueRead('wide', 'Wide', null, { name: 'beta', action: 'outline' });
    expect(out).toContain('is not available (state: draft)');
  });

  it('`list_techniques` offers only what `use_technique` would open', () => {
    agent('narrow', (g) => { g.techniques = ['alpha']; });
    const out = executeListTechniques('narrow', 'apprentice', {});
    expect(out).toContain('Alpha Procedure');
    expect(out).not.toContain('Beta Procedure');
  });

  it('and an agent granted nothing is told so rather than shown a list', () => {
    agent('none', (g) => { g.techniques = []; });
    expect(executeListTechniques('none', 'apprentice', {})).toContain('No techniques available');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · SEAM 4 — THE EQUIPPED PRE-LOAD
// ════════════════════════════════════════════════════════════════════════════════

describe('seam 4 — the equipped pre-load', () => {
  it('⚠ AN EQUIPPED-BUT-UNGRANTED TECHNIQUE LOADS NOTHING', () => {
    // The census found FOUR unvalidated write paths into `equipped_techniques`
    // (the dashboard POST and PUT, the spawner, and `spawn_agent(techniques:)`),
    // so without this seam every other rule is one write away from bypass.
    agent('narrow', (g) => { g.techniques = ['alpha']; }, ['alpha', 'beta']);
    const rendered = renderEquippedTechniques('narrow');
    expect(rendered).toContain('Alpha Procedure');
    expect(rendered).not.toContain('Beta Procedure');
  });

  it('equipping ONLY ungranted ids renders the section not at all', () => {
    agent('narrow', (g) => { g.techniques = ['alpha']; }, ['beta']);
    expect(renderEquippedTechniques('narrow')).toBeNull();
  });

  it('POSITIVE CONTROL: `\'*\'` loads every equipped body, as it always did', () => {
    agent('wide', (g) => { g.techniques = '*'; }, ['alpha', 'beta']);
    const rendered = renderEquippedTechniques('wide');
    expect(rendered).toContain('Alpha Procedure');
    expect(rendered).toContain('Beta Procedure');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 · THE GRANT DOOR — schema, no escalation, merge, clamp, delta
// ════════════════════════════════════════════════════════════════════════════════

describe('the techniques section rides the A2 grant door', () => {
  const holder = (t: string[] | '*'): AccessGrants => {
    const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
    g.techniques = t;
    return g;
  };

  it('the schema accepts a list and `\'*\'`, and refuses anything else', () => {
    expect(validateGrants({ techniques: ['alpha'] }).ok).toBe(true);
    expect(validateGrants({ techniques: '*' }).ok).toBe(true);
    const bad = validateGrants({ techniques: 'alpha' });
    expect(bad.ok).toBe(false);
  });

  it('⚠ NO ESCALATION: a caller cannot grant a technique it does not hold', () => {
    const excesses = grantExcesses({ techniques: ['alpha', 'beta'] }, holder(['alpha']), true);
    expect(excesses.join(' ')).toContain('techniques: cannot grant "beta"');
    expect(excesses.join(' ')).toContain('not in your technique grant');
  });

  it('nor `\'*\'` from a bounded holder', () => {
    const excesses = grantExcesses({ techniques: '*' }, holder(['alpha']), true);
    expect(excesses.join(' ')).toContain('cannot grant every technique');
  });

  it('POSITIVE CONTROL: passing on what it DOES hold is allowed', () => {
    expect(grantExcesses({ techniques: ['alpha'] }, holder(['alpha']), true)).toEqual([]);
    expect(grantExcesses({ techniques: '*' }, holder('*'), true)).toEqual([]);
  });

  it('a `\'*\'` holder can grant anything, including a name it has never seen', () => {
    expect(grantExcesses({ techniques: ['not-published-yet'] }, holder('*'), true)).toEqual([]);
  });

  it('merge applies the section and leaves the other three alone', () => {
    const before = cloneGrants(MOST_RESTRICTIVE_GRANTS);
    const after = mergeGrants(before, { techniques: ['alpha'] });
    expect(after.techniques).toEqual(['alpha']);
    expect(after.channels).toEqual(before.channels);
    expect(after.tools).toEqual(before.tools);
  });

  it('an omitted section leaves the target\'s grant exactly as it was', () => {
    const before = holder(['alpha', 'beta']);
    expect(mergeGrants(before, { channels: { imessage: 'owner' } }).techniques).toEqual(['alpha', 'beta']);
  });

  it('the CLAMP narrows a default to the granter — a child cannot stand on a floor its parent lacks', () => {
    expect(clampGrantsTo(holder('*'), holder(['alpha'])).techniques).toEqual(['alpha']);
    expect(clampGrantsTo(holder(['alpha', 'beta']), holder(['beta'])).techniques).toEqual(['beta']);
    expect(clampGrantsTo(holder(['alpha']), holder('*')).techniques).toEqual(['alpha']);
  });

  it('the AUDIT DELTA names the section, and a no-op over a pre-A4 row is silent', () => {
    expect(grantsDelta(holder([]), holder(['alpha']))).toContain('techniques: [] → ["alpha"]');
    const pre = cloneGrants(MOST_RESTRICTIVE_GRANTS) as Record<string, unknown>;
    delete pre.techniques;
    // Absence vs the `'*'` it MEANS is not a change, so opening the panel on a
    // pre-A4 row and saving writes no audit row for this section.
    expect(grantsDelta(pre as unknown as AccessGrants, holder('*'))).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 6 · THE PRESETS
// ════════════════════════════════════════════════════════════════════════════════

describe('the presets state a technique grant deliberately', () => {
  it('every preset names the section — none leaves it to the absent-means-all rule', () => {
    for (const p of ACCESS_PRESETS) {
      expect(p.grants.techniques, `${p.id} states its technique grant`).toBeDefined();
    }
  });

  it('only full-trust grants `\'*\'`; the three narrower profiles grant none', () => {
    const byId = Object.fromEntries(ACCESS_PRESETS.map((p) => [p.id, p.grants.techniques]));
    expect(byId.full_trust).toBe('*');
    expect(byId.most_restrictive).toEqual([]);
    expect(byId.reader).toEqual([]);
    expect(byId.operator).toEqual([]);
  });
});
