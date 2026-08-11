// ════════════════════════════════════════════════════════════════════════════
// UX-REPAIR T39 — THE SLOT IS NEVER GUESSED, AND A REFUSAL SAYS WHERE TO GO
//
// Owner report: "the agent once again has no clue which email accounts are his
// vs the user's." Two halves. The RECEIPT half is pinned in
// `agent/tools/provider/__tests__/mailbox-banner.test.ts`. This file pins the
// RESOLUTION half — the part the plan told this task to verify before assuming:
//
//   • the slot comes from the tool NAME (`user_` prefix), never from "whichever
//     row came first", so an unprefixed read is the AGENT's mailbox by
//     construction and `account` can only choose WITHIN that slot;
//   • a slot with nothing connected REFUSES, and — new in T39 — the refusal
//     names the sibling slot when THAT one is connected, so a model holding a
//     reachable mailbox is told how to reach it instead of being told only to
//     go configure something.
//
// Measured on the dev box before the fix: four connected accounts, one per
// slot per provider (agent kbrns66@gmail.com / kbrns6@outlook.com, user
// dcliff9@gmail.com / dcliff9@live.com). Every slot holds exactly one account,
// so the pre-existing "label it when the slot is ambiguous" rule never fired
// and no read ever named its mailbox.
// ════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** A `google_accounts` ROW, in the table's own shape (0/1 ints), so the mock
 *  exercises the real `rowToAccount` mapping rather than a parallel one. */
interface Row {
  id: string; kind: string; position: number; email: string | null;
  enabled: number; connected: number;
  access_token: null; refresh_token: null; token_expires_at: null;
  granted_scopes: null; enabled_services: null;
  watch_email: number; send_email: number; last_verified_at: null;
}
let rows: Row[] = [];

/** The two shapes the resolvers ask for: `WHERE kind = ?` (list) and
 *  `WHERE kind = ? ORDER BY position LIMIT 1` / `WHERE id = ?` (single). */
vi.mock('../../db/connection.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      all: (kind?: string) => (kind === undefined ? rows : rows.filter((r) => r.kind === kind)),
      get: (arg?: string) => {
        if (/WHERE id = \?/.test(sql)) return rows.find((r) => r.id === arg);
        const scoped = arg === undefined ? rows : rows.filter((r) => r.kind === arg);
        return [...scoped].sort((a, b) => a.position - b.position)[0];
      },
      run: () => undefined,
    }),
  }),
}));
vi.mock('../../credentials/field-crypto.js', () => ({ decryptField: (v: unknown) => v, encryptField: (v: unknown) => v }));

const { resolveGoogleAccountForTool, resolveGoogleAccountForRead } = await import('../accounts.js');

function seed(next: Row[]): void { rows = next; }
const G = (id: string, kind: string, email: string, connected = true, position = 1): Row => ({
  id, kind, position, email,
  enabled: 1, connected: connected ? 1 : 0,
  access_token: null, refresh_token: null, token_expires_at: null,
  granted_scopes: null, enabled_services: null,
  watch_email: 0, send_email: 0, last_verified_at: null,
});

beforeEach(() => { rows = []; });

describe('the slot is decided by the tool name, not by the account table', () => {
  it('the agent slot resolves to the AGENT account even when a user account exists', () => {
    seed([G('agent', 'agent', 'kbrns66@gmail.com'), G('user', 'user', 'dcliff9@gmail.com')]);
    const agent = resolveGoogleAccountForRead('agent');
    const user = resolveGoogleAccountForRead('user');
    expect('error' in agent ? agent.error : agent.account.email).toBe('kbrns66@gmail.com');
    expect('error' in user ? user.error : user.account.email).toBe('dcliff9@gmail.com');
  });

  it('`account` cannot reach across into the other slot', () => {
    seed([G('agent', 'agent', 'kbrns66@gmail.com'), G('user', 'user', 'dcliff9@gmail.com')]);
    const crossed = resolveGoogleAccountForRead('agent', 'dcliff9@gmail.com');
    expect('error' in crossed).toBe(true);
    if ('error' in crossed) expect(crossed.error).toMatch(/No connected agent Google account matches/);
  });
});

describe('an empty slot refuses, and the refusal points at the slot that is connected', () => {
  it('THE RED: agent slot empty, user slot connected → the refusal names the user slot', () => {
    seed([G('user', 'user', 'dcliff9@gmail.com')]);
    const out = resolveGoogleAccountForTool('agent');
    expect('error' in out).toBe(true);
    if (!('error' in out)) throw new Error('unreachable');
    expect(out.error).toContain('No agent Google account is connected');
    expect(out.error).toContain('Your user Google account IS connected');
    expect(out.error).toContain('`user_` tool variants read');
  });

  it('user slot empty, agent slot connected → the refusal names the unprefixed tools', () => {
    seed([G('agent', 'agent', 'kbrns66@gmail.com')]);
    const out = resolveGoogleAccountForTool('user');
    expect('error' in out).toBe(true);
    if (!('error' in out)) throw new Error('unreachable');
    expect(out.error).toContain('Your agent Google account IS connected');
    expect(out.error).toContain('unprefixed tools read');
  });

  it('CONTROL: nothing connected anywhere → the original refusal, byte-identical', () => {
    seed([]);
    const out = resolveGoogleAccountForTool('agent');
    expect('error' in out).toBe(true);
    if (!('error' in out)) throw new Error('unreachable');
    expect(out.error).toBe('No agent Google account is connected. Connect one in Settings → Google.');
  });
});

describe('the read/write asymmetry stays where the owner put it (2026-07-08)', () => {
  it('a READ on a two-account slot defaults to the primary and asks for a label', () => {
    seed([G('agent', 'agent', 'one@example.com', true, 1), G('agent2', 'agent', 'two@example.com', true, 2)]);
    const out = resolveGoogleAccountForRead('agent');
    expect('error' in out).toBe(false);
    if ('error' in out) throw new Error('unreachable');
    expect(out.account.email).toBe('one@example.com');
    expect(out.labelAccount).toBe(true);
  });

  it('a WRITE on the same slot still refuses rather than picking one', () => {
    seed([G('agent', 'agent', 'one@example.com', true, 1), G('agent2', 'agent', 'two@example.com', true, 2)]);
    const out = resolveGoogleAccountForTool('agent');
    expect('error' in out).toBe(true);
    if (!('error' in out)) throw new Error('unreachable');
    expect(out.error).toMatch(/More than one agent Google account is connected/);
  });
});
