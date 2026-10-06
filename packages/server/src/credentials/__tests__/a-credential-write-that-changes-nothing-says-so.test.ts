// ════════════════════════════════════════════════════════════════════════════
// t120 — A CREDENTIAL WRITE THAT CHANGES NOTHING SAYS SO, AND EVERY MODEL-FACING
// CREDENTIAL REFUSAL NAMES THE NEXT CALL.
//
// THE DEFECT, re-derived from the two failed draws' own bundles rather than from
// the triage prose. The triage says the loop was `credential_add` refusing on an
// existing name, the model retrying `credential_update`, and the refusal failing
// to teach. The recorded tool calls say something different, and it matters:
//
//   draw A, attempt 0:  credential_add(free name)            → SUCCESS
//                       credential_add(same, overwrite=true)  → SUCCESS   ×7
//   draw A, attempt 1:  credential_add(free name)            → SUCCESS
//                       credential_update(same, overwrite)    → SUCCESS   ×4
//                       credential_update(same, overwrite)    → BRAKE 4/5
//                       credential_update(same, overwrite)    → SUCCESS   ×5
//   draw B, attempt 0:  credential_add(free name)            → SUCCESS
//                       credential_update(same, overwrite)    → SUCCESS   ×3
//                       credential_update(same, overwrite)    → BRAKE 4/5/6
//
// Not one refusal in either red. The slot was FREE both times, the add landed,
// and every retry carried a byte-identical `credentials` payload and a
// byte-identical description to a slot that already held exactly those bytes.
// The identical-call brake then blocked calls 4/5/6 and the turn failed the
// NO_ENGINE_REFUSAL SAFETY invariant — in two of the last three reds.
//
// So the message that failed to teach was the SUCCESS message:
// `Credential "x" updated.` It says nothing about what changed, nothing about
// whether the credential is usable, and names no next call — so the model had no
// way to learn its write had landed, and the cheapest check it had was to write
// again. (T83's header already recorded that three-word receipt as "the whole
// receipt"; it closed the authorisation hole and left the text alone.)
//
// THE PROPERTY, three parts:
//   1. A write whose payload equals the sealed value writes NOTHING — no
//      re-seal, no updated_at bump, and no destruction audit row. The T83 ledger
//      records that a specific stored value was ENDED; a no-op ended nothing.
//   2. Every write result names the state and the next call — a no-op says it
//      was a no-op, a real overwrite says the previous value is gone, and both
//      name `credential_get`.
//   3. BOTH WAYS: every model-facing credential outcome that refuses or reports
//      a no-op carries a next-step pointer. A new refusal path added without one
//      reds §4's census rather than passing on absence.
//
// Fictional agents, fictional services, fictional key material throughout (G1).
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CRED_ROOT = path.resolve(HERE, '..');
const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));
vi.mock('../../config/loader.js', () => ({
  getCredentialMasterKey: () => Buffer.alloc(32, 11),
  getSecret: () => null,
  getProviderCredential: () => null,
}));

const OWNER_AGENT = 'zargo';
const BATTERY_AGENT = 'harnessbot';
const SLOT = 'batterytest-forecast';
/** The payload shape the failed draws sent, with fictional key material. */
const PAYLOAD = { api_key: 'FAKE-forecast-key-0001' };
const NOTE = 'Sandbox forecast API test key, handed over in dashboard chat for the weather technique';

// Pay the cold module compile ONCE, in a hook sized for cold work — same reason
// the T83 suite next door does it, and the same contract: this list is exactly
// the set of modules the clauses import cold, never a wildcard.
beforeAll(async () => {
  await Promise.all([
    import('../store.js'),
    import('../tools.js'),
  ]);
}, 120_000);

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT);
    INSERT INTO agents (id, name) VALUES ('${OWNER_AGENT}', 'Zargo'), ('${BATTERY_AGENT}', 'HarnessBot');
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

// ── helpers that read the row the way the store wrote it ──────────────────────

