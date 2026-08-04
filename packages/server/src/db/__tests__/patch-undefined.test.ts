// PHASE-4 T5 Step 1 — M7: THE ONE PATCH RULE.
//
// `undefined` means LEAVE THIS COLUMN ALONE. `null` means CLEAR IT. There is no third
// meaning and no per-site dialect.
//
// The rule is not a tidiness point — it is five recorded incidents with one mechanism.
// Every patch boundary in this tree was written as `Object.entries(patch)` (or
// `Object.keys(patch)`) followed by an encoder shaped `v => v ?? null`, and a JavaScript
// object literal cannot tell "I did not mention this field" apart from "I mentioned it and
// the value happened to be undefined" once the key is written down. So:
//
//   * P495 — a userinfo blip during a Google reconnect leaves `email = ''`; the caller
//     writes `{ email: email || undefined }` MEANING leave it alone, and
//     `updateGoogleAccount`'s `email: v => v ?? null` turns that into SQL NULL. The account
//     loses its address while being marked connected.
//   * P527 — the same line, the same encoder, `updateMicrosoftAccount`. P527's own text
//     names the generalization: "Same mechanism applies to any future undefined-valued key
//     in a patch."
//   * `patchWork` / `patchWorkWhere` — `keys.map(k => patch[k] ?? null)`, the tracker's own
//     copy of it, on the work spine.
//
// The tests below are written against the SITES, not against the helper, because the helper
// is an implementation detail and the incident is not: a patch that omits a field must never
// erase it, whichever door the patch arrived through.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-m7-patch-test', 'dojo.db'),
  };
});

vi.mock('../../agent/tool-config-generation.js', () => ({
  bumpToolConfigGeneration: vi.fn(),
}));

import { runMigrations } from '../migrations.js';
import { patchWork, patchWorkWhere } from '../../work/tracker-store.js';
import { insertGoogleAccount, getGoogleAccount, updateGoogleAccount } from '../../google/accounts.js';
import {
  insertMicrosoftAccount, getMicrosoftAccount, updateMicrosoftAccount,
} from '../../microsoft/accounts.js';

const T = 1_700_000_000_000;

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: 'kevin', assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: id, state: 'open', intent: 'tracker',
    wakes: 0, closes_thread: 0, title: 'the original title', goal: 'the original goal',
    notes: 'the original notes', priority: 'normal', assigned_to_group: 'g1',
    opened_at: T, updated_at: T, provenance: 'live', ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

const workRow = (id: string): Record<string, unknown> =>
  mockDb.current!.prepare('SELECT * FROM work WHERE id = ?').get(id) as Record<string, unknown>;

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
});

// ════════════════════════════════════════════════════════════════════════════════
// 1 — THE WORK SPINE (`work/tracker-store.ts`)
// ════════════════════════════════════════════════════════════════════════════════

describe('M7 — patchWork', () => {
  it('THE DEFECT: a patch whose value is undefined must NOT erase the column', () => {
    seedWork('w1');
    patchWork('w1', { title: undefined });
    expect(workRow('w1').title).toBe('the original title');
  });

  it('an undefined value beside a real one writes only the real one', () => {
    seedWork('w1');
    patchWork('w1', { title: undefined, goal: 'a new goal' });
    const row = workRow('w1');
    expect(row.title).toBe('the original title');
    expect(row.goal).toBe('a new goal');
  });

  it('THE CLEAR PROTOCOL: an explicit null still clears the column', () => {
    seedWork('w1');
    patchWork('w1', { title: null });
    expect(workRow('w1').title).toBeNull();
  });

  it('CONTROL: a real value is still written', () => {
    seedWork('w1');
    patchWork('w1', { title: 'a new title' });
    expect(workRow('w1').title).toBe('a new title');
  });

  it('a patch that assigns nothing does not move updated_at and reports nothing happened', () => {
    // `updated_at` is the PM ladder's "when did this work last MOVE" column
    // (`patchWork`'s own doc comment). A patch that turned out to say nothing did not move
    // anything, so bumping the clock would be a false receipt — and before this rule an
    // all-undefined patch bumped it while ALSO erasing every column it named.
    //
    // PHASE-6 T0D changed the SPELLING of "nothing happened" and not the rule: the door
    // answered `0` for this AND for "that row does not exist", and those are two different
    // facts. `no_change`/`empty-patch` is this one, and the clock assertion below — which is
    // what this clause was written for — is untouched.
    seedWork('w1');
    const nothing = patchWork('w1', { title: undefined, goal: undefined });
    expect(nothing.kind).toBe('no_change');
    if (nothing.kind === 'no_change') expect(nothing.reason).toBe('empty-patch');
    expect(workRow('w1').updated_at).toBe(T);
  });

  it('an empty patch object is the same nothing', () => {
    seedWork('w1');
    expect(patchWork('w1', {}).kind).toBe('no_change');
    expect(workRow('w1').updated_at).toBe(T);
  });

  it('a patch that DOES assign still moves updated_at', () => {
    seedWork('w1');
    patchWork('w1', { goal: 'moved' });
    expect(workRow('w1').updated_at).not.toBe(T);
  });

  it('touch:false still suppresses the clock on a real assignment', () => {
    seedWork('w1');
    patchWork('w1', { last_smell_flag: 'stale' }, { touch: false });
    const row = workRow('w1');
    expect(row.last_smell_flag).toBe('stale');
    expect(row.updated_at).toBe(T);
  });
});

