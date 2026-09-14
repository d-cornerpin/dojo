// ════════════════════════════════════════════════════════════════════════════════
// THE TOOL DOOR (UX-ACCESS A2, owner ruling 4) — RED-first, at the door itself.
//
// A1 built the walls and proved they refuse. It left exactly one thing missing,
// and named it (§6.1): there was NO WAY FOR A MODEL TO GRANT. `spawn_agent` and
// `update_agent` could hand a child a permission MANIFEST and a tool-name policy,
// and nothing else — no category, no integration, no credential, no channel. So
// ruling 2's most-restrictive default could not land in A1: a default that narrows
// with no door to widen through is a platform that cannot delegate.
//
// This file is that door, and the four things the owner's ruling 4 asks of it:
//   1. `spawn_agent` / `update_agent` ACCEPT grants.
//   2. A spawn that names none gets the MOST RESTRICTIVE object (ruling 2).
//   3. NO ESCALATION — an agent may grant only what it holds, and the
//      human-channel master is the primary's alone to set.
//   4. Every model-made grant change writes an AUDIT ROW (actor, target, delta).
//
// RED AT `53955b0b`: `agent/access/authorize.ts` does not exist; `spawn_agent`'s
// and `update_agent`'s schemas declare no `grants` property; `spawnAgent` has no
// `grants` parameter and writes no grants object, so a freshly spawned agent
// answers from `deriveLegacyGrants` — categories `'*'`, credentials `'*'`,
// Plaud on — which is the opposite of ruling 2.
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-a2-door', 'dojo.db'),
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
import { forgetAccessGrants, getAccessGrants, mayUseChannel, readStoredGrants } from '../read.js';
import { writeGrants } from '../materialize.js';
import { deriveLegacyGrants } from '../derive.js';
import {
  validateGrants, grantExcesses, resolveSpawnGrants, resolveUpdateGrants, grantsDelta,
} from '../authorize.js';
import { MOST_RESTRICTIVE_GRANTS, stableGrantsText, cloneGrants } from '@dojo/shared';
import type { AccessGrants } from '@dojo/shared';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const db = (): Database.Database => mockDb.current!;

