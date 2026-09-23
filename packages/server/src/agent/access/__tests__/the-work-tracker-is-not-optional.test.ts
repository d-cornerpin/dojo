// ════════════════════════════════════════════════════════════════════════════════
// THE WORK TRACKER IS NOT OPTIONAL (owner ruling, 2026-09-22)
//
// OWNER, VERBATIM: *"By default, all agents should have this ability. It defeats
// the entire purpose of the dojo and you have gates that prevent the agents from
// working if they don't open a task."*
//
// THE LIVE DEFECT. A primary-adjacent agent on the owner's box called `work_open`
// and was refused — *"work_open is in the 'Open Work…' or 'Work Tracker…' tool
// group, which is not in this agent's grants"* — IN THE SAME TURN that the
// engine's own start-ack hint told it *"their request is being worked as a tracked
// job."* UX-ACCESS ruling 2's most-restrictive default (`.23`) was three labels:
// `Meta`, `File & System`, `Managing Other Agents`. The tracker was never in it,
// because the floor was derived from "what does a sub-agent need to EXIST" —
// lifecycle, files, the two-phase tool loader — and the tracker did not read as
// lifecycle. The engine's governance disagrees: the going-idle re-prompt, the
// close-out gate, the promise floor, the engine's own auto-open and the thrash
// ladder's escape hatches all name a work verb as the way OUT.
//
// THE FOUR THINGS THIS FILE HOLDS:
//   1a  a FRESH agent can call `work_open` with zero grant edits
//   1b  migration 168 backfills EXISTING agents — granted, ungranted, revoked —
//       and a second run changes nothing
//   1c  a deliberate revocation STICKS across a restart (a default is not a floor)
//   1d  a sub-agent spawn inherits the groups, and nothing re-strips them
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-work-grant', 'dojo.db'),
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
    getPrimaryAgentId: () => 'primary',
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { gatesForCall } from '../../tools/gates.js';
import { evaluateGate } from '../../tools/gate-eval.js';
import { forgetAccessGrants, getAccessGrants, readStoredGrants, toolCategoryGranted } from '../read.js';
import { deriveLegacyGrants } from '../derive.js';
import { writeGrants, materializeAccessGrants } from '../materialize.js';
import { resolveSpawnGrants } from '../authorize.js';
import { TOOL_CATEGORIES } from '../../../tools/categories.js';
import { MOST_RESTRICTIVE_GRANTS, categoryGranted } from '@dojo/shared';
import type { AccessGrants } from '@dojo/shared';

const OPEN_WORK = 'Open Work (what you still owe)';
const WORK_TRACKER = 'Work Tracker (projects, tasks, reminders, promises)';
/** Every verb the two groups carry, from the index itself rather than by hand. */
const WORK_TOOLS = TOOL_CATEGORIES
  .filter((c) => c.label === OPEN_WORK || c.label === WORK_TRACKER)
  .flatMap((c) => c.tools);

const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations',
);
const MIGRATION_168_FILE = '168_work_tracker_default_grant.sql';
const MIGRATION_168 = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_168_FILE), 'utf-8');

const db = (): Database.Database => mockDb.current!;

/** Apply exactly the way `db/migrations.ts` applies: one exec, one transaction,
 *  foreign keys off. */
function apply168(): void {
  db().pragma('foreign_keys = OFF');
  db().transaction(() => db().exec(MIGRATION_168))();
  db().pragma('foreign_keys = ON');
  forgetAccessGrants();
}

/** Rewind the chain so a body can be brought back to its pre-168 shape. */
function rewindTo167(): void {
  db().prepare('DELETE FROM _migrations WHERE name = ?').run(MIGRATION_168_FILE);
}

