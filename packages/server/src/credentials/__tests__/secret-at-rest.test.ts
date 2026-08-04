// PHASE-5 T6C — ONE OWNER for secret-at-rest encryption, and the boundary that
// says which secrets may live in the agent-reachable store.
//
// THIS FILE HOLDS FOUR REQUIREMENTS, each as a check over the SOURCE rather
// than a sentence in a report:
//
//  (1) There is exactly ONE implementation of "encrypt a secret at rest". Two
//      byte-identical AES-256-GCM pairs existed before this task — one in
//      `credentials/store.ts`, one in `twilio/auth.ts` — and the second said so
//      in its own header. A third copy appearing later fails clause 3 by name.
//
//  (2) A PLATFORM secret does not move into `agent_credentials`. That table is
//      reachable by every agent: `credential_list` enumerates every row's name
//      and `credential_get` returns any row's decrypted payload, with no gate
//      and no per-agent scoping. Anything the platform holds and encrypts
//      belongs in its own table (the way `twilio_config` does), so the importer
//      set of the agent-facing store is pinned and a new importer has to argue
//      with clause 5.
//
//  (3) RECORDED BEHAVIOUR, not a new refusal (RULING P5-R5): today, any agent
//      can read any row of `agent_credentials` by name. Clause 6 asserts that
//      as an ALLOW with its reason, because changing it would be a NEW REFUSAL
//      on something that works today — the owner's decision, never a worker's.
//      If the owner decides to scope it, clause 6 is meant to be flipped
//      deliberately and visibly, not quietly deleted.
//
//  (4) The set of columns that hold a credential IN THE CLEAR is enumerated and
//      pinned, and the code that touches the live ones is a named seam rather
//      than a scatter. T6C measured that set instead of moving it; pinning it
//      is what stops the measurement going stale the moment someone adds a
//      column, and what keeps the future encryption a small change.
//
// No real secret value appears here. Every value in this file is a literal this
// file made up.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gatesForCall } from '../../agent/tools/gates.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Every non-test .ts file under packages/server/src. */
function sourceFiles(): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__tests__' || e.name === 'node_modules') continue;
        walk(p);
      } else if (e.name.endsWith('.ts')) {
        out.push(p);
      }
    }
  })(SRC);
  return out;
}

const rel = (p: string) => path.relative(SRC, p);

describe('PHASE-5 T6C (1): one owner for secret-at-rest encryption', () => {
  it('round-trips a value through the shared module', async () => {
    const { sealSecret, openSecret } = await import('../at-rest.js');
    const plaintext = JSON.stringify({ api_key: 'fixture-value-not-a-real-key' });
    const sealed = sealSecret(plaintext);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.ciphertext.equals(Buffer.from(plaintext, 'utf8'))).toBe(false);
    expect(openSecret(sealed.ciphertext, sealed.iv, sealed.authTag)).toBe(plaintext);
  });

  it('refuses a tampered value instead of returning it — the auth tag is load-bearing', async () => {
    const { sealSecret, openSecret } = await import('../at-rest.js');
    const sealed = sealSecret('fixture-value');
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] ^= 0xff;
    expect(() => openSecret(tampered, sealed.iv, sealed.authTag)).toThrow();

    const wrongTag = Buffer.from(sealed.authTag);
    wrongTag[0] ^= 0xff;
    expect(() => openSecret(sealed.ciphertext, sealed.iv, wrongTag)).toThrow();
  });

  it('uses a fresh IV per call — a repeated IV under one key is the classic GCM break', async () => {
    const { sealSecret } = await import('../at-rest.js');
    const ivs = new Set(Array.from({ length: 16 }, () => sealSecret('same-input').iv.toString('hex')));
    expect(ivs.size).toBe(16);
  });

  it('is the ONLY AES-256-GCM implementation in the server source', () => {
    // The declared exception, with its reason: the migration package is
    // encrypted with AES-256-CBC under a key derived from the USER'S password,
    // because it travels to a machine where the master key does not exist.
    // Different key, different threat, different owner — recorded here so the
    // non-fold is a decision rather than an oversight.
    const CBC_MIGRATION_PACKAGE = ['migration/export.ts', 'migration/import.ts'];

    const gcm: string[] = [];
    const other: string[] = [];
    for (const f of sourceFiles()) {
      const text = fs.readFileSync(f, 'utf-8');
      if (!/create(?:C|Dec)ipheriv\s*\(/.test(text)) continue;
      (/aes-256-gcm/.test(text) ? gcm : other).push(rel(f));
    }

    expect(gcm).toEqual(['credentials/at-rest.ts']);
    expect(other.sort()).toEqual(CBC_MIGRATION_PACKAGE.sort());
  });

  it('leaves both former owners as readers — neither constructs a cipher any more', () => {
    for (const f of ['credentials/store.ts', 'twilio/auth.ts']) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf-8');
      expect(text).not.toMatch(/create(?:C|Dec)ipheriv\s*\(/);
      expect(text).toMatch(/from '(?:\.|\.\.)\/(?:credentials\/)?at-rest\.js'/);
    }
  });
});

