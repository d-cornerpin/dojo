// ════════════════════════════════════════════════════════════════════════════
// T83 — A CREDENTIAL IS NEVER SILENTLY OVERWRITTEN.
//
// THE DEFECT, re-derived from the live store and the message rows rather than
// from the triage report's prose. The report says "`credential_add` semantics
// silently overwrite an existing service_name row". `addCredential` in fact
// already REFUSED a duplicate name — and that refusal is how the data was lost:
//
//   06:41:38  credential_get("sendgrid")     ← the agent READ the owner's key
//   06:42:06  credential_list                ← and saw the row's own provenance
//   06:42:22  credential_update("sendgrid", {api_key: "sk-live-…"})
//   06:42:22  → "Credential \"sendgrid\" updated."
//
// (messages seq 79091 / 79098 / 79103 / 79104; `agent_credentials.sendgrid`
// created 2026-06-21 03:03:03 by kevin, updated_at now 2026-09-21 06:42:22.)
//
// So the overwrite door is `credential_update`, it takes no confirmation, it
// keeps no prior version, it writes no audit row, and `credential_add`'s own
// refusal text ROUTES THE CALLER TO IT ("use credential_update to change its
// value"). A four-month-old key the owner provisioned was replaced by a
// battery-minted fake and the entire receipt was five words.
//
// THE PROPERTY: a write that would DESTROY a stored value refuses by default,
// names what it would have destroyed (when it was created, by whom, when it was
// last changed) and names the flag that would authorise it — and every
// authorised overwrite leaves an audit row. The flag is not a formality: it is
// the caller saying, on the record, which specific existing value it is ending.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
// A fixed 32-byte master key so `at-rest.ts` can seal/open inside the suite.
vi.mock('../../config/loader.js', () => ({
  getCredentialMasterKey: () => Buffer.alloc(32, 7),
  getSecret: () => null,
  getProviderCredential: () => null,
}));

const OWNER_AGENT = 'kevin';
const BATTERY_AGENT = 'behaviorbot';