function agent(id: string, classification: string, mutate?: (g: AccessGrants) => void): AccessGrants {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, session_started_at)
     VALUES (?, ?, 'idle', ?, '1970-01-01')`,
  ).run(id, id, classification);
  forgetAccessGrants();
  const g = deriveLegacyGrants(id);
  if (mutate) mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
  return g;
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  forgetAccessGrants();
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE ARGUMENT EXISTS — the door is DECLARED, not just implemented
// ════════════════════════════════════════════════════════════════════════════════

describe('spawn_agent and update_agent declare a grants argument', () => {
  const defs = (): string => read('agent/tools/definitions.ts');

  const schemaOf = (tool: string): string => {
    const src = defs();
    const at = src.indexOf(`name: '${tool}'`);
    expect(at, `${tool} is defined`).toBeGreaterThan(-1);
    return src.slice(at, src.indexOf('\n  },\n', at));
  };

  it('⚠ `spawn_agent` TAKES GRANTS', () => {
    expect(schemaOf('spawn_agent')).toMatch(/\n\s*grants: \{/);
  });

  it('⚠ `update_agent` TAKES GRANTS', () => {
    expect(schemaOf('update_agent')).toMatch(/\n\s*grants: \{/);
  });

  it('the declaration names the three sections an owner edits', () => {
    for (const tool of ['spawn_agent', 'update_agent']) {
      const block = schemaOf(tool);
      const grantsAt = block.indexOf('grants: {');
      const decl = block.slice(grantsAt, grantsAt + 2000);
      for (const section of ['tools', 'integrations', 'channels']) {
        expect(decl, `${tool}.grants names ${section}`).toContain(section);
      }
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · RULING 2 — THE MOST RESTRICTIVE DEFAULT, AT SPAWN
// ════════════════════════════════════════════════════════════════════════════════

describe('a spawn that names no grants gets the most restrictive object', () => {
  it('⚠ THE DEFAULT IS THE CONSTANT A1 SHIPPED — not the legacy snapshot', () => {
    agent('primary', 'sensei');
    const out = resolveSpawnGrants(undefined, getAccessGrants('primary'), true);
    expect(out.ok).toBe(true);
    expect(out.ok && stableGrantsText(out.grants)).toBe(stableGrantsText(MOST_RESTRICTIVE_GRANTS));
  });

  it('⚠ AND IT IS NOT THE SNAPSHOT: the snapshot grants every category and every credential', () => {
    agent('primary', 'sensei');
    const legacy = deriveLegacyGrants('primary');
    expect(legacy.tools.categories).toBe('*');
    expect(legacy.integrations.credentials).toBe(true);
    // The two must differ, or "most restrictive" is a synonym for "unchanged".
    expect(stableGrantsText(MOST_RESTRICTIVE_GRANTS)).not.toBe(stableGrantsText(legacy));
  });

  it('the default reaches no human, no integration, no credential', () => {
    agent('primary', 'sensei');
    const out = resolveSpawnGrants(undefined, getAccessGrants('primary'), true);
    const g = (out as { ok: true; grants: AccessGrants }).grants;
    expect(g.channels.master).toBe(false);
    expect(g.integrations.credentials).toBe(false);
    expect(g.integrations.plaud).toBe(false);
    expect(g.integrations.google.agent).toBe('none');
  });

  it('⚠ AND THE SUB-AGENT CAN STILL END AND STILL ANSWER ITS CREATOR', () => {
    // MEASURED, and the reason the constant carries a third label: with only
    // `Meta` + `File & System`, `complete_task` and `send_to_agent` are stripped
    // from the advertised surface by the category filter, and the spawn
    // contract's own initial message instructs the agent to call complete_task.
    // A default that makes the sub-agent lifecycle unreachable is not a
    // restriction, it is a broken spawn.
    const cats = MOST_RESTRICTIVE_GRANTS.tools.categories as string[];
    expect(cats).toContain('Managing Other Agents');
  });

  it('the default is clamped to a narrower granter — a child never exceeds its parent', () => {
    agent('narrow', 'ronin', (g) => { g.tools.categories = ['File & System']; });
    const out = resolveSpawnGrants(undefined, getAccessGrants('narrow'), false);
    const g = (out as { ok: true; grants: AccessGrants }).grants;
    expect(g.tools.categories).toEqual(['File & System']);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · NO ESCALATION — an agent grants only what it holds
// ════════════════════════════════════════════════════════════════════════════════

describe('the no-escalation rule', () => {
  it('⚠ A GRANTER CANNOT HAND OUT CREDENTIAL ACCESS IT DOES NOT HOLD', () => {
    // A1 scoped this per service name; the owner's A5 order made the grant one
    // switch, so the rule is Plaud's rule exactly. What it PINS is unchanged: an
    // agent cannot mint a child that reaches the vault it cannot reach itself.
    agent('holder', 'ronin', (g) => { g.integrations.credentials = false; });
    const excesses = grantExcesses(
      { integrations: { credentials: true } },
      getAccessGrants('holder'),
      false,
    );
    expect(excesses.length).toBeGreaterThan(0);
    expect(excesses.join(' ')).toMatch(/credential/i);
    expect(grantExcesses({ integrations: { credentials: false } }, getAccessGrants('holder'), false)).toEqual([]);
  });

  it('⚠ A GRANTER CANNOT HAND OUT A CHANNEL TIER ABOVE ITS OWN', () => {
    agent('owner-only', 'ronin', (g) => { g.channels.master = true; g.channels.imessage = 'owner'; });
    const holder = getAccessGrants('owner-only');
    expect(grantExcesses({ channels: { imessage: 'all' } }, holder, false).length).toBeGreaterThan(0);
    expect(grantExcesses({ channels: { imessage: 'owner' } }, holder, false)).toEqual([]);
  });

  it('⚠ A GRANTER WHOSE MASTER IS OFF HOLDS NO CHANNEL, SO IT CAN GRANT NONE', () => {
    agent('muted', 'ronin', (g) => { g.channels.master = false; g.channels.imessage = 'all'; });
    expect(grantExcesses({ channels: { imessage: 'owner' } }, getAccessGrants('muted'), false).length)
      .toBeGreaterThan(0);
  });

  it('⚠ A NON-PRIMARY MAY NEVER SET THE HUMAN-CHANNEL MASTER', () => {
    agent('operator', 'ronin', (g) => { g.channels.master = true; g.channels.imessage = 'all'; });
    const holder = getAccessGrants('operator');
    const excesses = grantExcesses({ channels: { master: true } }, holder, false);
    expect(excesses.length).toBeGreaterThan(0);
    expect(excesses.join(' ')).toMatch(/primary/i);
  });

  it('⚠ AND THE PRIMARY MAY — that is the owner’s explicit intent', () => {
    agent('primary', 'sensei');
    expect(grantExcesses({ channels: { master: true } }, getAccessGrants('primary'), true)).toEqual([]);
  });

  it('a category the granter does not hold is refused, and one it holds is not', () => {
    agent('narrow', 'ronin', (g) => { g.tools.categories = ['Web', 'File & System']; });
    const holder = getAccessGrants('narrow');
    expect(grantExcesses({ tools: { categories: ['Gmail'] } }, holder, false).length).toBeGreaterThan(0);
    expect(grantExcesses({ tools: { categories: ['Web'] } }, holder, false)).toEqual([]);
    expect(grantExcesses({ tools: { categories: '*' } }, holder, false).length).toBeGreaterThan(0);
  });

  it('a Workspace tier above the granter’s is refused; at or below is not', () => {
    agent('reader', 'ronin', (g) => { g.integrations.google = { agent: 'read', user: 'none' }; });
    const holder = getAccessGrants('reader');
    expect(grantExcesses({ integrations: { google: { agent: 'full' } } }, holder, false).length).toBeGreaterThan(0);
    expect(grantExcesses({ integrations: { google: { user: 'read' } } }, holder, false).length).toBeGreaterThan(0);
    expect(grantExcesses({ integrations: { google: { agent: 'read' } } }, holder, false)).toEqual([]);
  });

  it('Plaud cannot be granted by an agent that does not hold it', () => {
    agent('noplaud', 'ronin', (g) => { g.integrations.plaud = false; });
    expect(grantExcesses({ integrations: { plaud: true } }, getAccessGrants('noplaud'), false).length)
      .toBeGreaterThan(0);
    expect(grantExcesses({ integrations: { plaud: false } }, getAccessGrants('noplaud'), false)).toEqual([]);
  });

  it('⚠ THE FULL HOLDER GRANTS ANYTHING — the rule bounds, it does not forbid', () => {
    agent('primary', 'sensei');
    expect(grantExcesses(
      {
        tools: { categories: '*' },
        integrations: { plaud: true, credentials: true, google: { agent: 'full', user: 'full' } },
        channels: { master: true, imessage: 'all', sms: 'all' },
      },
      getAccessGrants('primary'),
      true,
    )).toEqual([]);
  });

  it('a malformed grants object is REFUSED, never silently downgraded', () => {
    expect(validateGrants({ channels: { imessage: 'sometimes' } }).ok).toBe(false);
    expect(validateGrants({ tools: { categories: 42 } }).ok).toBe(false);
    expect(validateGrants('nope').ok).toBe(false);
    expect(validateGrants({ nonsense: true }).ok).toBe(false);
    expect(validateGrants({ channels: { imessage: 'owner' } }).ok).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · THE RESOLVERS — refuse rather than downgrade; merge rather than replace
// ════════════════════════════════════════════════════════════════════════════════

describe('resolveSpawnGrants / resolveUpdateGrants', () => {
  it('⚠ A SPAWN THAT ESCALATES IS REFUSED WITH A MESSAGE THAT NAMES THE FIELD', () => {
    agent('holder', 'ronin', (g) => { g.integrations.credentials = false; });
    const out = resolveSpawnGrants(
      { integrations: { credentials: true } },
      getAccessGrants('holder'),
      false,
    );
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(/integrations\.credentials/);
    expect(!out.ok && out.reason).toMatch(/cannot grant/i);
  });

  it('a spawn that stays inside its granter is served, merged over the restrictive base', () => {
    agent('primary', 'sensei');
    const out = resolveSpawnGrants(
      { tools: { categories: ['Web'] }, channels: { master: true, imessage: 'owner' } },
      getAccessGrants('primary'),
      true,
    );
    expect(out.ok).toBe(true);
    const g = (out as { ok: true; grants: AccessGrants }).grants;
    expect(g.channels.imessage).toBe('owner');
    expect(g.channels.sms).toBe('none');          // untouched sections keep the floor
    expect(g.integrations.credentials).toBe(false);
    expect(g.tools.categories).toEqual(['Web']);
  });

  it('⚠ UPDATE MERGES OVER THE TARGET’S CURRENT OBJECT — an omitted section is not erased', () => {
    agent('primary', 'sensei');
    const target = agent('worker', 'apprentice', (g) => {
      g.tools.categories = ['Web'];
      g.integrations.credentials = true;
    });
    const out = resolveUpdateGrants(
      { channels: { master: true, imessage: 'owner' } },
      target,
      getAccessGrants('primary'),
      true,
    );
    expect(out.ok).toBe(true);
    const g = (out as { ok: true; grants: AccessGrants }).grants;
    expect(g.tools.categories).toEqual(['Web']);
    expect(g.integrations.credentials).toBe(true);
    expect(g.channels.imessage).toBe('owner');
  });

  it('the excess check reads the PATCH, not the merged result — a pre-existing grant is not the caller’s escalation', () => {
    const target = agent('rich', 'ronin', (g) => { g.integrations.credentials = true; });
    agent('poor', 'ronin', (g) => { g.integrations.credentials = false; g.tools.categories = ['Web']; });
    const out = resolveUpdateGrants({ tools: { categories: ['Web'] } }, target, getAccessGrants('poor'), false);
    expect(out.ok, 'the caller narrowed nothing it does not hold').toBe(true);
    expect((out as { ok: true; grants: AccessGrants }).grants.integrations.credentials).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4b · A REFUSED GRANT IS A REFUSAL, STRUCTURALLY
// ════════════════════════════════════════════════════════════════════════════════
//
// MEASURED ON THE DEV BOX, and it is why this clause exists: the first driven
// escalation attempt came back `kind=failed`, because `classifyToolResult` reads
// the ERROR CODE and an access refusal with none classifies as "the tool
// crashed". `toolWasBlocked` is then false and the loop is told a settled "no" is
// worth retrying. Both grant refusals carry `PERMISSION_DENIED`, and the audit
// row is written at the same site so a refusal can never be silent.

describe('the two grant refusals are classified and audited', () => {
  const src = (): string => read('agent/tools/cat/agents.ts');

  it('⚠ THE SPAWN REFUSAL CARRIES PERMISSION_DENIED AND AN AUDIT ROW', () => {
    const s = src();
    const at = s.indexOf('err instanceof GrantRefusedError');
    expect(at, 'the spawn handler tells a grant refusal apart by TYPE').toBeGreaterThan(-1);
    const body = s.slice(at, at + 700);
    expect(body).toContain("errorCode: 'PERMISSION_DENIED'");
    expect(body).toMatch(/auditLog\(agentId, 'spawn_agent'[^)]*'denied'/);
  });

  it('⚠ THE UPDATE REFUSAL DOES TOO', () => {
    const s = src();
    const at = s.indexOf('const resolution = resolveUpdateGrants(');
    expect(at).toBeGreaterThan(-1);
    const body = s.slice(at, at + 900);
    expect(body).toContain("errorCode: 'PERMISSION_DENIED'");
    expect(body).toMatch(/auditLog\(agentId, 'update_agent', target\.id, 'denied'/);
    expect(body, 'and a change that lands is audited too, with the delta').toMatch(/auditLog\(agentId, 'update_agent', target\.id, 'success'/);
  });

  it('the refusal text names the field, so a model can act on it', () => {
    agent('holder', 'ronin', (g) => { g.integrations.credentials = false; });
    const out = resolveSpawnGrants(
      { channels: { imessage: 'all' }, integrations: { credentials: true } },
      getAccessGrants('holder'),
      false,
    );
    expect(out.ok).toBe(false);
    const reason = !out.ok ? out.reason : '';
    expect(reason).toContain('integrations.credentials');
    expect(reason).toContain('channels.imessage');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 · THE DELTA — what the audit row says
// ════════════════════════════════════════════════════════════════════════════════

describe('grantsDelta names every leaf that moved', () => {
  it('⚠ IT NAMES THE FIELD, THE BEFORE AND THE AFTER', () => {
    const before = cloneGrants(MOST_RESTRICTIVE_GRANTS);
    const after = cloneGrants(MOST_RESTRICTIVE_GRANTS);
    after.channels.master = true;
    after.channels.imessage = 'owner';
    const d = grantsDelta(before, after);
    expect(d).toContain('channels.master');
    expect(d).toContain('channels.imessage');
    expect(d).toContain('owner');
  });

  it('an unchanged object produces an empty delta', () => {
    expect(grantsDelta(MOST_RESTRICTIVE_GRANTS, cloneGrants(MOST_RESTRICTIVE_GRANTS))).toBe('');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 6 · THE WRITE — one door, and the doors see it
// ════════════════════════════════════════════════════════════════════════════════

describe('writeGrants is the one write door', () => {
  it('⚠ A WRITE LANDS BESIDE THE MANIFEST AND THE DOORS READ IT IMMEDIATELY', () => {
    agent('worker', 'apprentice');
    expect(mayUseChannel('worker', 'imessage')).toBe(false);
    const g = cloneGrants(getAccessGrants('worker'));
    g.channels.master = true;
    g.channels.imessage = 'owner';
    writeGrants('worker', g);
    expect(mayUseChannel('worker', 'imessage')).toBe(true);
  });

  it('and the manifest half of the document survives the write', () => {
    db().prepare(
      `INSERT INTO agents (id, name, status, classification, permissions, session_started_at)
       VALUES ('m', 'm', 'idle', 'apprentice', ?, '1970-01-01')`,
    ).run(JSON.stringify({ file_read: '*', exec_allow: ['ls'] }));
    forgetAccessGrants();
    writeGrants('m', MOST_RESTRICTIVE_GRANTS);
    const raw = db().prepare('SELECT permissions FROM agents WHERE id = ?').get('m') as { permissions: string };
    const doc = JSON.parse(raw.permissions) as Record<string, unknown>;
    expect(doc.file_read).toBe('*');
    expect(doc.exec_allow).toEqual(['ls']);
    expect(readStoredGrants('m')).not.toBeNull();
  });

  it('readStoredGrants answers null for an agent that declares none — the derivation is not a declaration', () => {
    db().prepare(
      `INSERT INTO agents (id, name, status, classification, session_started_at)
       VALUES ('bare', 'bare', 'idle', 'apprentice', '1970-01-01')`,
    ).run();
    forgetAccessGrants();
    expect(readStoredGrants('bare')).toBeNull();
    expect(getAccessGrants('bare')).toBeTruthy();
  });
});
