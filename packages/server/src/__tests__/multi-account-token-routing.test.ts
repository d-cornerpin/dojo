// PHASE-5 T10 Step 1 — THE CAPABILITY ORACLE FOR D1.
//
// THE REQUIREMENT THIS HOLDS: multi-account routing for BOTH kinds of BOTH
// providers. A token read for one account is that account's OWN token, resolved
// through the real read paths the mail/calendar clients use — never the primary's,
// never another kind's, never another position's.
//
// WHY IT EXISTS AS A TEST AND NOT AS A PARAGRAPH. D1 puts the OAuth tokens behind
// at-rest encryption in the columns where they already live. Every read of a token
// in this tree passes through ONE decode point per provider (`rowToAccount`) and
// every write through two encode points (the INSERT column list and the UPDATABLE
// encoder map), so a defect in the seal/open pair does not announce itself with a
// type error — it announces itself as the owner's Gmail silently answering with the
// wrong mailbox, or with nothing. These clauses are written to pass IDENTICALLY
// before and after the conversion: they are the oracle, so they name behaviour
// (which account answers, and with whose token) and never the storage form.
//
// ⚠ NO TOKEN VALUE IS EVER PRINTED. The fixtures are literals invented here, and
// the assertions compare values and sha-256 digests — never a `console.log`, never
// an error message carrying a value. The real accounts on a live box hold LIVE
// sign-ins; the habit is the point.
//
// Coverage, per provider (Google and Microsoft), 4 accounts in play each run:
//   * agent-kind position 1 and user-kind position 1  — "both accounts"
//   * a SECOND agent-kind account at position 2       — routing past the primary
//   * resolution by kind, by email, and the read-side resolver's labelAccount rule
//   * the token actually handed to the client layer (`getValidAccessTokenForAccount`)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-t10-routing-test', 'dojo.db'),
  };
});

vi.mock('../agent/tool-config-generation.js', () => ({
  bumpToolConfigGeneration: vi.fn(),
}));

import { runMigrations } from '../db/migrations.js';
import {
  insertGoogleAccount, getGoogleAccount, listGoogleAccounts, updateGoogleAccount,
  getPrimaryGoogleAccount, resolveGoogleAccountForTool, resolveGoogleAccountForRead,
} from '../google/accounts.js';
import {
  insertMicrosoftAccount, getMicrosoftAccount, listMicrosoftAccounts, updateMicrosoftAccount,
  getPrimaryMicrosoftAccount, resolveMicrosoftAccountForTool, resolveMicrosoftAccountForRead,
} from '../microsoft/accounts.js';
import { getValidAccessTokenForAccount as googleTokenFor } from '../google/auth.js';
import { getValidAccessTokenForAccount as msTokenFor } from '../microsoft/auth.js';

/** Digest, never the value — the habit this whole task is written around. */
const digest = (s: string | null): string =>
  s === null ? 'NULL' : crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

/** Far enough ahead that the 5-minute refresh buffer never fires, so the token
 *  path is exercised without a network call. */
const FAR_FUTURE = () => Date.now() + 3600_000;

// Invented fixtures. Deliberately shaped like nothing any provider issues.
const FIX = {
  gAgent: { at: 'fixture-google-agent-access-0001', rt: 'fixture-google-agent-refresh-0001', email: 'agent-one@example.test' },
  gUser: { at: 'fixture-google-user-access-0002', rt: 'fixture-google-user-refresh-0002', email: 'user-one@example.test' },
  gAgent2: { at: 'fixture-google-agent2-access-0003', rt: 'fixture-google-agent2-refresh-0003', email: 'agent-two@example.test' },
  mAgent: { at: 'fixture-ms-agent-access-0004', rt: 'fixture-ms-agent-refresh-0004', email: 'ms-agent-one@example.test' },
  mUser: { at: 'fixture-ms-user-access-0005', rt: 'fixture-ms-user-refresh-0005', email: 'ms-user-one@example.test' },
  mAgent2: { at: 'fixture-ms-agent2-access-0006', rt: 'fixture-ms-agent2-refresh-0006', email: 'ms-agent-two@example.test' },
};

