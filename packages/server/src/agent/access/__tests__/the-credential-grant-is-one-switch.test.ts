// ════════════════════════════════════════════════════════════════════════════════
// THE CREDENTIAL GRANT IS ONE SWITCH (UX-ACCESS A5) — RED-first.
//
// Owner order, 2026-09-13: *"Credentials collapse to ONE toggle: 'Access to
// stored credentials' — no per-credential rows. Simplify the MODEL to match, not
// just the UI (a boolean/all-or-none credentials grant is the honest shape now)."*
//
// ── WHY THE MODEL AND NOT ONLY THE PANEL ──
// A1 declared `integrations.credentials: string[] | '*'` and wired it at one
// door (ladder row 16) and one surface strip. A panel that draws a single
// toggle over a per-name list would be the disease this overhaul exists to cure:
// a field whose shape nobody can observe, with a second reading of it living in
// the UI. So the field becomes `boolean` and the per-name reader
// (`mayTouchCredentialIn` / `mayTouchCredential`) is DELETED rather than left
// with one caller.
//
// ── THE MIGRATION, MEASURED BEFORE IT WAS WRITTEN ──
// Every stored row on the owner's box, read at `eff652d4`:
//     integrations.credentials = "*"   × 111       (every pre-A4 agent)
//     integrations.credentials = []    ×   2       (A4's two terminated exemplars)
// NO AGENT HOLDS A PARTIAL SET, so the fold `'*' → true` / `[] → false` is exact
// and the 111-agent effective-capability diff is empty by construction. The
// partial case cannot arise from the A1 derivation either (`derive.ts` answers
// `'*'` and nothing else). `foldCredentialGrant` still has to answer it, and it
// answers UP — a non-empty list held the vault, and the surface strip and
// `credential_list` door both said so.
//
// RED AT `eff652d4`: `foldCredentialGrant` is not exported;
// `MOST_RESTRICTIVE_GRANTS.integrations.credentials` is `[]`, not `false`;
// `mayTouchCredentialIn` still exists; `grantsPatchSchema` accepts `'*'`.
// ════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-a5-credentials', 'dojo.db'),
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

vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { forgetAccessGrants, getAccessGrants, holdsCredentialGrant } from '../read.js';
import { deriveLegacyGrants } from '../derive.js';
import { ACCESS_PRESETS } from '../presets.js';
import { gatesForCall } from '../../tools/gates.js';
import { evaluateGate } from '../../tools/gate-eval.js';
import { accessLine } from '../../tools/cat/agents.js';
import {
  validateGrants, grantExcesses, mergeGrants, clampGrantsTo, grantsDelta,
  resolveSpawnGrants, resolveUpdateGrants,
} from '../authorize.js';
import * as shared from '@dojo/shared';
import { MOST_RESTRICTIVE_GRANTS, foldCredentialGrant, cloneGrants } from '@dojo/shared';
import type { AccessGrants } from '@dojo/shared';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => fs.readFileSync(path.join(SRC, rel), 'utf8');
const db = (): Database.Database => mockDb.current!;