function insertAgent(id: string, classification = 'ronin'): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, session_started_at)
     VALUES (?, ?, 'idle', ?, '1970-01-01')`,
  ).run(id, id, classification);
  forgetAccessGrants();
}

/** An agent row carrying a STORED grants object, built from the derivation then
 *  mutated — the same shape `writeGrants` produces. */
function agentWithGrants(id: string, mutate: (g: AccessGrants) => void, classification = 'ronin'): void {
  insertAgent(id, classification);
  const g = deriveLegacyGrants(id);
  mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?')
    .run(JSON.stringify({ file_read: ['*'], grants: g }), id);
  forgetAccessGrants();
}

const categoriesOf = (id: string): string[] | '*' => getAccessGrants(id).tools.categories;

const ctx = (agentId: string, name: string, args: Record<string, unknown> = {}) => ({
  agentId, name, args, resolveRef: () => null,
});
const row17 = (name: string) => gatesForCall(name, {}).find((g) => g.row === '17');

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  forgetAccessGrants();
});

// ════════════════════════════════════════════════════════════════════════════════
// 0 · THE LABELS ARE REAL — two strings in `@dojo/shared` naming server groups
// ════════════════════════════════════════════════════════════════════════════════

describe('the floor names labels that exist', () => {
  it('⚠ EVERY LABEL IN THE MOST-RESTRICTIVE DEFAULT IS A REAL TOOL-CATEGORY LABEL', () => {
    // `MOST_RESTRICTIVE_GRANTS` lives in `@dojo/shared` and `TOOL_CATEGORIES`
    // lives in the server, so the five strings are literals that a re-label could
    // silently turn into dead grants. This is the only thing standing between a
    // renamed category and a floor that grants nothing.
    const real = new Set(TOOL_CATEGORIES.map((c) => c.label));
    const floor = MOST_RESTRICTIVE_GRANTS.tools.categories as string[];
    const phantom = floor.filter((l) => !real.has(l));
    expect(phantom, `floor names label(s) no category has: ${phantom.join(' · ')}`).toEqual([]);
  });

  it('⚠ AND THE TWO THE MIGRATION APPENDS ARE THE SAME TWO', () => {
    // If these drift apart, a backfilled agent and a newly created one end up
    // with different access and nothing else notices.
    for (const label of [OPEN_WORK, WORK_TRACKER]) {
      expect(MIGRATION_168, `168 appends "${label}"`).toContain(label);
      expect(MOST_RESTRICTIVE_GRANTS.tools.categories, `the floor holds "${label}"`).toContain(label);
      expect(TOOL_CATEGORIES.some((c) => c.label === label), `"${label}" is a real group`).toBe(true);
    }
  });

  it('the work verbs the engine demands all live in those two groups', () => {
    // The engine's floors name these by operation; if one moved to a group the
    // default does not hold, the same refusal comes back for that verb alone.
    for (const verb of ['work_open', 'work_update', 'work_note', 'work_close_request', 'work_validate', 'work_schedule']) {
      expect(WORK_TOOLS, `${verb} is inside the default-granted groups`).toContain(verb);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 1a · A FRESH AGENT CAN OPEN WORK — zero grant edits
// ════════════════════════════════════════════════════════════════════════════════

describe('1a — a newly created agent can call work_open', () => {
  beforeEach(() => {
    insertAgent('primary', 'sensei');
    // A spawn that names NO grants: the most-restrictive default, verbatim, with
    // no owner edit anywhere in the story.
    insertAgent('fresh');
    const out = resolveSpawnGrants(undefined, getAccessGrants('primary'), true);
    expect(out.ok).toBe(true);
    writeGrants('fresh', (out as { ok: true; grants: AccessGrants }).grants);
    forgetAccessGrants();
  });

  it('⚠ work_open IS ALLOWED AT THE EXECUTOR, WITH NO GRANT EDITS AT ALL', async () => {
    // This is the owner's live refusal, at the door that produced it (row 17,
    // `gate-eval.ts`). RED with the pre-ruling three-label default.
    const out = await evaluateGate(row17('work_open')!, ctx('fresh', 'work_open'));
    expect(out.verdict.allowed, 'a fresh agent still cannot open work').toBe(true);
  });

  it('⚠ AND SO IS EVERY OTHER WORK VERB THE ENGINE\'S FLOORS DEMAND', async () => {
    for (const name of WORK_TOOLS) {
      const gate = row17(name);
      expect(gate, `${name} carries a category gate`).toBeDefined();
      const out = await evaluateGate(gate!, ctx('fresh', name));
      expect(out.verdict.allowed, `${name} is refused on a default-spawned agent`).toBe(true);
    }
  });

  it('THE CONTROL: the default did not quietly become "everything"', async () => {
    // The ruling widened the floor by exactly two groups. If a later change turns
    // the floor into '*' this passes 1a and destroys ruling 2, so the narrowness
    // is asserted beside the widening.
    for (const name of ['web_search', 'vault_remember', 'gmail_inbox', 'imessage_send']) {
      const out = await evaluateGate(row17(name)!, ctx('fresh', name));
      expect(out.verdict.allowed, `${name} is outside the floor and must stay refused`).toBe(false);
    }
    expect(categoriesOf('fresh')).toHaveLength(5);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 1b · MIGRATION 168 — the lived-in body
// ════════════════════════════════════════════════════════════════════════════════

describe('1b — migration 168 on a seeded, lived-in database', () => {
  beforeEach(() => {
    rewindTo167();

    // UNGRANTED: the pre-ruling three-label floor, i.e. every agent the owner's
    // box spawned since `.23`. This is the row the owner hit.
    agentWithGrants('ungranted', (g) => {
      g.tools.categories = ['Meta', 'File & System', 'Managing Other Agents'];
    });
    // GRANTED-ALREADY: an agent an owner had already ticked the tracker for.
    agentWithGrants('granted', (g) => {
      g.tools.categories = ['Meta', 'File & System', OPEN_WORK, WORK_TRACKER, 'Gmail'];
    });
    // HALF-GRANTED: one of the two. A per-label backfill, not an all-or-nothing one.
    agentWithGrants('half', (g) => {
      g.tools.categories = ['Meta', WORK_TRACKER];
    });
    // WIDE: `categories: '*'`. Already holds everything; must not become a list.
    agentWithGrants('wide', (g) => { g.tools.categories = '*'; });
    // UNDECLARED: no grants key at all — answered by the derivation ('*').
    insertAgent('undeclared');
    // ADVERSARIAL, the `.23` / `135` incident class: the shapes a lived-in
    // `permissions` column actually carries. A raise here aborts the chain, which
    // aborts the boot.
    insertAgent('null-perms');
    db().prepare('UPDATE agents SET permissions = NULL WHERE id = ?').run('null-perms');
    insertAgent('empty-perms');
    db().prepare("UPDATE agents SET permissions = '' WHERE id = ?").run('empty-perms');
    insertAgent('brace-perms');
    db().prepare("UPDATE agents SET permissions = '{}' WHERE id = ?").run('brace-perms');
    insertAgent('garbage-perms');
    db().prepare("UPDATE agents SET permissions = 'not json at all {{{' WHERE id = ?").run('garbage-perms');
    insertAgent('manifest-only');
    db().prepare(`UPDATE agents SET permissions = '{"file_read":["*"],"exec_allow":["ls"]}' WHERE id = ?`)
      .run('manifest-only');
    insertAgent('grants-not-object');
    db().prepare(`UPDATE agents SET permissions = '{"grants":"nope"}' WHERE id = ?`).run('grants-not-object');
    insertAgent('categories-scalar');
    db().prepare(`UPDATE agents SET permissions = '{"grants":{"v":1,"tools":{"categories":"*","allow":[],"deny":[]}}}' WHERE id = ?`)
      .run('categories-scalar');
    forgetAccessGrants();
  });

  it('⚠ THE MIGRATION DOES NOT RAISE ON ANY SHAPE A LIVED-IN COLUMN CARRIES', () => {
    // The whole point of the CASE guard. A raise inside a migration aborts the
    // chain, which aborts the boot.
    expect(() => apply168()).not.toThrow();
  });

  it('⚠ THE UNGRANTED AGENT GAINS BOTH GROUPS', () => {
    apply168();
    const cats = categoriesOf('ungranted') as string[];
    expect(cats).toContain(OPEN_WORK);
    expect(cats).toContain(WORK_TRACKER);
    // …and nothing it already held was disturbed, in order.
    expect(cats.slice(0, 3)).toEqual(['Meta', 'File & System', 'Managing Other Agents']);
  });

  it('⚠ AND IT CAN NOW ACTUALLY OPEN WORK', async () => {
    apply168();
    const out = await evaluateGate(row17('work_open')!, ctx('ungranted', 'work_open'));
    expect(out.verdict.allowed).toBe(true);
  });

  it('⚠ THE ALREADY-GRANTED AGENT IS BYTE-UNCHANGED', () => {
    const before = db().prepare('SELECT permissions FROM agents WHERE id = ?').get('granted') as { permissions: string };
    apply168();
    const after = db().prepare('SELECT permissions FROM agents WHERE id = ?').get('granted') as { permissions: string };
    expect(after.permissions).toBe(before.permissions);
  });

  it('the half-granted agent gains only the one it lacked (no duplicate)', () => {
    apply168();
    const cats = categoriesOf('half') as string[];
    expect(cats.filter((c) => c === WORK_TRACKER)).toHaveLength(1);
    expect(cats.filter((c) => c === OPEN_WORK)).toHaveLength(1);
  });

  it('the `*` agent stays `*` — it already holds every category', () => {
    apply168();
    expect(categoriesOf('wide')).toBe('*');
  });

  it('⚠ THE MANIFEST BESIDE THE GRANTS SURVIVES THE SURGERY', () => {
    apply168();
    const raw = db().prepare('SELECT permissions FROM agents WHERE id = ?').get('ungranted') as { permissions: string };
    const doc = JSON.parse(raw.permissions) as Record<string, unknown>;
    expect(doc.file_read, 'the PermissionManifest half of the document was rewritten').toEqual(['*']);
  });

  it('every untouchable shape is left EXACTLY as it was', () => {
    const snap = (id: string) =>
      (db().prepare('SELECT permissions FROM agents WHERE id = ?').get(id) as { permissions: string | null }).permissions;
    const ids = ['undeclared', 'null-perms', 'empty-perms', 'brace-perms', 'garbage-perms',
      'manifest-only', 'grants-not-object', 'categories-scalar', 'wide'];
    const before = Object.fromEntries(ids.map((id) => [id, snap(id)]));
    apply168();
    for (const id of ids) expect(snap(id), `${id} was modified`).toBe(before[id]);
  });

  it('the undeclared rows still end up with the tracker — the derivation already grants it', () => {
    // Stated because "untouched" could read as "left out". A row with no stored
    // grants answers from `derive.ts`, whose snapshot is `categories: '*'`.
    apply168();
    for (const id of ['undeclared', 'null-perms', 'brace-perms', 'manifest-only']) {
      expect(toolCategoryGranted(id, 'work_open'), `${id} cannot open work`).toBe(true);
    }
  });

  it('⚠ RE-RUNNING IT IS A NO-OP — idempotent by its WHERE clause, not by the marker', () => {
    apply168();
    const ids = ['ungranted', 'granted', 'half', 'wide', 'undeclared', 'garbage-perms'];
    const snap = () => Object.fromEntries(ids.map((id) =>
      [id, (db().prepare('SELECT permissions FROM agents WHERE id = ?').get(id) as { permissions: string | null }).permissions]));
    const afterFirst = snap();
    apply168();
    apply168();
    expect(snap()).toEqual(afterFirst);
  });

  it('`updated_at` is not bumped — a backfill is not an owner edit', () => {
    const at = () => (db().prepare('SELECT updated_at FROM agents WHERE id = ?').get('ungranted') as { updated_at: string }).updated_at;
    const before = at();
    apply168();
    expect(at()).toBe(before);
  });

  it('⚠ THE COUNTERFACTUAL: without the CASE guard the chain RAISES on the garbage row', () => {
    // The guard is load-bearing, proven by removing it. `json_type(permissions,
    // …)` on `'not json at all {{{'` is the raise that aborts a boot.
    const unguarded = MIGRATION_168.replace(
      /CASE WHEN json_valid\((?:agents\.)?permissions\) THEN (?:agents\.)?permissions ELSE '\{\}' END/g,
      'permissions',
    );
    expect(unguarded).not.toBe(MIGRATION_168);
    expect(() => db().transaction(() => db().exec(unguarded))()).toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 1c · A DEFAULT IS NOT A FLOOR — a deliberate revocation STICKS
// ════════════════════════════════════════════════════════════════════════════════

describe('1c — the owner may still revoke, and the revocation survives a restart', () => {
  /** Everything the boot does to grants, in boot order: the chain, then the
   *  materializer. If anything ever re-imposes the default here, this is where it
   *  would show. */
  const reboot = (): void => {
    runMigrations();
    materializeAccessGrants();
    forgetAccessGrants();
  };

  beforeEach(() => {
    // Seed a pre-168 agent, then let the REAL RUNNER apply the migration — not
    // `apply168()`. The difference is the point of this whole section: the runner
    // records `168_…` in `_migrations` inside the same transaction, and THAT
    // marker is what makes the backfill a one-time event rather than a floor. A
    // harness that applied the SQL without the marker would re-apply the backfill
    // on every simulated boot and undo the owner's revocation — which is exactly
    // the failure mode this test exists to catch, so it must not be the harness
    // that produces it.
    rewindTo167();
    agentWithGrants('narrowed', (g) => {
      g.tools.categories = ['Meta', 'File & System', 'Managing Other Agents'];
    });
    runMigrations();
    forgetAccessGrants();
    expect(categoriesOf('narrowed')).toContain(OPEN_WORK);
  });

  it('⚠ A DELIBERATE REVOCATION AFTER THE BACKFILL STICKS ACROSS RESTARTS', async () => {
    // The owner unticks both groups in the Access panel. `PUT /api/agents/:id`
    // lands on `writeGrants`, which is what this stands in for.
    const g = getAccessGrants('narrowed');
    g.tools.categories = (g.tools.categories as string[])
      .filter((c) => c !== OPEN_WORK && c !== WORK_TRACKER);
    writeGrants('narrowed', g);
    forgetAccessGrants();

    reboot();
    reboot();
    reboot();

    const cats = categoriesOf('narrowed') as string[];
    expect(cats, 'a boot-time floor put the work groups back').not.toContain(OPEN_WORK);
    expect(cats, 'a boot-time floor put the work groups back').not.toContain(WORK_TRACKER);

    const out = await evaluateGate(row17('work_open')!, ctx('narrowed', 'work_open'));
    expect(out.verdict.allowed, 'the revoked agent can still open work').toBe(false);
  });

  it('⚠ NOTHING AT BOOT REWRITES AN AGENT THAT ALREADY DECLARES GRANTS', () => {
    // The general form of the rule the test above checks for one field: the
    // materializer writes only where nothing is declared. A boot rewriter that
    // "helpfully" re-applied the default would revert every owner edit, which is
    // the defect the four retired boot reconcilers were deleted for.
    const raw = () => (db().prepare('SELECT permissions FROM agents WHERE id = ?').get('narrowed') as { permissions: string }).permissions;
    const before = raw();
    expect(materializeAccessGrants()).toBe(0);
    reboot();
    expect(raw()).toBe(before);
  });

  it('…and an UNDECLARED row is still materialized on that same boot (the door is not welded)', () => {
    insertAgent('brand-new');
    expect(readStoredGrants('brand-new')).toBeNull();
    reboot();
    expect(readStoredGrants('brand-new')).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 1d · SUB-AGENTS INHERIT, AND NOTHING IN THE SPAWN PATH RE-STRIPS
// ════════════════════════════════════════════════════════════════════════════════

describe('1d — the spawn path carries the work groups down', () => {
  it('⚠ A SUB-AGENT OF THE PRIMARY GETS BOTH GROUPS', () => {
    insertAgent('primary', 'sensei');
    const out = resolveSpawnGrants(undefined, getAccessGrants('primary'), true);
    expect(out.ok).toBe(true);
    const g = (out as { ok: true; grants: AccessGrants }).grants;
    expect(categoryGranted(g, OPEN_WORK)).toBe(true);
    expect(categoryGranted(g, WORK_TRACKER)).toBe(true);
  });

  it('⚠ A GRAND-CHILD DOES TOO — the clamp does not erode the floor generation by generation', () => {
    // `resolveSpawnGrants` clamps the default to the GRANTER. A parent that holds
    // the groups hands them on; a chain of spawns must not whittle them away.
    insertAgent('primary', 'sensei');
    let holder = getAccessGrants('primary');
    for (let gen = 0; gen < 4; gen++) {
      const out = resolveSpawnGrants(undefined, holder, gen === 0);
      expect(out.ok, `generation ${gen} refused`).toBe(true);
      holder = (out as { ok: true; grants: AccessGrants }).grants;
      expect(categoryGranted(holder, OPEN_WORK), `generation ${gen} lost Open Work`).toBe(true);
      expect(categoryGranted(holder, WORK_TRACKER), `generation ${gen} lost the Work Tracker`).toBe(true);
    }
  });

  it('a spawn that names OTHER grants still keeps the work groups it did not mention', () => {
    // The merge is over the floor, so an unmentioned field falls back to the
    // floor rather than to nothing. A parent asking for Gmail must not
    // accidentally un-grant the tracker.
    insertAgent('primary', 'sensei');
    const out = resolveSpawnGrants(
      { integrations: { plaud: true } },
      getAccessGrants('primary'),
      true,
    );
    const g = (out as { ok: true; grants: AccessGrants }).grants;
    expect(categoryGranted(g, OPEN_WORK)).toBe(true);
    expect(categoryGranted(g, WORK_TRACKER)).toBe(true);
  });

  it('⚠ NO ESCALATION IS UNTOUCHED: a REVOKED parent still cannot hand the groups on', () => {
    // The deliberate revocation in 1c has to mean something for the children too,
    // or "revocation sticks" is only true one level deep. This is the
    // no-escalation rule doing exactly its job, and it is the reason the default
    // is a creation-time value rather than a floor asserted at every door.
    insertAgent('primary', 'sensei');
    agentWithGrants('revoked-parent', (g) => {
      g.tools.categories = ['Meta', 'File & System', 'Managing Other Agents'];
    });
    const out = resolveSpawnGrants(undefined, getAccessGrants('revoked-parent'), false);
    const g = (out as { ok: true; grants: AccessGrants }).grants;
    expect(categoryGranted(g, OPEN_WORK)).toBe(false);
    expect(categoryGranted(g, WORK_TRACKER)).toBe(false);
  });

  it('a spawn cannot be refused merely for wanting the tracker it already holds', () => {
    insertAgent('primary', 'sensei');
    const out = resolveSpawnGrants(
      { tools: { categories: ['Meta', OPEN_WORK, WORK_TRACKER] } },
      getAccessGrants('primary'),
      true,
    );
    expect(out.ok).toBe(true);
  });
});