function seedAllFour(): void {
  insertGoogleAccount({
    id: 'agent', kind: 'agent', position: 1, email: FIX.gAgent.email, connected: true,
    accessToken: FIX.gAgent.at, refreshToken: FIX.gAgent.rt, tokenExpiresAt: FAR_FUTURE(),
  });
  insertGoogleAccount({
    id: 'user', kind: 'user', position: 1, email: FIX.gUser.email, connected: true,
    accessToken: FIX.gUser.at, refreshToken: FIX.gUser.rt, tokenExpiresAt: FAR_FUTURE(),
  });
  insertGoogleAccount({
    id: 'g-agent-2', kind: 'agent', position: 2, email: FIX.gAgent2.email, connected: true,
    accessToken: FIX.gAgent2.at, refreshToken: FIX.gAgent2.rt, tokenExpiresAt: FAR_FUTURE(),
  });
  insertMicrosoftAccount({
    id: 'agent', kind: 'agent', position: 1, email: FIX.mAgent.email, connected: true,
    accessToken: FIX.mAgent.at, refreshToken: FIX.mAgent.rt, tokenExpiresAt: FAR_FUTURE(),
  });
  insertMicrosoftAccount({
    id: 'user', kind: 'user', position: 1, email: FIX.mUser.email, connected: true,
    accessToken: FIX.mUser.at, refreshToken: FIX.mUser.rt, tokenExpiresAt: FAR_FUTURE(),
  });
  insertMicrosoftAccount({
    id: 'm-agent-2', kind: 'agent', position: 2, email: FIX.mAgent2.email, connected: true,
    accessToken: FIX.mAgent2.at, refreshToken: FIX.mAgent2.rt, tokenExpiresAt: FAR_FUTURE(),
  });
}

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedAllFour();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('PHASE-5 T10 (1): every account hands back ITS OWN token — Google', () => {
  it('routes by id: three accounts, three distinct tokens, each its own', async () => {
    const cases: Array<[string, { at: string; rt: string }]> = [
      ['agent', FIX.gAgent], ['user', FIX.gUser], ['g-agent-2', FIX.gAgent2],
    ];
    for (const [id, fx] of cases) {
      const acc = getGoogleAccount(id);
      expect(acc, `account ${id} must exist`).not.toBeNull();
      expect(digest(acc!.accessToken)).toBe(digest(fx.at));
      expect(digest(acc!.refreshToken)).toBe(digest(fx.rt));
    }
    // Cross-account distinctness: no two accounts answer with the same material.
    const digests = cases.map(([id]) => digest(getGoogleAccount(id)!.accessToken));
    expect(new Set(digests).size).toBe(3);
  });

  it('routes by KIND: the primary of each kind is that kind\'s position-1 account', () => {
    expect(getPrimaryGoogleAccount('agent')!.id).toBe('agent');
    expect(getPrimaryGoogleAccount('user')!.id).toBe('user');
    expect(digest(getPrimaryGoogleAccount('agent')!.accessToken)).toBe(digest(FIX.gAgent.at));
    expect(digest(getPrimaryGoogleAccount('user')!.accessToken)).toBe(digest(FIX.gUser.at));
  });

  it('routes by EMAIL through the tool-facing resolver, past the primary', () => {
    const r = resolveGoogleAccountForTool('agent', FIX.gAgent2.email);
    expect('account' in r).toBe(true);
    if ('account' in r) {
      expect(r.account.id).toBe('g-agent-2');
      expect(digest(r.account.accessToken)).toBe(digest(FIX.gAgent2.at));
    }
    const u = resolveGoogleAccountForTool('user', FIX.gUser.email);
    expect('account' in u).toBe(true);
    if ('account' in u) expect(digest(u.account.accessToken)).toBe(digest(FIX.gUser.at));
  });

  it('the READ resolver defaults to the primary and labels when a kind has more than one', () => {
    const r = resolveGoogleAccountForRead('agent');
    expect('account' in r).toBe(true);
    if ('account' in r) {
      expect(r.account.id).toBe('agent');
      expect(r.labelAccount).toBe(true); // two connected agent accounts
      expect(digest(r.account.accessToken)).toBe(digest(FIX.gAgent.at));
    }
    const u = resolveGoogleAccountForRead('user');
    expect('account' in u).toBe(true);
    if ('account' in u) {
      expect(u.labelAccount).toBe(false); // one connected user account
      expect(digest(u.account.accessToken)).toBe(digest(FIX.gUser.at));
    }
  });

  it('hands the CLIENT LAYER each account\'s own access token (the real read path)', async () => {
    expect(digest(await googleTokenFor('agent'))).toBe(digest(FIX.gAgent.at));
    expect(digest(await googleTokenFor('user'))).toBe(digest(FIX.gUser.at));
    expect(digest(await googleTokenFor('g-agent-2'))).toBe(digest(FIX.gAgent2.at));
  });

  it('a token UPDATE lands on one account and leaves the others untouched', async () => {
    const replacement = 'fixture-google-agent-access-ROTATED';
    updateGoogleAccount('agent', { accessToken: replacement });
    expect(digest(await googleTokenFor('agent'))).toBe(digest(replacement));
    expect(digest(await googleTokenFor('user'))).toBe(digest(FIX.gUser.at));
    expect(digest(await googleTokenFor('g-agent-2'))).toBe(digest(FIX.gAgent2.at));
    // The refresh token of the patched row is untouched (the ONE PATCH RULE).
    expect(digest(getGoogleAccount('agent')!.refreshToken)).toBe(digest(FIX.gAgent.rt));
    // And the email survives the patch.
    expect(getGoogleAccount('agent')!.email).toBe(FIX.gAgent.email);
  });

  it('a NULL token clears, and an absent key leaves the column alone', () => {
    updateGoogleAccount('user', { accessToken: null });
    expect(getGoogleAccount('user')!.accessToken).toBeNull();
    expect(digest(getGoogleAccount('user')!.refreshToken)).toBe(digest(FIX.gUser.rt));
    updateGoogleAccount('user', { email: 'renamed@example.test' });
    expect(getGoogleAccount('user')!.accessToken).toBeNull();
    expect(digest(getGoogleAccount('user')!.refreshToken)).toBe(digest(FIX.gUser.rt));
  });

  it('listing a kind returns that kind only, each carrying its own material', () => {
    const agents = listGoogleAccounts('agent');
    expect(agents.map(a => a.id)).toEqual(['agent', 'g-agent-2']);
    expect(agents.map(a => digest(a.accessToken)))
      .toEqual([digest(FIX.gAgent.at), digest(FIX.gAgent2.at)]);
    const users = listGoogleAccounts('user');
    expect(users.map(a => a.id)).toEqual(['user']);
  });
});