describe('PHASE-5 T6C (2): a platform secret does not move into the agent-reachable store', () => {
  it('pins every importer of the agent-facing credential store, each with a reason', () => {
    // The requirement: a module that holds a PLATFORM secret must not read it
    // out of `agent_credentials`, because every agent can read that table by
    // name (clause 6). A new importer here is not automatically wrong — it just
    // has to be a deliberate answer to "may every agent read this?".
    const DECLARED: Record<string, string> = {
      'credentials/tools.ts': 'the agent-facing tools themselves — this IS the agent surface',
      'gateway/routes/credentials.ts': 'the dashboard panel the owner manages his own credentials from',
      'screen-share/manager.ts': 'the saved VNC password, stored on the user\'s explicit opt-in',
    };

    // A file imports the store either by its full path from elsewhere, or as
    // `./store.js` from inside `credentials/` — resolve both, so a sibling
    // cannot slip in under the short form. (`memory/`, `vault/`, `work/` and
    // others have their own `store.js`; the directory check is what keeps them
    // out without a hand-maintained exclusion list.)
    const importers = sourceFiles()
      .filter((f) => {
        const text = fs.readFileSync(f, 'utf-8');
        if (/from '[^']*\/credentials\/store\.js'/.test(text)) return true;
        return path.dirname(rel(f)) === 'credentials' && /from '\.\/store\.js'/.test(text);
      })
      .map(rel)
      .filter(f => f !== 'credentials/store.ts')
      .sort();

    expect(importers).toEqual(Object.keys(DECLARED).sort());
  });

  it('keeps the platform secrets loader out of the agent-reachable store', () => {
    // `config/loader.ts` is the accessor every platform provider credential and
    // the search key come through. If it ever reads `agent_credentials`, those
    // secrets become fetchable by every agent through `credential_get` — which
    // is the measured reason PHASE-5 T6C refused to move them there.
    const loader = fs.readFileSync(path.join(SRC, 'config/loader.ts'), 'utf-8');
    expect(loader).not.toMatch(/from '[^']*credentials\/store\.js'/);
    expect(loader).not.toMatch(/(?:FROM|INTO|UPDATE)\s+agent_credentials/i);
  });
});

describe('PHASE-5 T6C (3): RECORDED BEHAVIOUR — the agent credential store is ungated today', () => {
  // These clauses assert what the platform DOES, not what it should do. They
  // exist so the fact is measured rather than assumed, and so that a decision
  // to change it is taken deliberately. OWNER: whether reads of the agent
  // credential store should be scoped to the agent that stored them.

  it('no gate row names any credential tool — every agent may call all five', () => {
    for (const name of ['credential_list', 'credential_get', 'credential_add', 'credential_update', 'credential_delete']) {
      expect(gatesForCall(name, { service_name: 'anything' })).toEqual([]);
    }
  });

  it('the credential tools reach every agent unconditionally', () => {
    // Read from the surface's own source: the push sits in the function body at
    // two-space indentation, i.e. NOT inside a connected-provider condition the
    // way the Google/Microsoft/Plaud blocks are. If this clause fails because
    // the line moved deeper, someone put the store behind a condition — read
    // clause 6 again before re-indenting anything.
    const surface = fs.readFileSync(path.join(SRC, 'agent/tools/surface.ts'), 'utf-8');
    expect(surface).toMatch(/^ {2}filtered\.push\(\.\.\.credentialsToolDefinitions\);$/m);
  });

  it('a stored row is addressed by name alone — nothing in the read path compares owners', async () => {
    // The store's read signature takes the accessing agent for BOOKKEEPING
    // (last_accessed_by / access_count), not for authorisation. Asserted on the
    // source so that adding an ownership check has to come here and say so.
    const store = fs.readFileSync(path.join(SRC, 'credentials/store.ts'), 'utf-8');
    expect(store).toMatch(/SET last_accessed_at = datetime\('now'\),\s*\n\s*last_accessed_by_agent_id = \?/);
    expect(store).not.toMatch(/WHERE service_name = \? AND created_by_agent_id/);
  });

  it('the master key is not reachable through the store it unlocks (the structural refusal, held)', async () => {
    // Moving `credential_master_key` into `agent_credentials` would mean
    // encrypting the key with itself. This clause holds the shape that makes it
    // impossible to do by accident: the at-rest module reads the key from the
    // loader, and the loader reads it from the file — never from the store.
    const atRest = fs.readFileSync(path.join(SRC, 'credentials/at-rest.ts'), 'utf-8');
    expect(atRest).toMatch(/getCredentialMasterKey.*from '\.\.\/config\/loader\.js'/s);
    expect(atRest).not.toMatch(/from '[^']*credentials\/store\.js'/);
    expect(atRest).not.toMatch(/(?:FROM|INTO|UPDATE)\s+agent_credentials/i);
  });
});

