// PHASE-4 T5 Step 1 — M7 at the credentials PATCH boundary (P362).
//
// `PATCH /api/credentials/:id` is a PATCH — partial-update semantics — and it handed
// `body.credentials` straight to `updateCredential`, which does `JSON.stringify(credentials)`
// over the whole `encrypted_credentials` blob. A client that sent only the field it changed
// destroyed every key it did not resend, and the old ciphertext was overwritten in place, so
// there is nothing to recover from. P362's own words: "Irrecoverable loss of stored
// credential fields on a partial edit; agents using those fields start failing with no error
// at edit time."
//
// The rule is `db/patch.ts`'s, spelled for a document instead of a column set: a key the
// caller did not mention is LEFT ALONE, and an explicit `null` REMOVES it. Removal has to be
// expressible or this fix would trade P362 for a new defect — the dashboard's edit form has a
// per-field remove button, and a merge with no clear protocol would silently resurrect every
// field the owner deleted (#15: a fix may not rest on the half of the behaviour it noticed).
//
// The AGENT tool path is deliberately NOT changed: `credential_update`'s own schema says
// "New credential payload (replaces the existing one entirely)", so wholesale replace there
// is a declared contract, not an accident. The HTTP verb is the thing that promised partial.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const mockDb: { current: Database.Database | null } = { current: null };
const KEY = crypto.randomBytes(32).toString('hex');

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-credentials-patch-test', 'dojo.db'),
  };
});

vi.mock('../../config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/loader.js')>();
  return { ...actual, getCredentialMasterKey: () => Buffer.from(KEY, 'hex') };
});

import { runMigrations } from '../../db/migrations.js';
import { addCredential, getCredentialByService } from '../../credentials/store.js';
import { credentialsRouter } from '../routes/credentials.js';

const SERVICE = 'shopify_admin';

/** Read the stored blob without going through the route under test. */
const stored = (): Record<string, unknown> =>
  getCredentialByService(SERVICE, null)!.credentials;

async function patchCredential(id: string, body: unknown): Promise<Response> {
  return credentialsRouter.request(`/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

let id = '';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  const added = addCredential(
    SERVICE,
    { api_key: 'KEY-ORIGINAL', username: 'owner', refresh_token: 'RT-ORIGINAL' },
    'the shop admin API',
    null,
  );
  if (!added.ok) throw new Error(added.error);
  id = added.record.id;
});

describe('M7 / P362 — PATCH /api/credentials/:id is a PATCH', () => {
  it('THE DEFECT: sending only the changed field must not destroy the others', async () => {
    const res = await patchCredential(id, { credentials: { api_key: 'KEY-ROTATED' } });
    expect(res.status).toBe(200);
    expect(stored()).toEqual({
      api_key: 'KEY-ROTATED',
      username: 'owner',
      refresh_token: 'RT-ORIGINAL',
    });
  });

  it('THE CLEAR PROTOCOL: an explicit null removes exactly that key', async () => {
    await patchCredential(id, { credentials: { refresh_token: null } });
    expect(stored()).toEqual({ api_key: 'KEY-ORIGINAL', username: 'owner' });
  });

  it('a removal and a rotation ride the same request', async () => {
    await patchCredential(id, { credentials: { api_key: 'KEY-ROTATED', username: null } });
    expect(stored()).toEqual({ api_key: 'KEY-ROTATED', refresh_token: 'RT-ORIGINAL' });
  });

  it('CONTROL: naming every field still replaces every field', async () => {
    await patchCredential(id, {
      credentials: { api_key: 'A', username: 'B', refresh_token: 'C' },
    });
    expect(stored()).toEqual({ api_key: 'A', username: 'B', refresh_token: 'C' });
  });

  it('an omitted description leaves the stored description alone', async () => {
    await patchCredential(id, { credentials: { api_key: 'KEY-ROTATED' } });
    expect(getCredentialByService(SERVICE, null)!.description).toBe('the shop admin API');
  });

  it('a description that IS sent is written', async () => {
    await patchCredential(id, { credentials: { api_key: 'x' }, description: 'rotated 2026-08' });
    expect(getCredentialByService(SERVICE, null)!.description).toBe('rotated 2026-08');
  });

  it('an empty credentials object changes nothing rather than emptying the record', async () => {
    await patchCredential(id, { credentials: {} });
    expect(stored()).toEqual({
      api_key: 'KEY-ORIGINAL', username: 'owner', refresh_token: 'RT-ORIGINAL',
    });
  });

  it('still refuses a body with no credentials object at all', async () => {
    const res = await patchCredential(id, { description: 'only this' });
    expect(res.status).toBe(400);
    expect(stored()).toEqual({
      api_key: 'KEY-ORIGINAL', username: 'owner', refresh_token: 'RT-ORIGINAL',
    });
  });

  it('still 404s on an unknown id', async () => {
    const res = await patchCredential('no-such-id', { credentials: { api_key: 'x' } });
    expect(res.status).toBe(404);
  });
});