describe('PHASE-5 T10 (2): every account hands back ITS OWN token — Microsoft', () => {
  it('routes by id: three accounts, three distinct tokens, each its own', () => {
    const cases: Array<[string, { at: string; rt: string }]> = [
      ['agent', FIX.mAgent], ['user', FIX.mUser], ['m-agent-2', FIX.mAgent2],
    ];
    for (const [id, fx] of cases) {
      const acc = getMicrosoftAccount(id);
      expect(acc, `account ${id} must exist`).not.toBeNull();
      expect(digest(acc!.accessToken)).toBe(digest(fx.at));
      expect(digest(acc!.refreshToken)).toBe(digest(fx.rt));
    }
    const digests = cases.map(([id]) => digest(getMicrosoftAccount(id)!.accessToken));
    expect(new Set(digests).size).toBe(3);
  });

  it('routes by KIND: the primary of each kind is that kind\'s position-1 account', () => {
    expect(getPrimaryMicrosoftAccount('agent')!.id).toBe('agent');
    expect(getPrimaryMicrosoftAccount('user')!.id).toBe('user');
    expect(digest(getPrimaryMicrosoftAccount('agent')!.accessToken)).toBe(digest(FIX.mAgent.at));
    expect(digest(getPrimaryMicrosoftAccount('user')!.accessToken)).toBe(digest(FIX.mUser.at));
  });

  it('routes by EMAIL through the tool-facing resolver, past the primary', () => {
    const r = resolveMicrosoftAccountForTool('agent', FIX.mAgent2.email);
    expect('account' in r).toBe(true);
    if ('account' in r) {
      expect(r.account.id).toBe('m-agent-2');
      expect(digest(r.account.accessToken)).toBe(digest(FIX.mAgent2.at));
    }
  });

  it('the READ resolver defaults to the primary and labels when a kind has more than one', () => {
    const r = resolveMicrosoftAccountForRead('agent');
    expect('account' in r).toBe(true);
    if ('account' in r) {
      expect(r.account.id).toBe('agent');
      expect(r.labelAccount).toBe(true);
      expect(digest(r.account.accessToken)).toBe(digest(FIX.mAgent.at));
    }
    const u = resolveMicrosoftAccountForRead('user');
    if ('account' in u) {
      expect(u.labelAccount).toBe(false);
      expect(digest(u.account.accessToken)).toBe(digest(FIX.mUser.at));
    }
  });

  it('hands the CLIENT LAYER each account\'s own access token (the real read path)', async () => {
    expect(digest(await msTokenFor('agent'))).toBe(digest(FIX.mAgent.at));
    expect(digest(await msTokenFor('user'))).toBe(digest(FIX.mUser.at));
    expect(digest(await msTokenFor('m-agent-2'))).toBe(digest(FIX.mAgent2.at));
  });

  it('a token UPDATE lands on one account and leaves the others untouched', async () => {
    const replacement = 'fixture-ms-user-access-ROTATED';
    updateMicrosoftAccount('user', { accessToken: replacement });
    expect(digest(await msTokenFor('user'))).toBe(digest(replacement));
    expect(digest(await msTokenFor('agent'))).toBe(digest(FIX.mAgent.at));
    expect(digest(await msTokenFor('m-agent-2'))).toBe(digest(FIX.mAgent2.at));
    expect(digest(getMicrosoftAccount('user')!.refreshToken)).toBe(digest(FIX.mUser.rt));
  });

  it('listing a kind returns that kind only, each carrying its own material', () => {
    expect(listMicrosoftAccounts('agent').map(a => a.id)).toEqual(['agent', 'm-agent-2']);
    expect(listMicrosoftAccounts('user').map(a => a.id)).toEqual(['user']);
  });
});

describe('PHASE-5 T10 (3): the two providers do not cross', () => {
  it('an id that exists in both tables answers with the right provider\'s material', () => {
    // 'agent' and 'user' are legitimate ids in BOTH tables — the position-1 rows
    // are keyed by kind name by design (migration 071). A provider mix-up here
    // would be invisible to a type checker.
    expect(digest(getGoogleAccount('agent')!.accessToken)).toBe(digest(FIX.gAgent.at));
    expect(digest(getMicrosoftAccount('agent')!.accessToken)).toBe(digest(FIX.mAgent.at));
    expect(digest(getGoogleAccount('agent')!.accessToken))
      .not.toBe(digest(getMicrosoftAccount('agent')!.accessToken));
  });

  it('a Google-only id is unknown to Microsoft and vice versa', () => {
    expect(getMicrosoftAccount('g-agent-2')).toBeNull();
    expect(getGoogleAccount('m-agent-2')).toBeNull();
  });
});
