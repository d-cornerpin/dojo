// PHASE-5 T10 Step 2 — D1: THE SIGN-IN TOKENS ARE ENCRYPTED WHERE THEY ARE.
//
// THE REQUIREMENT: `google_accounts` and `microsoft_accounts` store their OAuth
// access/refresh tokens as ciphertext, produced by the ONE at-rest implementation
// (`credentials/at-rest.ts`), and every existing plaintext value is converted in
// place without changing what any reader gets back.
//
// THE REFUSALS THIS FILE HOLDS, both permanent (RULING P5-R13; owner decisions D1/D3):
//   * The tokens NEVER move into `agent_credentials`. That store answers by name
//     with no agent predicate, so a platform secret placed there becomes readable
//     by every agent that can call `credential_get`. Encrypting in place is what
//     the owner chose precisely so this stays true.
//   * D1 adds NO agent-reachable read path. The tool layer had zero readers of
//     these columns before the change and has zero after; the dashboard sees a
//     projection with no token field at all.
//
// The behavioural oracle for multi-account routing lives in
// `src/__tests__/multi-account-token-routing.test.ts` and deliberately names no
// storage form — it passes identically either side of this change. THIS file is
// the one that knows about ciphertext.
//
// ⚠ NO TOKEN VALUE IS PRINTED. Fixtures are invented literals; comparisons are
// by value or sha-256 digest.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t10-atrest-test', 'dojo.db'),
  };
});

vi.mock('../../agent/tool-config-generation.js', () => ({
  bumpToolConfigGeneration: vi.fn(),
}));

import { runMigrations } from '../../db/migrations.js';
import { isSealedText, sealSecretColumn, openSecretColumn, sealSecretToText } from '../at-rest.js';
import { insertGoogleAccount, getGoogleAccount, updateGoogleAccount } from '../../google/accounts.js';
import { insertMicrosoftAccount, getMicrosoftAccount } from '../../microsoft/accounts.js';
import { sealWorkspaceTokensAtRest } from '../seal-existing.js';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const AT = 'fixture-access-token-value-A';
const RT = 'fixture-refresh-token-value-B';