beforeEach(() => {
  // NO `vi.resetModules()` here, deliberately. The store and the tool module hold no
  // module-level state — `getDb` is mocked to read `mockDb.current` at CALL time, so a fresh
  // database per test is all the isolation this suite needs. Resetting the module graph instead
  // made every clause re-import `../tools.js` (and with it the whole tool-definition chain)
  // from scratch: ~2.5 s each in isolation, over the 5 s timeout under full-suite load, and
  // slow enough to starve neighbouring suites' own whole-tree walks into failing too.
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT, status TEXT, config TEXT, updated_at TEXT);
    INSERT INTO agents (id, name) VALUES ('${OWNER_AGENT}', 'Kevin'), ('${BATTERY_AGENT}', 'BehaviorBot');
    CREATE TABLE agent_credentials (
      id TEXT PRIMARY KEY,
      service_name TEXT NOT NULL UNIQUE,
      description TEXT,
      encrypted_credentials BLOB NOT NULL,
      iv BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_by_agent_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      last_accessed_by_agent_id TEXT,
      access_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE audit_log (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, action_type TEXT NOT NULL,
      target TEXT, result TEXT NOT NULL, detail TEXT, cost REAL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      turn_number INTEGER, call_id TEXT, root_kind TEXT, root_id TEXT
    );
  `);
  mockDb.current = db;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

/** The owner's real SendGrid row, as it stood before 2026-09-21. */
async function seedOwnersKey(): Promise<void> {
  const { addCredential } = await import('../store.js');
  const r = addCredential('sendgrid', { api_key: 'SG.real.owner-key' },
    'SendGrid API key provided by David on 2026-06-21', OWNER_AGENT);
  expect(r.ok).toBe(true);
  mockDb.current!.prepare(
    "UPDATE agent_credentials SET created_at = '2026-06-21 03:03:03', updated_at = '2026-06-21 03:03:03' WHERE service_name = 'sendgrid'",
  ).run();
}

function storedValue(): string {
  const row = mockDb.current!.prepare(
    'SELECT encrypted_credentials, iv, auth_tag FROM agent_credentials WHERE service_name = ?',
  ).get('sendgrid') as { encrypted_credentials: Buffer; iv: Buffer; auth_tag: Buffer };
  return JSON.stringify({ c: row.encrypted_credentials.toString('hex') });
}

function auditRows(): Array<{ agent_id: string; target: string | null; detail: string | null; result: string }> {
  return mockDb.current!.prepare('SELECT agent_id, target, detail, result FROM audit_log').all() as never;
}

// ── The refusal ──────────────────────────────────────────────────────────────

describe('a write that would destroy a stored value refuses by default', () => {
  it('THE RED: credential_update replaces a four-month-old key with no confirmation', async () => {
    await seedOwnersKey();
    const before = storedValue();
    const { updateCredential } = await import('../store.js');

    const result = updateCredential('sendgrid', { api_key: 'sk-live-battery-fake' },
      'rotated value, replaces the earlier key of the same lineage', BATTERY_AGENT);

    expect(result.ok, 'the exact write that destroyed the owner\'s key on 2026-09-21').toBe(false);
    expect(storedValue(), 'the stored value was replaced anyway').toBe(before);
  });

  it('the refusal NAMES what it is protecting — when it was made, and by whom', async () => {
    await seedOwnersKey();
    const { updateCredential } = await import('../store.js');
    const result = updateCredential('sendgrid', { api_key: 'sk-live-battery-fake' }, null, BATTERY_AGENT);

    expect(result.ok).toBe(false);
    const error = (result as { ok: false; error: string }).error;
    expect(error).toContain('sendgrid');
    expect(error, 'a refusal that does not say what exists teaches nothing').toContain('2026-06-21');
    expect(error, 'the owner needs to know WHOSE value this is').toContain(OWNER_AGENT);
    expect(error, 'door text names the flag that would authorise it').toContain('overwrite');
  });

  it('credential_add on an existing name refuses with the SAME facts, and no longer routes to a silent verb', async () => {
    await seedOwnersKey();
    const { addCredential } = await import('../store.js');
    const result = addCredential('sendgrid', { api_key: 'sk-live-battery-fake' }, null, BATTERY_AGENT);

    expect(result.ok).toBe(false);
    const error = (result as { ok: false; error: string }).error;
    expect(error).toContain('2026-06-21');
    expect(error).toContain(OWNER_AGENT);
    expect(error).toContain('overwrite');
  });

  it('CONTROL: a genuinely NEW service name still stores with no flag at all', async () => {
    const { addCredential, getCredentialByService } = await import('../store.js');
    const result = addCredential('brand_new_service', { api_key: 'k' }, 'first of its name', BATTERY_AGENT);
    expect(result.ok).toBe(true);
    expect(getCredentialByService('brand_new_service', null)?.credentials).toEqual({ api_key: 'k' });
  });
});

// ── The authorised overwrite ─────────────────────────────────────────────────

describe('an authorised overwrite works, and leaves a record', () => {
  it('the flag lets the write through and replaces the value', async () => {
    await seedOwnersKey();
    const { updateCredential, getCredentialByService } = await import('../store.js');

    const result = updateCredential('sendgrid', { api_key: 'SG.rotated.by-the-owner' },
      'rotated 2026-09-21', OWNER_AGENT, { overwrite: true });

    expect(result.ok).toBe(true);
    expect(getCredentialByService('sendgrid', null)?.credentials).toEqual({ api_key: 'SG.rotated.by-the-owner' });
  });

  it('credential_add WITH the flag overwrites IN PLACE — the slot keeps its provenance', async () => {
    await seedOwnersKey();
    const idBefore = (mockDb.current!.prepare('SELECT id FROM agent_credentials WHERE service_name = ?')
      .get('sendgrid') as { id: string }).id;
    const { addCredential } = await import('../store.js');

    const result = addCredential('sendgrid', { api_key: 'SG.new' }, 'replaced', OWNER_AGENT, { overwrite: true });

    expect(result.ok).toBe(true);
    const row = mockDb.current!.prepare(
      'SELECT id, created_at, created_by_agent_id FROM agent_credentials WHERE service_name = ?',
    ).get('sendgrid') as { id: string; created_at: string; created_by_agent_id: string };
    // Provenance is what makes the NEXT refusal able to say what it is protecting.
    // A delete-and-reinsert would launder exactly that away.
    expect(row.id).toBe(idBefore);
    expect(row.created_at).toBe('2026-06-21 03:03:03');
    expect(row.created_by_agent_id).toBe(OWNER_AGENT);
  });

  it('every authorised overwrite writes an audit row naming the service and the actor', async () => {
    await seedOwnersKey();
    const { updateCredential } = await import('../store.js');
    updateCredential('sendgrid', { api_key: 'SG.rotated' }, null, BATTERY_AGENT, { overwrite: true });

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe(BATTERY_AGENT);
    expect(`${rows[0].target} ${rows[0].detail}`).toContain('sendgrid');
    expect(rows[0].result).toBe('success');
  });

  it('the audit row carries no secret — not the old value, not the new one', async () => {
    await seedOwnersKey();
    const { updateCredential } = await import('../store.js');
    updateCredential('sendgrid', { api_key: 'sk-live-should-never-be-logged' }, null, BATTERY_AGENT, { overwrite: true });

    const blob = JSON.stringify(auditRows());
    expect(blob).not.toContain('sk-live-should-never-be-logged');
    expect(blob).not.toContain('SG.real.owner-key');
  });

  it('a REFUSED write leaves no audit row — the record is of overwrites, not of attempts', async () => {
    await seedOwnersKey();
    const { updateCredential } = await import('../store.js');
    updateCredential('sendgrid', { api_key: 'x' }, null, BATTERY_AGENT);
    expect(auditRows()).toHaveLength(0);
  });
});

// ── The tool surface, and the two callers that are the owner's own hand ──────

describe('the flag reaches the model, and the owner\'s own edits still work', () => {
  it('both write tools declare the overwrite flag in their schema', async () => {
    const { credentialsToolDefinitions } = await import('../tools.js');
    for (const toolName of ['credential_add', 'credential_update']) {
      const def = credentialsToolDefinitions.find((d) => d.name === toolName);
      const props = (def?.input_schema as { properties: Record<string, unknown> }).properties;
      expect(props.overwrite, `${toolName} gives the model no way to authorise an overwrite`).toBeDefined();
      expect(def?.description, `${toolName} never mentions the flag it now requires`).toMatch(/overwrite/);
    }
  });

  it('the tool hands the store\'s refusal to the model verbatim', async () => {
    await seedOwnersKey();
    const { executeCredentialTool } = await import('../tools.js');
    const out = await executeCredentialTool('credential_update',
      { service_name: 'sendgrid', credentials: { api_key: 'sk-live-fake' } }, BATTERY_AGENT);
    expect(out).toContain('2026-06-21');
    expect(out).toContain('overwrite');
  });

  it('the tool honours an explicit overwrite:true from the model', async () => {
    await seedOwnersKey();
    const { executeCredentialTool } = await import('../tools.js');
    const out = await executeCredentialTool('credential_update',
      { service_name: 'sendgrid', credentials: { api_key: 'SG.new' }, overwrite: true }, OWNER_AGENT);
    expect(out).toContain('updated');
    expect(auditRows()).toHaveLength(1);
  });

  it('THE RED (review IMPORTANT B-1): credential_delete refuses without confirm, and names the row', async () => {
    await seedOwnersKey();
    const { deleteCredentialByService, getCredentialByService } = await import('../store.js');

    const result = deleteCredentialByService('sendgrid', BATTERY_AGENT);

    expect(result.ok, 'the second destroy door was the quiet one').toBe(false);
    expect(result.error).toContain('2026-06-21');
    expect(result.error).toContain(OWNER_AGENT);
    expect(result.error).toContain('confirm=true');
    // And it points a caller who only wanted to REPLACE a value at the verb that keeps the
    // row's provenance, instead of letting delete-then-add launder it away.
    expect(result.error).toContain('credential_update');
    expect(getCredentialByService('sendgrid', null), 'the row was deleted anyway').not.toBeNull();
  });

  it('a confirmed delete works and leaves an audit row naming the row it ended', async () => {
    await seedOwnersKey();
    const { deleteCredentialByService, getCredentialByService } = await import('../store.js');

    const result = deleteCredentialByService('sendgrid', BATTERY_AGENT, { confirm: true });

    expect(result.ok).toBe(true);
    expect(getCredentialByService('sendgrid', null)).toBeNull();
    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_id).toBe(BATTERY_AGENT);
    expect(`${rows[0].target} ${rows[0].detail}`).toContain('sendgrid');
    expect(`${rows[0].target} ${rows[0].detail}`).toMatch(/delete/i);
  });

  it('the delete TOOL carries the flag, refuses without it, and honours it', async () => {
    await seedOwnersKey();
    const { credentialsToolDefinitions, executeCredentialTool } = await import('../tools.js');
    const def = credentialsToolDefinitions.find((d) => d.name === 'credential_delete');
    const props = (def?.input_schema as { properties: Record<string, unknown> }).properties;
    expect(props.confirm, 'the model has no way to authorise a deletion').toBeDefined();
    expect(def?.description).toMatch(/confirm/);

    const refused = await executeCredentialTool('credential_delete', { service_name: 'sendgrid' }, BATTERY_AGENT);
    expect(refused).toContain('2026-06-21');
    const done = await executeCredentialTool('credential_delete',
      { service_name: 'sendgrid', confirm: true }, BATTERY_AGENT);
    expect(done).toContain('deleted');
  });

  it('CONTROL: deleting a name that does not exist still says so, and writes nothing', async () => {
    const { deleteCredentialByService } = await import('../store.js');
    const result = deleteCredentialByService('never_existed', BATTERY_AGENT, { confirm: true });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('No credential found');
    expect(auditRows()).toEqual([]);
  });

  it('THE CENSUS: the two non-agent writers state their authorisation at the site', () => {
    // The dashboard PATCH is the owner editing their own row — their click IS the
    // confirmation — and the VNC rotate is the engine turning its own private slot.
    // Both are legitimate; both must SAY so rather than inherit it by accident.
    for (const f of ['gateway/routes/credentials.ts', 'screen-share/manager.ts']) {
      const src = fs.readFileSync(path.join(SRC_ROOT, f), 'utf-8');
      expect(/overwrite:\s*true/.test(src), `${f} overwrites without declaring it`).toBe(true);
      // FIX ROUND (review IMPORTANT B-1): and the same for the OTHER destroy door.
      expect(/confirm:\s*true/.test(src), `${f} deletes without declaring it`).toBe(true);
    }
    // The third writer this census used to check — `credentials/battery-residue-purge.ts`, the T83
    // remediation — was deleted on 2026-09-26 (see the tombstone at the foot of this file). Two
    // non-agent writers remain, and both are live doors rather than a one-shot script.
  });
});

// ── THE PURGE BLOCK IS GONE, WITH THE MODULE IT TESTED ──────────────────────
//
// `credentials/battery-residue-purge.ts` was DELETED on 2026-09-26 under the owner's rule that no
// agent names, people's names or identifiable information may appear in anything that ships. It was
// the one hit in the v3.2.0 audit that carried the owner's real credential inventory as STRING
// LITERALS IN A LIVE DATA STRUCTURE — his actual service-account names, the date one was
// provisioned, and a dev-box agent id five times — and comments ship (`removeComments` is unset), so
// those bytes reached every user's disk in `dist/credentials/battery-residue-purge.js`.
//
// It could go outright rather than be scrubbed because it was DEAD: the repo's own reachability
// walk (`deploy/checks/check-wiring.mjs`) classified it "reached only through a test", and this
// block was that test. A one-shot remediation with zero production callers belongs in `deploy/` or
// the kit, never in `src/`, and the rows it was written to delete were the dev box's own.
//
// The clauses that guarded the LIVE doors are all above and untouched: the overwrite refusal, the
// delete confirmation, the audit rows, and the census of the two non-agent writers.