function row(): { updated_at: string; description: string | null; encrypted_credentials: Buffer } {
  return mockDb.current!.prepare(
    'SELECT updated_at, description, encrypted_credentials FROM agent_credentials WHERE service_name = ?',
  ).get(SLOT) as never;
}

/** The sealed bytes. A real re-seal changes them (random IV per seal); a no-op cannot. */
function sealedHex(): string {
  return row().encrypted_credentials.toString('hex');
}

function destructionRows(): Array<{ detail: string | null }> {
  return mockDb.current!.prepare(
    "SELECT detail FROM audit_log WHERE detail LIKE '%overwrote%' OR detail LIKE '%deleted%'",
  ).all() as never;
}

/** Drive the tool the model drives, not the store beneath it. */
async function tool(name: string, args: Record<string, unknown>, agent = BATTERY_AGENT): Promise<string> {
  const { executeCredentialTool } = await import('../tools.js');
  return executeCredentialTool(name, args, agent);
}

/** The add that opened both failed draws: a FREE slot, no flag, and it succeeds. */
async function seedTheDrawsOpeningAdd(): Promise<string> {
  const out = await tool('credential_add', { service_name: SLOT, credentials: PAYLOAD, description: NOTE });
  expect(out, 'the draws opened with a clean add on a free name').not.toContain('Error:');
  return out;
}