describe('M7 — patchWorkWhere', () => {
  it('THE DEFECT: an undefined value must NOT erase the column on matched rows', () => {
    seedWork('w1', { assigned_to_group: 'g1' });
    seedWork('w2', { assigned_to_group: 'g1' });
    patchWorkWhere({ column: 'assigned_to_group', equals: 'g1' }, { title: undefined });
    expect(workRow('w1').title).toBe('the original title');
    expect(workRow('w2').title).toBe('the original title');
  });

  it('THE CLEAR PROTOCOL: the live caller shape (group deleted -> null) still clears', () => {
    // `agent/groups.ts:159` — the one shape this function was narrowed for.
    seedWork('w1', { assigned_to_group: 'g1' });
    patchWorkWhere({ column: 'assigned_to_group', equals: 'g1' }, { assigned_to_group: null });
    expect(workRow('w1').assigned_to_group).toBeNull();
  });

  it('a patch that assigns nothing touches no row', () => {
    seedWork('w1', { assigned_to_group: 'g1' });
    expect(patchWorkWhere({ column: 'assigned_to_group', equals: 'g1' }, { title: undefined })).toBe(0);
    expect(workRow('w1').updated_at).toBe(T);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 — P495 / P527: THE ACCOUNT REGISTRIES
// ════════════════════════════════════════════════════════════════════════════════

describe('M7 — updateGoogleAccount (P495)', () => {
  const seed = (): string => insertGoogleAccount({
    kind: 'user', email: 'owner@example.com', enabled: true, connected: true,
    accessToken: 'at', refreshToken: 'rt', tokenExpiresAt: null,
    grantedScopes: 'scope-a', enabledServices: null,
    watchEmail: true, sendEmail: true, lastVerifiedAt: null,
  }).id;

  it('THE DEFECT (P495 verbatim): a reconnect whose userinfo lookup failed must not wipe the email', () => {
    const id = seed();
    // `google/auth.ts:653` — `email` is '' after the swallowed userinfo error, so the
    // caller writes `email: email || undefined` MEANING "leave the stored address alone".
    const email = '';
    updateGoogleAccount(id, {
      email: email || undefined,
      accessToken: 'new-at',
      connected: true,
    });
    const acc = getGoogleAccount(id)!;
    expect(acc.email).toBe('owner@example.com');
    expect(acc.accessToken).toBe('new-at');
  });

  it('an undefined boolean must not be encoded as false', () => {
    // `v => (v ? 1 : 0)` is the same defect wearing a different encoder: undefined is
    // falsy, so "leave it alone" arrived as "turn it off".
    const id = seed();
    updateGoogleAccount(id, { connected: undefined, watchEmail: undefined, enabled: undefined });
    const acc = getGoogleAccount(id)!;
    expect(acc.connected).toBe(true);
    expect(acc.watchEmail).toBe(true);
    expect(acc.enabled).toBe(true);
  });

  it('THE CLEAR PROTOCOL: an explicit null still clears', () => {
    const id = seed();
    updateGoogleAccount(id, { email: null, refreshToken: null });
    const acc = getGoogleAccount(id)!;
    expect(acc.email).toBeNull();
    expect(acc.refreshToken).toBeNull();
  });

  it('CONTROL: a real value is still written, booleans included', () => {
    const id = seed();
    updateGoogleAccount(id, { email: 'other@example.com', connected: false });
    const acc = getGoogleAccount(id)!;
    expect(acc.email).toBe('other@example.com');
    expect(acc.connected).toBe(false);
  });
});

describe('M7 — updateMicrosoftAccount (P527)', () => {
  const seed = (): string => insertMicrosoftAccount({
    kind: 'user', email: 'owner@example.com', accountType: 'entra',
    enabled: true, connected: true, accessToken: 'at', refreshToken: 'rt',
    tokenExpiresAt: null, grantedScopes: 'scope-a', enabledServices: null,
    watchEmail: true, sendEmail: true, lastVerifiedAt: null,
  }).id;

  it('THE DEFECT (P527 verbatim): a reconnect whose /me lookup failed must not wipe the email', () => {
    const id = seed();
    const email = '';
    updateMicrosoftAccount(id, { email: email || undefined, accessToken: 'new-at', connected: true });
    const acc = getMicrosoftAccount(id)!;
    expect(acc.email).toBe('owner@example.com');
    expect(acc.accessToken).toBe('new-at');
  });

  it('an undefined boolean must not be encoded as false', () => {
    const id = seed();
    updateMicrosoftAccount(id, { connected: undefined, sendEmail: undefined });
    const acc = getMicrosoftAccount(id)!;
    expect(acc.connected).toBe(true);
    expect(acc.sendEmail).toBe(true);
  });

  it('THE CLEAR PROTOCOL: an explicit null still clears', () => {
    const id = seed();
    updateMicrosoftAccount(id, { email: null });
    expect(getMicrosoftAccount(id)!.email).toBeNull();
  });
});