/** Insert an agent and store a grants object built from the A1 derivation. */
function agent(id: string, classification: string, mutate?: (g: AccessGrants) => void): void {
  db().prepare(
    `INSERT INTO agents (id, name, status, classification, session_started_at)
     VALUES (?, ?, 'idle', ?, '1970-01-01')`,
  ).run(id, id, classification);
  forgetAccessGrants();
  if (!mutate) return;
  const g = deriveLegacyGrants(id);
  mutate(g);
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

/** Store a RAW grants document — the only way to plant a pre-A5 shape, because
 *  the typed helpers above can no longer express one. */
function storeRaw(id: string, credentials: unknown): void {
  const g = JSON.parse(JSON.stringify(deriveLegacyGrants(id))) as Record<string, unknown>;
  (g.integrations as Record<string, unknown>).credentials = credentials;
  db().prepare('UPDATE agents SET permissions = ? WHERE id = ?').run(JSON.stringify({ grants: g }), id);
  forgetAccessGrants();
}

const ctx = (agentId: string, name: string, args: Record<string, unknown> = {}) => ({
  agentId, name, args, resolveRef: () => null,
});

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  forgetAccessGrants();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 · THE FIELD IS A BOOLEAN, AND THE PER-NAME READER IS GONE
// ════════════════════════════════════════════════════════════════════════════════

describe('the model says what the panel says', () => {
  it('⚠ `MOST_RESTRICTIVE_GRANTS` HOLDS `false`, NOT AN EMPTY LIST', () => {
    expect(MOST_RESTRICTIVE_GRANTS.integrations.credentials).toBe(false);
    expect(typeof MOST_RESTRICTIVE_GRANTS.integrations.credentials).toBe('boolean');
  });

  it('⚠ THE PER-NAME READER IS DELETED — one switch cannot have a second, finer authority', () => {
    // The failure this pins is the one the overhaul exists to end: a field
    // simplified in the UI while a narrower reading of it survives at a door.
    expect('mayTouchCredentialIn' in shared, '@dojo/shared no longer exports a per-name reader').toBe(false);
    expect(read('agent/access/read.ts')).not.toContain('mayTouchCredential');
    expect(read('agent/tools/gate-eval.ts')).not.toContain('mayTouchCredential');
  });

  it('the derivation answers `true` — the A1 snapshot said every agent held the vault', () => {
    agent('worker', 'apprentice');
    expect(deriveLegacyGrants('worker').integrations.credentials).toBe(true);
  });

  it('the shape is the SAME shape Plaud already had — the two boolean integrations read alike', () => {
    const src = read('agent/access/read.ts');
    // `mayUsePlaud` reads the field directly; so does the credential reader. One
    // idiom for the two booleans, rather than a helper for one of them.
    expect(src).toMatch(/integrations\.plaud/);
    expect(src).toMatch(/integrations\.credentials/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 · THE MIGRATION — the fold, stated as one function
// ════════════════════════════════════════════════════════════════════════════════

describe('a pre-A5 stored object folds, with no row rewritten and no DDL', () => {
  it('⚠ `"*"` FOLDS TO `true` — the value all 111 live agents carry', () => {
    expect(foldCredentialGrant('*')).toBe(true);
  });

  it('⚠ `[]` FOLDS TO `false` — the value A4\'s two exemplars carry', () => {
    expect(foldCredentialGrant([])).toBe(false);
  });

  it('a NON-EMPTY list folds UP, because holding one name was holding the vault', () => {
    // The surface strip (`holdsCredentialGrant`) and `credential_list` both said
    // "yes" for such an agent already. Folding DOWN would take away access an
    // owner deliberately granted; folding up is the direction this box can never
    // exercise, because no row on it holds a partial set (header).
    expect(foldCredentialGrant(['plaud_token'])).toBe(true);
    expect(foldCredentialGrant(['a', 'b'])).toBe(true);
  });

  it('a boolean passes through, so the fold is idempotent once a row is rewritten', () => {
    expect(foldCredentialGrant(true)).toBe(true);
    expect(foldCredentialGrant(false)).toBe(false);
    expect(foldCredentialGrant(foldCredentialGrant('*'))).toBe(true);
  });

  it('anything else DENIES — a malformed field never widens', () => {
    for (const junk of [undefined, null, 'all', 0, 1, {}]) {
      expect(foldCredentialGrant(junk), `${JSON.stringify(junk)} denies`).toBe(false);
    }
  });

  it('⚠ THE FOLD HAPPENS AT THE ONE READ BOUNDARY, so no door ever sees the old shape', () => {
    agent('legacy', 'ronin');
    storeRaw('legacy', '*');
    expect(getAccessGrants('legacy').integrations.credentials).toBe(true);
    expect(holdsCredentialGrant('legacy')).toBe(true);

    storeRaw('legacy', []);
    expect(getAccessGrants('legacy').integrations.credentials).toBe(false);
    expect(holdsCredentialGrant('legacy')).toBe(false);

    storeRaw('legacy', ['plaud_token']);
    expect(getAccessGrants('legacy').integrations.credentials).toBe(true);
  });

  it('THE 111-CONTROL: a row carrying the migrated `"*"` is refused nothing it held', async () => {
    agent('migrated', 'apprentice');
    storeRaw('migrated', '*');
    for (const tool of ['credential_list', 'credential_get', 'credential_add', 'credential_update', 'credential_delete']) {
      const gate = gatesForCall(tool, { service_name: 'stripe_live' }).find((x) => x.kind === 'credential')!;
      const out = await evaluateGate(gate, ctx('migrated', tool, { service_name: 'stripe_live' }));
      expect(out.verdict.allowed, `${tool} still opens for a migrated agent`).toBe(true);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 · THE EXECUTOR WALL — row 16, now boolean-keyed
// ════════════════════════════════════════════════════════════════════════════════

describe('ladder row 16 asks one question', () => {
  it('⚠ EVERY CREDENTIAL TOOL IS REFUSED FOR AN AGENT WITH THE SWITCH OFF', async () => {
    agent('closed', 'ronin', (g) => { g.integrations.credentials = false; });
    for (const tool of ['credential_list', 'credential_get', 'credential_add', 'credential_update', 'credential_delete']) {
      const gate = gatesForCall(tool, { service_name: 'stripe_live' }).find((x) => x.kind === 'credential')!;
      const out = await evaluateGate(gate, ctx('closed', tool, { service_name: 'stripe_live' }));
      expect(out.verdict.allowed, `${tool} is refused`).toBe(false);
      expect(out.errorCode).toBe('PERMISSION_DENIED');
      expect(out.auditAs).toBe(tool);
    }
  });

  it('⚠ THE REFUSAL NO LONGER CLAIMS A PER-CREDENTIAL RULE THAT NO LONGER EXISTS', async () => {
    agent('closed', 'ronin', (g) => { g.integrations.credentials = false; });
    const gate = gatesForCall('credential_get', { service_name: 'stripe_live' }).find((x) => x.kind === 'credential')!;
    const out = await evaluateGate(gate, ctx('closed', 'credential_get', { service_name: 'stripe_live' }));
    const message = (out.verdict.allowed === false && out.verdict.blockedMessage) || '';
    expect(message).toContain('does not have access to stored credentials');
    expect(message, 'it does not name the credential as if that were the rule').not.toContain('"stripe_live"');
    expect(message, 'the refusal says what to do about it').toMatch(/primary agent/i);
  });

  it('the SAME sentence whether or not a service was named — one rule, one message', async () => {
    agent('closed', 'ronin', (g) => { g.integrations.credentials = false; });
    const named = gatesForCall('credential_get', { service_name: 'stripe_live' }).find((x) => x.kind === 'credential')!;
    const bare = gatesForCall('credential_list', {}).find((x) => x.kind === 'credential')!;
    const a = await evaluateGate(named, ctx('closed', 'credential_get', { service_name: 'stripe_live' }));
    const b = await evaluateGate(bare, ctx('closed', 'credential_list'));
    expect(a.verdict.allowed === false && a.verdict.blockedMessage)
      .toBe(b.verdict.allowed === false && b.verdict.blockedMessage);
    expect(a.verdict.rule).toBe(b.verdict.rule);
  });

  it('the AUDIT still names which credential was reached for — the message lost detail, the row did not', async () => {
    agent('closed', 'ronin', (g) => { g.integrations.credentials = false; });
    const gate = gatesForCall('credential_delete', { service_name: 'stripe_live' }).find((x) => x.kind === 'credential')!;
    const out = await evaluateGate(gate, ctx('closed', 'credential_delete', { service_name: 'stripe_live' }));
    expect(out.resource).toBe('stripe_live');
  });

  it('THE POSITIVE CONTROL: the switch on opens every one of them', async () => {
    agent('open', 'ronin', (g) => { g.integrations.credentials = true; });
    for (const tool of ['credential_list', 'credential_get', 'credential_delete']) {
      const gate = gatesForCall(tool, { service_name: 'anything' }).find((x) => x.kind === 'credential')!;
      expect((await evaluateGate(gate, ctx('open', tool, { service_name: 'anything' }))).verdict.allowed).toBe(true);
    }
  });

  it('and the SURFACE strip reads the same switch, so nothing advertised is refused', () => {
    agent('closed', 'ronin', (g) => { g.integrations.credentials = false; });
    agent('open', 'ronin', (g) => { g.integrations.credentials = true; });
    expect(holdsCredentialGrant('closed')).toBe(false);
    expect(holdsCredentialGrant('open')).toBe(true);
    expect(read('agent/tools/surface.ts')).toContain('holdsCredentialGrant(agentId)');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 · THE GRANT DOOR (A2's arg shape)
// ════════════════════════════════════════════════════════════════════════════════

describe('a model grants the switch, not a list', () => {
  const holder = (on: boolean): AccessGrants => {
    const g = cloneGrants(MOST_RESTRICTIVE_GRANTS);
    g.integrations.credentials = on;
    return g;
  };

  it('⚠ THE ARGUMENT IS A BOOLEAN', () => {
    expect(validateGrants({ integrations: { credentials: true } }).ok).toBe(true);
    expect(validateGrants({ integrations: { credentials: false } }).ok).toBe(true);
  });

  it('⚠ THE OLD SHAPES ARE REFUSED, AND THE REFUSAL NAMES THE FIELD', () => {
    for (const old of ['*', [], ['stripe_live']]) {
      const out = validateGrants({ integrations: { credentials: old } });
      expect(out.ok, `${JSON.stringify(old)} is no longer a grant`).toBe(false);
      expect(out.ok === false && out.reason).toContain('integrations.credentials');
    }
  });

  it('NO ESCALATION: an agent without the switch cannot hand it on', () => {
    const out = grantExcesses({ integrations: { credentials: true } }, holder(false), true);
    expect(out.length).toBe(1);
    expect(out[0]).toContain('integrations.credentials');
    expect(out[0]).toMatch(/you do not hold it/);
  });

  it('…and withholding it is always allowed, exactly as Plaud is', () => {
    expect(grantExcesses({ integrations: { credentials: false } }, holder(false), true)).toEqual([]);
    expect(grantExcesses({ integrations: { credentials: true } }, holder(true), true)).toEqual([]);
  });

  it('the merge sets the field and the clamp narrows it, both as one boolean', () => {
    expect(mergeGrants(holder(false), { integrations: { credentials: true } }).integrations.credentials).toBe(true);
    expect(clampGrantsTo(holder(true), holder(false)).integrations.credentials).toBe(false);
    expect(clampGrantsTo(holder(true), holder(true)).integrations.credentials).toBe(true);
  });

  it('the audit delta reads as a boolean move', () => {
    expect(grantsDelta(holder(false), holder(true))).toContain('integrations.credentials: false → true');
    expect(grantsDelta(holder(true), holder(true))).toBe('');
  });

  it('⚠ THE SPAWN FLOOR DENIES IT, so a new agent never starts holding the vault', () => {
    const out = resolveSpawnGrants(undefined, holder(true), true);
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.grants.integrations.credentials).toBe(false);
  });

  it('the edit door round-trips what `get_agent_profile` would have handed back', () => {
    // A model reads an agent's grants and posts them straight back. Under the old
    // shape that carried `"*"`; under this one it carries `true`, and the schema
    // has to accept its own output or the round trip teaches nothing.
    const current = holder(true);
    const out = resolveUpdateGrants({ v: 1, integrations: { credentials: true } }, current, holder(true), true);
    expect(out.ok).toBe(true);
    expect(out.ok === true && out.grants.integrations.credentials).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 5 · THE CAPABILITY LINE AND THE PRESETS
// ════════════════════════════════════════════════════════════════════════════════

describe('what the delegation door tells the model', () => {
  it('⚠ THE LINE IS BYTE-IDENTICAL FOR BOTH LIVE SHAPES — `all` and `none` are the pre-A5 words', () => {
    // The 111 agents alive at `eff652d4` all read `credentials: all`, and A4's
    // Reader exemplar read `credentials: none`. Those two strings are what the
    // old `'*'` / `[]` branches produced, so no agent's line moves by one byte.
    agent('rich', 'ronin', (g) => { g.integrations.credentials = true; });
    agent('poor', 'ronin', (g) => { g.integrations.credentials = false; });
    expect(accessLine('rich')).toContain('credentials: all');
    expect(accessLine('poor')).toContain('credentials: none');
  });

  it('and the comma-list branch is gone with the shape that produced it', () => {
    expect(read('agent/tools/cat/agents.ts')).not.toMatch(/creds\.join\(/);
  });

  it('⚠ "FULL TRUST" GRANTS THE SWITCH; THE OTHER THREE DO NOT — the Reader\'s line included', () => {
    const by = (id: string) => ACCESS_PRESETS.find((p) => p.id === id)!.grants;
    expect(by('full_trust').integrations.credentials).toBe(true);
    for (const id of ['most_restrictive', 'reader', 'operator']) {
      expect(by(id).integrations.credentials, `${id} holds no credential access`).toBe(false);
    }
  });
});