describe('PHASE-5 T6C (4): the plaintext-credential surface is enumerated, pinned, and seamed', () => {
  // Derived at this HEAD by:
  //   grep -inE '^\s*[a-z_]*(token|secret|password|api_key|credential)[a-z_]*\s+TEXT' \
  //     packages/server/src/db/migrations/*.sql
  // UNIT: column DECLARATIONS in the migration chain (a table declared once and
  // dropped later still has its declaration here — the disposition says so,
  // which is why this is drop-proof and a live-schema snapshot would not be).
  //
  // Every entry carries a disposition. A new credential-shaped TEXT column
  // fails this clause until it declares which of the three it is.
  const DECLARED_PLAINTEXT_SURFACE: Record<string, string> = {
    // SEALED AT REST — the real OAuth material. T6C measured these and left them
    // in the clear, handing the decision up; the owner took it (decision D1) and
    // PHASE-5 T10 encrypted them IN PLACE, through the one at-rest owner, without
    // moving them into `agent_credentials` (RULING P5-R13 — that refusal is
    // permanent). The disposition changed here in the same commit as the code.
    // The clauses that hold it: `credentials/__tests__/token-at-rest.test.ts`.
    '071_workspace_accounts.sql:access_token': 'SEALED AT REST (T10/D1) — google_accounts + microsoft_accounts OAuth access tokens',
    '071_workspace_accounts.sql:refresh_token': 'SEALED AT REST (T10/D1) — google_accounts + microsoft_accounts OAuth refresh tokens',
    // NOT A CREDENTIAL — one-shot nonces bound to a single held call. They
    // authorise one action on this box; they authenticate to nothing.
    '069_destructive_approvals.sql:token': 'NOT A CREDENTIAL — one-shot approval nonce bound to a specific held call',
    // DROPPED — the table these belonged to is gone (migration 133). Kept in
    // this list so the scan stays honest instead of being scoped around them.
    '006_phase5.sql:token': 'DROPPED — `sessions` was removed by migration 133',
    '006_phase5.sql:csrf_token': 'DROPPED — `sessions` was removed by migration 133',
  };

  it('pins every credential-shaped TEXT column the migration chain declares', () => {
    const dir = path.join(SRC, 'db/migrations');
    const found = new Set<string>();
    for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.sql'))) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf-8').split('\n')) {
        const m = /^\s*([a-z_]*(?:token|secret|password|api_key|credential)[a-z_]*)\s+TEXT/i.exec(line);
        if (m) found.add(`${f}:${m[1]}`);
      }
    }
    expect([...found].sort()).toEqual(Object.keys(DECLARED_PLAINTEXT_SURFACE).sort());
  });

  it('keeps the live plaintext columns behind ONE read seam per provider', () => {
    // Every read of a token column funnels through the provider's row mapper,
    // and the writes are the INSERT column list and the partial-update column
    // map. That is what makes encrypting them later a small change instead of a
    // hunt — and what this clause exists to keep true. Asserted structurally,
    // not by an occurrence count: a count would move for reasons that do not
    // matter and would teach the next reader to re-pin it without looking.
    for (const file of ['google/accounts.ts', 'microsoft/accounts.ts']) {
      const text = fs.readFileSync(path.join(SRC, file), 'utf-8');
      const lines = text.split('\n');

      // ONE decode point: the row mapper, both fields, nowhere else — and since
      // T10/D1 the mapper OPENS the value rather than passing the column through.
      // The clause moved with the code and got STRICTER: it is no longer enough
      // for the two fields to come from the two columns, they must come through
      // the one at-rest owner.
      const decode = lines.filter(l => /(?:accessToken|refreshToken):\s*openSecretColumn\(r\.(?:access|refresh)_token/.test(l));
      expect(decode).toHaveLength(2);
      expect(text).toMatch(/function rowToAccount\(/);
      // A raw pass-through of either column would be an unencrypted read path.
      expect(lines.filter(l => /(?:accessToken|refreshToken):\s*r\.(?:access|refresh)_token/.test(l))).toHaveLength(0);

      // TWO write points, and both are declarations rather than statements. Both
      // SEAL since T10/D1 — a write that skipped the seal would put plaintext
      // back on the disk, so the encode side is pinned the same way.
      expect(text).toMatch(/INSERT INTO (?:google|microsoft)_accounts[\s\S]{0,400}access_token, refresh_token/);
      expect(text).toMatch(/sealSecretColumn\(acc\.accessToken \?\? null\), sealSecretColumn\(acc\.refreshToken \?\? null\),/);
      expect(text).toMatch(/accessToken: 'access_token', refreshToken: 'refresh_token',/);
      expect(text).toMatch(/accessToken: v => sealSecretColumn\(v as string \| null\),/);
      expect(text).toMatch(/refreshToken: v => sealSecretColumn\(v as string \| null\),/);

      // No ad-hoc UPDATE of a token column anywhere in the file.
      expect(text).not.toMatch(/SET\s+(?:access_token|refresh_token)\s*=/);
    }
  });

  it('keeps the token COLUMNS out of every module but the four that own them', () => {
    // #15's shape: the claim is not "grep found nothing". It is a positive
    // enumeration, and writing it down as four was wrong until this clause
    // measured five. The set, each with what it does:
    //   google/accounts.ts, microsoft/accounts.ts — the row mappers (decode)
    //     and the two write points. The seam the clause above pins.
    //   google/auth.ts, microsoft/auth.ts — the OAuth exchanges, where the
    //     names are fields of the PROVIDER'S JSON response, not SQL.
    //   migration/checks.ts — a PREDICATE, not a value read: it enumerates
    //     reconnect cards by `refresh_token IS NOT NULL AND != ''`. It reads no
    //     token, but it is the one place outside the mappers that runs SQL
    //     against these columns, so encrypting them later has to answer for it.
    //     T10/D1 DID answer for it: a sealed value is non-empty and an empty one
    //     is left empty, so the predicate selects exactly the rows it did before
    //     (`token-at-rest.test.ts` drives that on a three-row body).
    //   credentials/seal-existing.ts — ADDED BY T10/D1. The one-owner conversion
    //     pass. It SELECTs the two columns to find the ones still in the clear,
    //     and hands what it finds to each provider's own update function — it
    //     never writes a token column itself, which is why the two write points
    //     pinned above are still two.
    //   credentials/at-rest.ts — ADDED BY T10/D1. It names the columns only in
    //     the header prose that explains why the sealed triple is serialised into
    //     one TEXT field instead of the three columns twilio_config got. It runs
    //     no SQL. It is in the list because this clause keys on the NAMES, and
    //     scoping it out by directory is exactly the heuristic the phase refuses.
    // Eight further files name the account TABLES (counts, existence checks)
    // and touch no token — which is why this clause keys on the COLUMNS.
    const namers = sourceFiles()
      .filter(f => /\b(?:access_token|refresh_token)\b/.test(fs.readFileSync(f, 'utf-8')))
      .map(rel)
      .sort();
    expect(namers).toEqual([
      'credentials/at-rest.ts',
      'credentials/seal-existing.ts',
      'google/accounts.ts',
      'google/auth.ts',
      'microsoft/accounts.ts',
      'microsoft/auth.ts',
      'migration/checks.ts',
    ]);
  });
});
