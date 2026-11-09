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
//  (3) ⚠ FLIPPED BY THE OWNER (UX-ACCESS, 2026-09-13). This used to record that
//      any agent could read any row of `agent_credentials` by name, as an ALLOW
//      with its reason, because changing it would be a NEW REFUSAL — *"the
//      owner's decision, never a worker's"* — and it said the flip must be
//      deliberate and visible. The owner decided: credential access is scoped to
//      the agent's granted integrations. Clause 6 now measures the scope.
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
});

describe('PHASE-5 T6C (3): THE OWNER DECIDED — the agent credential store is SCOPED', () => {
  // ⚠ CLAUSE 6 WAS FLIPPED, DELIBERATELY AND VISIBLY, WHICH IS WHAT IT ASKED FOR.
  //
  // The header's clause (3) recorded the ungated behaviour as an ALLOW and named
  // the open question: *"OWNER: whether reads of the agent credential store
  // should be scoped to the agent that stored them"*, adding that the clause is
  // *"meant to be flipped deliberately and visibly, not quietly deleted"*. The
  // owner answered it in the UX-ACCESS design (2026-09-13): *"credential access
  // scoped to granted integrations (fixes any-agent-deletes-any-credential)"*.
  //
  // The scope is NOT "the agent that stored it" — that was the shape the question
  // guessed at. It is the agent's GRANT: `permissions.grants.integrations
  // .credentials`, a list of service names or `'*'`. Every agent alive at the
  // migration carries `'*'`, so this flip refused nothing that worked the day it
  // landed; what it ends is that a NEW agent inherits the whole vault.
  //
  // The four clauses below are the same four facts, re-measured.

  it('gate row 16 names every credential tool — the ungated ledger is empty here', () => {
    for (const name of ['credential_list', 'credential_get', 'credential_add', 'credential_update', 'credential_delete']) {
      const gates = gatesForCall(name, { service_name: 'anything' });
      expect(gates.some((g) => g.kind === 'credential' && g.row === '16'), name).toBe(true);
    }
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
    // DOJO-REPORT T4 — the user's own GitHub token for posting problem reports; sealed by
    // `github/account.ts`, never in `agent_credentials` (RULING P5-R13). It is declared in a
    // ONE-ROW TABLE rather than hidden in a `config` key SPECIFICALLY so this clause can see
    // it: a token in `config.value` would carry no credential-shaped column name and would
    // pass this census by being invisible to it, which is the seam the clause exists to keep
    // honest. There is no refresh token — an OAuth App's device-flow token does not expire,
    // which is the whole reason D3 could forbid shipping a client secret.
    '170_github_account.sql:access_token': 'SEALED AT REST (DOJO-REPORT T4) — the user\'s own GitHub OAuth token, in its own table',
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
});