/** Read the RAW column, bypassing the module's decode point entirely. */
function raw(table: 'google_accounts' | 'microsoft_accounts', id: string) {
  return mockDb.current!
    .prepare(`SELECT access_token, refresh_token FROM ${table} WHERE id = ?`)
    .get(id) as { access_token: string | null; refresh_token: string | null };
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('PHASE-5 T10 D1 (1): what reaches the disk is ciphertext', () => {
  it('Google — an inserted token is sealed in the column and plain through the seam', () => {
    insertGoogleAccount({ id: 'agent', kind: 'agent', position: 1, connected: true, accessToken: AT, refreshToken: RT });
    const r = raw('google_accounts', 'agent');
    expect(isSealedText(r.access_token)).toBe(true);
    expect(isSealedText(r.refresh_token)).toBe(true);
    expect(r.access_token).not.toContain(AT);
    expect(r.refresh_token).not.toContain(RT);
    const acc = getGoogleAccount('agent')!;
    expect(acc.accessToken).toBe(AT);
    expect(acc.refreshToken).toBe(RT);
  });

  it('Microsoft — the same, through its own seam', () => {
    insertMicrosoftAccount({ id: 'user', kind: 'user', position: 1, connected: true, accessToken: AT, refreshToken: RT });
    const r = raw('microsoft_accounts', 'user');
    expect(isSealedText(r.access_token)).toBe(true);
    expect(isSealedText(r.refresh_token)).toBe(true);
    expect(r.access_token).not.toContain(AT);
    const acc = getMicrosoftAccount('user')!;
    expect(acc.accessToken).toBe(AT);
    expect(acc.refreshToken).toBe(RT);
  });

  it('an UPDATE seals too — the refresh path is not a plaintext back door', () => {
    insertGoogleAccount({ id: 'agent', kind: 'agent', position: 1, connected: true, accessToken: AT, refreshToken: RT });
    const rotated = 'fixture-rotated-access-token';
    updateGoogleAccount('agent', { accessToken: rotated });
    const r = raw('google_accounts', 'agent');
    expect(isSealedText(r.access_token)).toBe(true);
    expect(r.access_token).not.toContain(rotated);
    expect(getGoogleAccount('agent')!.accessToken).toBe(rotated);
  });

  it('two seals of the same value differ — a fresh IV per write, so a rotation is not detectable from the column', () => {
    insertGoogleAccount({ id: 'agent', kind: 'agent', position: 1, accessToken: AT });
    const first = raw('google_accounts', 'agent').access_token;
    updateGoogleAccount('agent', { accessToken: AT });
    const second = raw('google_accounts', 'agent').access_token;
    expect(first).not.toBe(second);
    expect(getGoogleAccount('agent')!.accessToken).toBe(AT);
  });
});

describe('PHASE-5 T10 D1 (2): the states that are NOT secrets survive untouched', () => {
  it('NULL stays NULL and EMPTY stays EMPTY — the reconnect-card predicate is unchanged', () => {
    // migration/checks.ts enumerates reconnect cards with
    //   refresh_token IS NOT NULL AND refresh_token != ''
    // Sealing '' would produce a non-empty envelope and conjure a card.
    insertGoogleAccount({ id: 'agent', kind: 'agent', position: 1, accessToken: null, refreshToken: null });
    insertGoogleAccount({ id: 'empty', kind: 'user', position: 1, accessToken: '', refreshToken: '' });
    insertGoogleAccount({ id: 'real', kind: 'user', position: 2, accessToken: AT, refreshToken: RT });

    expect(raw('google_accounts', 'agent').refresh_token).toBeNull();
    expect(raw('google_accounts', 'empty').refresh_token).toBe('');

    const cards = mockDb.current!
      .prepare("SELECT id FROM google_accounts WHERE refresh_token IS NOT NULL AND refresh_token != '' ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(cards.map(c => c.id)).toEqual(['real']);

    expect(getGoogleAccount('agent')!.refreshToken).toBeNull();
    expect(getGoogleAccount('empty')!.refreshToken).toBe('');
  });

  it('sealSecretColumn is idempotent — an already-sealed value is not nested', () => {
    const once = sealSecretColumn(AT)!;
    expect(sealSecretColumn(once)).toBe(once);
    expect(openSecretColumn(once, 'test')).toBe(AT);
  });

  it('openSecretColumn passes an UNSEALED value through — an unconverted row still works', () => {
    expect(openSecretColumn(AT, 'test')).toBe(AT);
    expect(openSecretColumn(null, 'test')).toBeNull();
    expect(openSecretColumn('', 'test')).toBe('');
  });

  it('a value that will not open DEGRADES to absent instead of taking the process down', () => {
    // A rotated master key looks exactly like this. twilio/auth.ts set the
    // precedent: log it, behave as not-configured, let the owner reconnect.
    const sealed = sealSecretToText(AT);
    const tampered = sealed.slice(0, -4) + 'AAAA';
    expect(() => openSecretColumn(tampered, 'test')).not.toThrow();
    expect(openSecretColumn(tampered, 'test')).toBeNull();
  });
});

describe('PHASE-5 T10 D1 (3): the in-place conversion of rows that already exist', () => {
  /** Write plaintext straight into the column, i.e. a pre-change row. */
  function plantPlaintext(table: 'google_accounts' | 'microsoft_accounts', id: string): void {
    mockDb.current!
      .prepare(`UPDATE ${table} SET access_token = ?, refresh_token = ? WHERE id = ?`)
      .run(AT, RT, id);
  }

  it('converts every plaintext column, preserves every value, and is idempotent', async () => {
    insertGoogleAccount({ id: 'agent', kind: 'agent', position: 1, connected: true, accessToken: AT, refreshToken: RT });
    insertGoogleAccount({ id: 'user', kind: 'user', position: 1, connected: true, accessToken: AT, refreshToken: RT });
    plantPlaintext('google_accounts', 'agent');
    plantPlaintext('google_accounts', 'user');
    expect(isSealedText(raw('google_accounts', 'agent').access_token)).toBe(false);

    // 4 columns across 2 rows — the unit is COLUMNS.
    expect(await sealWorkspaceTokensAtRest()).toBe(4);
    for (const id of ['agent', 'user']) {
      const r = raw('google_accounts', id);
      expect(isSealedText(r.access_token)).toBe(true);
      expect(isSealedText(r.refresh_token)).toBe(true);
      expect(getGoogleAccount(id)!.accessToken).toBe(AT);
      expect(getGoogleAccount(id)!.refreshToken).toBe(RT);
    }
    // Second run converts nothing — it is safe on every boot.
    expect(await sealWorkspaceTokensAtRest()).toBe(0);
  });

  it('converts a MIXED body: one plaintext column, one already sealed, one NULL', async () => {
    insertGoogleAccount({ id: 'agent', kind: 'agent', position: 1, accessToken: AT, refreshToken: RT });
    // access_token back to plaintext; refresh_token left sealed.
    mockDb.current!.prepare('UPDATE google_accounts SET access_token = ? WHERE id = ?').run(AT, 'agent');
    insertGoogleAccount({ id: 'empty', kind: 'user', position: 1, accessToken: null, refreshToken: null });

    expect(await sealWorkspaceTokensAtRest()).toBe(1); // exactly the one plaintext column
    expect(isSealedText(raw('google_accounts', 'agent').access_token)).toBe(true);
    expect(getGoogleAccount('agent')!.accessToken).toBe(AT);
    expect(getGoogleAccount('agent')!.refreshToken).toBe(RT);
    expect(raw('google_accounts', 'empty').access_token).toBeNull();
  });

  it('spans BOTH tables in one pass, and touches only the plaintext one', async () => {
    insertGoogleAccount({ id: 'agent', kind: 'agent', position: 1, accessToken: AT, refreshToken: RT });
    insertMicrosoftAccount({ id: 'agent', kind: 'agent', position: 1, accessToken: AT, refreshToken: RT });
    const googleSealedBefore = raw('google_accounts', 'agent').access_token;
    plantPlaintext('microsoft_accounts', 'agent');

    // Google was already sealed by its INSERT, so only Microsoft's 2 convert.
    expect(await sealWorkspaceTokensAtRest()).toBe(2);
    expect(getMicrosoftAccount('agent')!.accessToken).toBe(AT);
    expect(getMicrosoftAccount('agent')!.refreshToken).toBe(RT);
    // The already-sealed table was not rewritten — not even to a fresh IV.
    expect(raw('google_accounts', 'agent').access_token).toBe(googleSealedBefore);
    expect(getGoogleAccount('agent')!.accessToken).toBe(AT);
  });

  it('the conversion leaves every non-token column of the row alone', async () => {
    insertGoogleAccount({
      id: 'agent', kind: 'agent', position: 1, email: 'someone@example.test',
      connected: true, watchEmail: true, sendEmail: true,
      accessToken: AT, refreshToken: RT, tokenExpiresAt: 1234567890, grantedScopes: 'a b c',
    });
    plantPlaintext('google_accounts', 'agent');
    const before = mockDb.current!
      .prepare('SELECT id, kind, position, email, enabled, connected, token_expires_at, granted_scopes, enabled_services, watch_email, send_email, last_verified_at FROM google_accounts WHERE id = ?')
      .get('agent');
    await sealWorkspaceTokensAtRest();
    const after = mockDb.current!
      .prepare('SELECT id, kind, position, email, enabled, connected, token_expires_at, granted_scopes, enabled_services, watch_email, send_email, last_verified_at FROM google_accounts WHERE id = ?')
      .get('agent');
    expect(after).toEqual(before);
  });
});

describe('PHASE-5 T10 D1 (4): the refusals, held as a census over the source', () => {
  /** Every non-test .ts file under packages/server/src. */
  function sourceFiles(): string[] {
    const out: string[] = [];
    (function walk(dir: string) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'node_modules') continue;
          walk(p);
        } else if (e.name.endsWith('.ts')) out.push(p);
      }
    })(SRC);
    return out;
  }
  const rel = (p: string) => path.relative(SRC, p);

  it('REFUSAL (P5-R13, permanent): no path writes a Workspace token into agent_credentials', () => {
    // The store's own writer is credentials/store.ts. Nothing in the provider
    // modules may reach it — if it ever does, the tokens have become readable by
    // every agent that can name them, which is the exact regression the owner's
    // decision D1 exists to avoid.
    const offenders = sourceFiles()
      .filter(f => /^(google|microsoft)\//.test(rel(f)))
      .filter(f => /credentials\/store|agent_credentials/.test(fs.readFileSync(f, 'utf-8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('REFUSAL: the tool layer still has ZERO readers of the token columns', () => {
    // The fact D1 rests on, re-measured rather than inherited: the agent-facing
    // tool surface names neither column nor either domain field.
    const offenders = sourceFiles()
      .filter(f => rel(f).startsWith('agent/'))
      .filter(f => /\b(?:access_token|refresh_token|accessToken|refreshToken)\b/.test(fs.readFileSync(f, 'utf-8')))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it('the token columns stay inside the modules that own them', () => {
    // Five files may name them, each for a stated reason:
    //   google/accounts.ts, microsoft/accounts.ts  — the storage owners (seam)
    //   google/auth.ts, microsoft/auth.ts          — OAuth wire fields + domain object
    //   migration/checks.ts                        — the reconnect-card PREDICATE;
    //     it reads no token, but it runs SQL on the column, so any change to how
    //     the column is stored has to answer for it (it still does: a sealed value
    //     is non-empty, an empty one stays empty).
    // google/reauth-notice.ts reads the DOMAIN field only, never the column.
    const allowed = new Set([
      'google/accounts.ts', 'microsoft/accounts.ts',
      'google/auth.ts', 'microsoft/auth.ts',
      'migration/checks.ts', 'google/reauth-notice.ts',
      'credentials/at-rest.ts', 'credentials/seal-existing.ts',
    ]);
    const namers = sourceFiles()
      .filter(f => /\b(?:access_token|refresh_token|accessToken|refreshToken)\b/.test(fs.readFileSync(f, 'utf-8')))
      .map(rel)
      .filter(f => !allowed.has(f));
    expect(namers).toEqual([]);
  });

  it('the dashboard-facing account projections carry no token field at all', () => {
    for (const f of ['google/auth.ts', 'microsoft/auth.ts']) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf-8');
      const view = text.match(/export interface (?:Google|Microsoft)AccountView \{[\s\S]*?\n\}/);
      expect(view, `${f} must declare an account view`).not.toBeNull();
      expect(view![0]).not.toMatch(/[Tt]oken/);
    }
  });

  it('there is still exactly ONE AES implementation, and the envelope is part of it', () => {
    const impls = sourceFiles()
      .filter(f => /createCipheriv\(/.test(fs.readFileSync(f, 'utf-8')))
      .map(rel)
      .filter(f => f !== 'migration/export.ts'); // declared exception: user-password AES-256-CBC
    expect(impls).toEqual(['credentials/at-rest.ts']);
    // And the providers hold no crypto of their own.
    for (const f of ['google/accounts.ts', 'microsoft/accounts.ts']) {
      expect(fs.readFileSync(path.join(SRC, f), 'utf-8')).not.toMatch(/createCipheriv|createDecipheriv/);
    }
  });
});