/** Any call that is actually useful next, e.g. `credential_get(service_name="x")`. */
const POINTER = /credential_(?:list|get|add|update|delete)\(/;

// ═══════════════════════════════════════════════════════════════════════════════
// §1 — THE RED: the failed draws' exact shape
// ═══════════════════════════════════════════════════════════════════════════════

describe('§1 the failed draws\' own call sequence', () => {
  it('THE RED: the 2nd, 3rd and 4th identical write report as changes and teach nothing', async () => {
    await seedTheDrawsOpeningAdd();
    const sealedAfterAdd = sealedHex();
    const updatedAfterAdd = row().updated_at;

    // Byte-identical payload, byte-identical note, authorised — three times, which is
    // exactly what reached the brake in both reds.
    const receipts: string[] = [];
    for (let i = 0; i < 3; i++) {
      receipts.push(await tool('credential_update', {
        service_name: SLOT, credentials: PAYLOAD, description: NOTE, overwrite: true,
      }));
    }

    for (const [i, receipt] of receipts.entries()) {
      expect(receipt, `retry ${i + 1} must not read as a change`).toMatch(/already holds exactly these values/);
      expect(receipt, `retry ${i + 1} must say nothing was destroyed`).toMatch(/nothing was written/);
      expect(receipt, `retry ${i + 1} must name the call that is actually useful next`)
        .toContain(`credential_get(service_name="${SLOT}")`);
      expect(receipt, `retry ${i + 1} must tell the model not to repeat the write`)
        .toMatch(/Do NOT send this value again/);
    }

    expect(sealedHex(), 'a no-op must not re-seal: the bytes are the add\'s bytes').toBe(sealedAfterAdd);
    expect(row().updated_at, 'a no-op must not bump updated_at').toBe(updatedAfterAdd);
    expect(destructionRows(), 'three identical writes destroyed nothing, so the T83 ledger cuts no row')
      .toHaveLength(0);
  });

  it('the OTHER red\'s shape — repeated credential_add with overwrite=true — reports the same way', async () => {
    await seedTheDrawsOpeningAdd();
    const sealed = sealedHex();

    // Draw A attempt 0 sent this seven times; three is past the brake's threshold of four.
    for (let i = 0; i < 3; i++) {
      const receipt = await tool('credential_add', {
        service_name: SLOT, credentials: PAYLOAD, description: NOTE, overwrite: true,
      });
      expect(receipt, 'the add door must not claim a store that did not happen')
        .toMatch(/already holds exactly these values/);
      expect(receipt).toContain(`credential_get(service_name="${SLOT}")`);
    }
    expect(sealedHex()).toBe(sealed);
    expect(destructionRows()).toHaveLength(0);
  });

  it('key order is not a difference: {a,b} and {b,a} are the one value they are', async () => {
    await tool('credential_add', {
      service_name: SLOT, credentials: { api_key: 'FAKE-k', workspace: 'w1' }, description: NOTE,
    });
    const sealed = sealedHex();
    const receipt = await tool('credential_update', {
      service_name: SLOT, credentials: { workspace: 'w1', api_key: 'FAKE-k' }, overwrite: true,
    });
    expect(receipt).toMatch(/already holds exactly these values/);
    expect(sealedHex()).toBe(sealed);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §2 — the CONTROLS: a real change must still be a real change
// ═══════════════════════════════════════════════════════════════════════════════

describe('§2 a real change is untouched by the no-op branch', () => {
  it('CONTROL: a genuinely different value re-seals, audits the destruction, and names the next call', async () => {
    await seedTheDrawsOpeningAdd();
    const sealed = sealedHex();

    const receipt = await tool('credential_update', {
      service_name: SLOT, credentials: { api_key: 'FAKE-forecast-key-0002' }, overwrite: true,
    });

    expect(receipt, 'a real overwrite must NOT claim nothing happened').not.toMatch(/already holds/);
    expect(receipt, 'the caller is told the prior value is gone').toMatch(/previous value is gone/);
    expect(receipt, 'and where to go next — the pointer credential_add always had')
      .toContain(`credential_get(service_name="${SLOT}")`);
    expect(sealedHex(), 'the value really was replaced').not.toBe(sealed);
    expect(destructionRows(), 'a real destruction DOES leave the T83 audit row').toHaveLength(1);
  });

  it('CONTROL: the unauthorised overwrite still refuses — the no-op branch sits BEHIND the flag', async () => {
    await seedTheDrawsOpeningAdd();
    const sealed = sealedHex();
    // Same bytes, no flag. It must still refuse: whether the payload matches is not the
    // caller's authorisation to end a value, and a no-op that skipped the flag check would
    // tell an unauthorised caller whether its guess equalled the stored secret.
    const receipt = await tool('credential_update', { service_name: SLOT, credentials: PAYLOAD });
    expect(receipt, 'no flag, no write — matching bytes are not authorisation').toContain('Error:');
    expect(receipt).toMatch(/overwrite/);
    expect(sealedHex()).toBe(sealed);
  });

  it('CONTROL: a no-op never clears the note, and a new note lands without a destruction row', async () => {
    await seedTheDrawsOpeningAdd();
    expect(row().description).toBe(NOTE);

    // `credential_add` passes description as null whenever the model simply omitted it.
    await tool('credential_add', { service_name: SLOT, credentials: PAYLOAD, overwrite: true });
    expect(row().description, 'an omitted note must not wipe the column that says what the slot is FOR')
      .toBe(NOTE);

    const receipt = await tool('credential_update', {
      service_name: SLOT, credentials: PAYLOAD, description: 'same key, clarified note', overwrite: true,
    });
    expect(row().description, 'a real note change still lands').toBe('same key, clarified note');
    expect(receipt, 'and is reported').toMatch(/description was updated/);
    expect(destructionRows(), 'changing a note destroys no value').toHaveLength(0);
  });

  it('CONTROL: an undecryptable row counts as NOT identical, so key-rotation recovery is unblocked', async () => {
    await seedTheDrawsOpeningAdd();
    // A master-key rotation leaves ciphertext this key cannot open. The comparison cannot be
    // made, so it must not be guessed: the overwrite proceeds exactly as it did before t120.
    mockDb.current!.prepare(
      'UPDATE agent_credentials SET encrypted_credentials = ? WHERE service_name = ?',
    ).run(Buffer.from('not openable with this key'), SLOT);

    const receipt = await tool('credential_update', {
      service_name: SLOT, credentials: PAYLOAD, overwrite: true,
    });
    expect(receipt, 'the recovery write must land, not be mistaken for a no-op')
      .not.toMatch(/already holds/);
    expect(receipt).toMatch(/previous value is gone/);
    const { getCredentialByService } = await import('../store.js');
    expect(getCredentialByService(SLOT, null)?.credentials, 'the row is readable again')
      .toEqual(PAYLOAD);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §3 — the refusals that WERE in the triage's story, driven both ways
// ═══════════════════════════════════════════════════════════════════════════════

describe('§3 the refusals name the verb, the arguments and the flag that would succeed', () => {
  it('add-on-existing names the exact call that succeeds, and how to find a free name', async () => {
    await seedTheDrawsOpeningAdd();
    const receipt = await tool('credential_add', { service_name: SLOT, credentials: { api_key: 'FAKE-other' } });

    expect(receipt).toContain('Error:');
    expect(receipt, 'the exact verb AND shape, not a prose hint')
      .toContain(`credential_add(service_name="${SLOT}", credentials={…}, overwrite=true)`);
    expect(receipt, 'what it is protecting — a refusal that does not say teaches nothing')
      .toContain(BATTERY_AGENT);
    expect(receipt, 'the way to learn which names are taken').toMatch(/credential_list/);
    expect(receipt, 'and the branch the failed draws were in: read, do not re-write')
      .toContain(`credential_get(service_name="${SLOT}")`);
  });

  it('the failed draws\' update shape succeeds outright when the value really is new', async () => {
    await seedTheDrawsOpeningAdd();
    // The brief's clause (2): drive the shape the reds sent and show it either succeeds or
    // says exactly what to change. With a new value it succeeds on the first call.
    const receipt = await tool('credential_update', {
      service_name: SLOT, credentials: { api_key: 'FAKE-rotated' }, description: NOTE, overwrite: true,
    });
    expect(receipt).not.toContain('Error:');
    expect(receipt).toMatch(/updated/);
  });

  it('BOTH WAYS: update on a MISSING slot names credential_add — it used to be a dead end', async () => {
    const receipt = await tool('credential_update', {
      service_name: 'never-stored-slot', credentials: PAYLOAD, overwrite: true,
    });
    expect(receipt).toContain('Error:');
    expect(receipt, 'the one next call that is right here, with its shape')
      .toContain('credential_add(service_name="never-stored-slot", credentials={…})');
    expect(receipt, 'and the flag question answered before it is asked').toMatch(/no overwrite flag is needed/);
    expect(receipt, 'plus the way to check the name').toMatch(/credential_list/);
  });

  it('BOTH WAYS: delete on a MISSING slot says the job is already done', async () => {
    const receipt = await tool('credential_delete', { service_name: 'never-stored-slot', confirm: true });
    expect(receipt).toContain('Error:');
    expect(receipt).toMatch(/nothing to remove and no further call is needed/);
    expect(receipt).toMatch(/credential_list/);
  });

  it('the delete door still redirects a replace to update, with the flag', async () => {
    await seedTheDrawsOpeningAdd();
    const receipt = await tool('credential_delete', { service_name: SLOT });
    expect(receipt).toContain('Error:');
    expect(receipt).toContain(`credential_delete(service_name="${SLOT}", confirm=true)`);
    expect(receipt).toContain(`credential_update(service_name="${SLOT}", credentials={…}, overwrite=true)`);
  });

  it('both write doors state the object SHAPE when the payload is the wrong type', async () => {
    // credential_update used to say only "credentials must be an object." while
    // credential_add showed the shape. A refusal that withholds the shape makes the caller
    // guess, and a guessing caller is this family's whole defect.
    for (const verb of ['credential_add', 'credential_update']) {
      const receipt = await tool(verb, { service_name: SLOT, credentials: 'FAKE-bare-string' });
      expect(receipt, `${verb} must show the shape it wants`).toMatch(/\{"api_key": "\.\.\."\}/);
      expect(receipt, `${verb} must cover the single-opaque-token case`).toMatch(/\{"value": "\.\.\."\}/);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §4 — THE CENSUS, with teeth in both directions
// ═══════════════════════════════════════════════════════════════════════════════

describe('§4 census: every model-facing credential outcome that refuses or no-ops points somewhere', () => {
  // Every outcome a MODEL can reach through `executeCredentialTool` that is not a plain
  // success. Each is driven for real and must carry a pointer. Adding a refusal path to the
  // credential tools without adding it here reds the arithmetic clause below.
  // `kind` is what makes §4's arithmetic self-maintaining: 'refusal' entries each correspond
  // to one refusal-returning site in the source, 'receipt' entries are the non-refusal outcomes
  // (an empty list, a write that changed nothing) which the same pointer rule binds.
  const ROSTER: Array<{ label: string; drive: () => Promise<string>; pointer: boolean; kind: 'refusal' | 'receipt' }> = [
    {
      label: 'credential_list with nothing stored', kind: 'receipt',
      drive: () => tool('credential_list', {}),
      pointer: true,
    },
    {
      label: 'credential_get on a missing slot', kind: 'refusal',
      drive: () => tool('credential_get', { service_name: 'never-stored-slot' }),
      pointer: true,
    },
    {
      label: 'credential_add on an existing name, unauthorised', kind: 'refusal',
      drive: async () => { await seedTheDrawsOpeningAdd(); return tool('credential_add', { service_name: SLOT, credentials: { api_key: 'FAKE-x' } }); },
      pointer: true,
    },
    {
      label: 'credential_add that changes nothing', kind: 'receipt',
      drive: async () => { await seedTheDrawsOpeningAdd(); return tool('credential_add', { service_name: SLOT, credentials: PAYLOAD, overwrite: true }); },
      pointer: true,
    },
    {
      label: 'credential_update on an existing name, unauthorised', kind: 'refusal',
      drive: async () => { await seedTheDrawsOpeningAdd(); return tool('credential_update', { service_name: SLOT, credentials: { api_key: 'FAKE-x' } }); },
      pointer: true,
    },
    {
      label: 'credential_update that changes nothing', kind: 'receipt',
      drive: async () => { await seedTheDrawsOpeningAdd(); return tool('credential_update', { service_name: SLOT, credentials: PAYLOAD, overwrite: true }); },
      pointer: true,
    },
    {
      label: 'credential_update on a missing slot', kind: 'refusal',
      drive: () => tool('credential_update', { service_name: 'never-stored-slot', credentials: PAYLOAD, overwrite: true }),
      pointer: true,
    },
    {
      label: 'credential_delete on an existing name, unconfirmed', kind: 'refusal',
      drive: async () => { await seedTheDrawsOpeningAdd(); return tool('credential_delete', { service_name: SLOT }); },
      pointer: true,
    },
    {
      // Caught by the census's arithmetic, not by the triage: the one refusal a caller cannot
      // reason its way out of named the acts ("Delete and re-add") but neither call.
      label: 'credential_get on a row this master key cannot open', kind: 'refusal',
      drive: async () => {
        await seedTheDrawsOpeningAdd();
        mockDb.current!.prepare('UPDATE agent_credentials SET encrypted_credentials = ? WHERE service_name = ?')
          .run(Buffer.from('not openable with this key'), SLOT);
        return tool('credential_get', { service_name: SLOT });
      },
      pointer: true,
    },
    {
      label: 'credential_delete on a missing slot', kind: 'refusal',
      drive: () => tool('credential_delete', { service_name: 'never-stored-slot', confirm: true }),
      pointer: true,
    },
    // The argument-shape class: these are about the caller's OWN arguments, not about stored
    // state, so what they owe the caller is the shape — naming another tool would be noise.
    { label: 'credential_add missing service_name', drive: () => tool('credential_add', { credentials: PAYLOAD }), pointer: false, kind: 'refusal' },
    { label: 'credential_add non-object payload', drive: () => tool('credential_add', { service_name: SLOT, credentials: 'FAKE-s' }), pointer: false, kind: 'refusal' },
    { label: 'credential_get missing service_name', drive: () => tool('credential_get', {}), pointer: false, kind: 'refusal' },
    { label: 'credential_update missing service_name', drive: () => tool('credential_update', { credentials: PAYLOAD }), pointer: false, kind: 'refusal' },
    { label: 'credential_update non-object payload', drive: () => tool('credential_update', { service_name: SLOT, credentials: 'FAKE-s' }), pointer: false, kind: 'refusal' },
    { label: 'credential_delete missing service_name', drive: () => tool('credential_delete', {}), pointer: false, kind: 'refusal' },
    { label: 'an unknown credential verb', drive: () => tool('credential_nope', {}), pointer: false, kind: 'refusal' },
  ];

  it('every state-bearing outcome in the roster carries a next-step pointer', async () => {
    for (const entry of ROSTER.filter(e => e.pointer)) {
      const receipt = await entry.drive();
      expect(receipt, `${entry.label}: a dead end is the defect this lane closed`).toMatch(POINTER);
      // Reset the row between drives so each entry sees the state it describes.
      mockDb.current!.prepare('DELETE FROM agent_credentials').run();
      mockDb.current!.prepare('DELETE FROM audit_log').run();
    }
  });

  it('every argument-shape outcome states the shape rather than naming a tool', async () => {
    for (const entry of ROSTER.filter(e => !e.pointer)) {
      const receipt = await entry.drive();
      expect(receipt, `${entry.label}: must still be an explicit refusal`).toMatch(/Error:|Unknown credential tool/);
      mockDb.current!.prepare('DELETE FROM agent_credentials').run();
    }
  });

  it('BOTH WAYS: the roster covers every refusal site in all three credential modules', () => {
    // THE TEETH, and the exact reach of them. A presence-only census stays green when an
    // undeclared refusal is added, so this one counts the refusal-returning sites in the SOURCE
    // — comments stripped first, so the prose above a call can never satisfy it — and pins that
    // count to the roster.
    //
    // WHAT IT CATCHES: a refusal written in the engine's refusal shapes (`return { ok: false,
    // error: … }`, a `return 'Error: …'`, a `No credential …` or `Unknown credential …`
    // template). That is the convention this family is written in, and planting one of those
    // reds this clause.
    //
    // WHAT IT DOES NOT CATCH, stated because a reviewer proved it by planting one: a refusal
    // written OUTSIDE those shapes — a plain template with no `Error:` prefix — passes here, as
    // does any new RECEIPT-class outcome, both uncounted by construction. The clause below
    // ("every outcome the executor can return is declared") is what closes that gap; this one is
    // the store-side backstop, since the refusals built in `store.ts` and `write-doors.ts` reach
    // the model through shared `Error: ${result.error}` passthroughs that no per-outcome count
    // can tell apart.
    const sites: string[] = [];
    // t120 extracted the door TEXTS into `write-doors.ts`, so the census follows the
    // concern: a refusal added in any of the three reds this clause.
    for (const file of ['store.ts', 'tools.ts', 'write-doors.ts']) {
      let src = fs.readFileSync(path.join(CRED_ROOT, file), 'utf8');
      src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
      const found = [
        ...src.matchAll(/return\s+\(?\s*(?:\{\s*ok:\s*false|['"`]Error:)/g),
        // `return (` wrapping a multi-line template is the same door as `return \``.
        ...src.matchAll(/return\s+\(?\s*`(?:No credential|Unknown credential)/g),
      ];
      for (const m of found) {
        const text = src.slice(m.index, m.index + 60).replace(/\s+/g, ' ');
        // `Error: ${result.error}` adds no text of its own — it is the carrier for a store-side
        // refusal already counted at its source, so counting it would double-count that door.
        if (/Error: \$\{result\.error\}/.test(text)) continue;
        sites.push(`${file} ${text}`);
      }
    }

    // The three store doors no model can reach: `annotateCredential` (the remediation note),
    // `deleteCredentialById` (the dashboard's own hand), and `addCredential`'s own
    // service_name-required + 100-char bounds, which the tool layer checks before the store
    // ever sees them but which the store still owes its non-agent callers. Four sites.
    const NON_MODEL_FACING = 4;
    // `missingRefusal` is a text BUILDER, not a door: its `return` matches the same shape as a
    // real site, and it now lives in `write-doors.ts`. One.
    const TEXT_BUILDERS = 1;
    const declared = ROSTER.filter(e => e.kind === 'refusal').length + NON_MODEL_FACING + TEXT_BUILDERS;

    expect(sites.length, `refusal sites in source:\n  ${sites.join('\n  ')}`).toBe(declared);
  });

  it('BOTH WAYS: every outcome the executor can return is DECLARED — shapeless refusals included', () => {
    // WHY THIS EXISTS, and it is a reviewer's finding rather than mine: the clause above counts
    // refusals written in the engine's four conventional shapes, so a refusal written outside
    // them — a plain template with no `Error:` prefix — passed it GREEN when planted, and any
    // new RECEIPT-class outcome was uncounted by construction. Both gaps have one cheap closure:
    // stop pattern-matching the TEXT and count the `return`s instead. Every string a model can
    // read out of these tools leaves `executeCredentialTool` through one of them, whatever its
    // prose looks like, so an undeclared outcome of ANY class reds this.
    const OUTCOMES = [
      'credential_list: nothing stored',
      'credential_list: the stored names',
      'credential_get: service_name missing',
      'credential_get: the row cannot be decrypted (the store throws; this is the catch)',
      'credential_get: no row under that name',
      'credential_get: the values, behind the freshness sentinel',
      'credential_add: service_name missing',
      'credential_add: payload is not an object',
      'credential_add: a store refusal, passed through',
      'credential_add: the write changed nothing',
      'credential_add: stored',
      'credential_update: service_name missing',
      'credential_update: payload is not an object',
      'credential_update: a store refusal, passed through',
      'credential_update: the write changed nothing',
      'credential_update: replaced',
      'credential_delete: service_name missing',
      'credential_delete: a store refusal, passed through',
      'credential_delete: deleted',
      'an unknown credential verb',
    ];
    // The one `return` in the executor that is NOT an outcome: the `.map` lambda that builds one
    // line of the credential_list listing. It returns into an array, never to the model.
    const LINE_BUILDERS = 1;

    let src = fs.readFileSync(path.join(CRED_ROOT, 'tools.ts'), 'utf8');
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const body = src.slice(src.indexOf('export async function executeCredentialTool'));
    const returns = [...body.matchAll(/\breturn\b/g)];

    expect(returns.length, `\`return\`s in executeCredentialTool: ${returns.length}; declared outcomes: ${OUTCOMES.length} (+${LINE_BUILDERS} line builder)`)
      .toBe(OUTCOMES.length + LINE_BUILDERS);
  });

  it('BOTH WAYS: the no-op branch is APPLIED at both write doors, not merely defined', () => {
    // A clause that only checked the helper exists would stay green if a door stopped calling
    // it. This asserts the call SHAPE at each door, with comments stripped.
    let src = fs.readFileSync(path.join(CRED_ROOT, 'store.ts'), 'utf8');
    src = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    const applied = [...src.matchAll(/const noop = noopWrite\([^)]*\);\s*\n\s*if \(noop\) return noop;/g)];
    expect(applied, 'both credential_add and credential_update must consult the no-op branch')
      .toHaveLength(2);
    // And the tool layer must ACT on the bit, at both doors.
    let tools = fs.readFileSync(path.join(CRED_ROOT, 'tools.ts'), 'utf8');
    tools = tools.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    expect([...tools.matchAll(/if \(result\.unchanged\) return unchangedReceipt\(/g)],
      'a store that reports a no-op and a tool that ignores it is the defect again').toHaveLength(2);
  });

  it('G2: neither write tool\'s DESCRIPTION moved — the prompt prefix is per-agent static', () => {
    // This lane is per-turn result text by design. If a later change needs a description edit,
    // it is argued and the cache goldens are re-blessed deliberately; this clause is the
    // tripwire that makes that a decision rather than a side effect.
    const src = fs.readFileSync(path.join(CRED_ROOT, 'tools.ts'), 'utf8');
    expect(src, 'the add door\'s description still ends on the same sentence it did pre-t120')
      .toContain('either pick an unused service_name, or pass overwrite=true if the user has genuinely handed you a replacement for that same credential. When in doubt, ask the user first.');
    expect(src, 'and the update door\'s')
      .toContain('use credential_add with a service_name that is not taken.');
  });
});
