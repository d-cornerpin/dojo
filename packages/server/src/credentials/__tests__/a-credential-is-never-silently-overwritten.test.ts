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
  vi.resetModules();
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

  it('THE CENSUS: the two non-agent writers state their authorisation at the site', () => {
    // The dashboard PATCH is the owner editing their own row — their click IS the
    // confirmation — and the VNC rotate is the engine turning its own private slot.
    // Both are legitimate; both must SAY so rather than inherit it by accident.
    for (const f of ['gateway/routes/credentials.ts', 'screen-share/manager.ts']) {
      const src = fs.readFileSync(path.join(SRC_ROOT, f), 'utf-8');
      expect(/overwrite:\s*true/.test(src), `${f} overwrites without declaring it`).toBe(true);
    }
  });
});

// ── The purge, and what the owner is left looking at ─────────────────────────

describe('the battery residue is purged, and the clobbered slots are not hidden', () => {
  /**
   * The live store's own rows, provenance included — because provenance is exactly what the
   * purge checks. `BEHAVIORBOT_ID` is the agent id the audit read out of
   * `agent_credentials.created_by_agent_id` on this box; a fixture that seeded some other id
   * would prove only that the purge refuses to act, which is the NEXT clause's job.
   */
  const BEHAVIORBOT_ID = '57b52025-0b0f-40a6-b916-9efdb9a642a3';
  async function seedResidue(): Promise<void> {
    const { addCredential } = await import('../store.js');
    const stamp = (name: string, by: string | null, at: string): void => {
      mockDb.current!.prepare(
        'UPDATE agent_credentials SET created_by_agent_id = ?, created_at = ?, updated_at = ? WHERE service_name = ?',
      ).run(by, at, at, name);
    };
    addCredential('acme_t5b', { api_key: 'x' }, 'ACME API key', BEHAVIORBOT_ID);
    stamp('acme_t5b', BEHAVIORBOT_ID, '2026-08-02 09:35:24');
    addCredential('t6_probe', { api_key: 'x' }, 'probe', BEHAVIORBOT_ID);
    stamp('t6_probe', BEHAVIORBOT_ID, '2026-08-03 04:03:49');
    addCredential('t6b_probe', { api_key: 'x' }, 'T6B probe', null);
    stamp('t6b_probe', null, '2026-08-03 05:56:23');
    addCredential('stripe', { api_key: 'sk-live-x' }, 'Stripe, sk-live prefix', BEHAVIORBOT_ID);
    stamp('stripe', BEHAVIORBOT_ID, '2026-09-21 06:28:51');
    addCredential('stripe_live', { api_key: 'real' }, 'the owner\'s real Stripe key', OWNER_AGENT);
    stamp('stripe_live', OWNER_AGENT, '2026-06-21 03:03:03');
    addCredential('openweather', { api_key: 'sk-live-x' }, 'OpenWeather (rotated)', BEHAVIORBOT_ID);
    await seedOwnersKey();
  }

  it('THE RED: the enumerated synthetic rows go, and the owner\'s lookalikes stay', async () => {
    await seedResidue();
    const { purgeBatteryResidue } = await import('../battery-residue-purge.js');
    const report = purgeBatteryResidue();

    const names = (mockDb.current!.prepare('SELECT service_name FROM agent_credentials ORDER BY service_name')
      .all() as Array<{ service_name: string }>).map((r) => r.service_name);
    expect(names).not.toContain('acme_t5b');
    expect(names).not.toContain('t6_probe');
    expect(names).not.toContain('stripe');
    expect(names, 'the owner\'s own Stripe row is a DIFFERENT row').toContain('stripe_live');
    expect(names, 'a clobbered slot is annotated, never deleted').toContain('sendgrid');
    expect(names).toContain('openweather');
    expect(report.deleted).toContain('stripe');
    expect(report.annotated).toEqual(expect.arrayContaining(['sendgrid', 'openweather']));
  });

  it('the annotation is what the owner will actually read, on the surface they read it on', async () => {
    await seedResidue();
    const { purgeBatteryResidue } = await import('../battery-residue-purge.js');
    purgeBatteryResidue();

    const desc = (mockDb.current!.prepare('SELECT description FROM agent_credentials WHERE service_name = ?')
      .get('sendgrid') as { description: string }).description;
    expect(desc).toMatch(/NEEDS RE-ENTRY/i);
    expect(desc, 'the owner has to be told what happened').toMatch(/overwrote/i);
    expect(desc, 'and that the old value is not coming back').toMatch(/unrecoverable/i);
    // The original text is kept, not replaced: it is the only surviving description
    // of what the slot was FOR.
    expect(desc).toContain('SendGrid API key provided by David on 2026-06-21');

    const { listCredentials } = await import('../store.js');
    const listed = listCredentials().find((r) => r.serviceName === 'sendgrid');
    expect(listed?.description, 'the dashboard Credentials tab and credential_list read this field')
      .toMatch(/NEEDS RE-ENTRY/i);
  });

  it('an annotation never touches the stored value', async () => {
    await seedResidue();
    const before = storedValue();
    const { purgeBatteryResidue } = await import('../battery-residue-purge.js');
    purgeBatteryResidue();
    expect(storedValue()).toBe(before);
  });

  it('WHEN IN DOUBT, KEEP: a row whose provenance does not match the audit is reported, not deleted', async () => {
    const { addCredential } = await import('../store.js');
    // Same NAME as an enumerated residue row, but the owner made it — not the battery.
    addCredential('acme_t5b', { api_key: 'x' }, 'the owner\'s own', OWNER_AGENT);
    const { purgeBatteryResidue } = await import('../battery-residue-purge.js');
    const report = purgeBatteryResidue();

    const names = (mockDb.current!.prepare('SELECT service_name FROM agent_credentials').all() as Array<{ service_name: string }>)
      .map((r) => r.service_name);
    expect(names, 'a purge that deletes on name alone is a purge that eats real rows').toContain('acme_t5b');
    expect(report.keptForReview).toContain('acme_t5b');
  });

  it('it is idempotent — a second run deletes nothing and re-annotates nothing', async () => {
    await seedResidue();
    const { purgeBatteryResidue } = await import('../battery-residue-purge.js');
    purgeBatteryResidue();
    const descAfterOne = (mockDb.current!.prepare('SELECT description FROM agent_credentials WHERE service_name = ?')
      .get('sendgrid') as { description: string }).description;

    const second = purgeBatteryResidue();
    expect(second.deleted).toEqual([]);
    expect(second.annotated).toEqual([]);
    const descAfterTwo = (mockDb.current!.prepare('SELECT description FROM agent_credentials WHERE service_name = ?')
      .get('sendgrid') as { description: string }).description;
    expect(descAfterTwo).toBe(descAfterOne);
  });

  it('dryRun reports exactly what a real run would do, and changes nothing', async () => {
    await seedResidue();
    const { purgeBatteryResidue } = await import('../battery-residue-purge.js');
    const planned = purgeBatteryResidue({ dryRun: true });
    const namesAfter = (mockDb.current!.prepare('SELECT service_name FROM agent_credentials').all() as Array<{ service_name: string }>)
      .map((r) => r.service_name);
    expect(namesAfter).toContain('acme_t5b');
    expect(planned.deleted).toContain('acme_t5b');
    const real = purgeBatteryResidue();
    expect(real.deleted.sort()).toEqual(planned.deleted.sort());
  });
});
