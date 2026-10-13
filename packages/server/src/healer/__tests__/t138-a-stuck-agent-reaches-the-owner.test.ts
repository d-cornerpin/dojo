// ════════════════════════════════════════════════════════════════════════════════════════
// t138 (fence extension) — "AUTO-RECOVERY GAVE UP ON A STUCK AGENT" REACHES THE OWNER'S PHONE.
//
// `healer/injury-recovery.ts`, on the FIRST entry into Healer backoff (attempts reached the
// max), tells the owner the agent is stuck and auto-recovery is not unsticking it. That is a
// broken agent — one of the two things the owner ruled the platform may tell him directly
// (OR-V333-SET (3)) — and at v3.3.2 it went out as `'warning'`, which the owner-notice door
// drops before the phone. Driven through the real injury door (`onAgentInjured`, attempts read
// from the durable `agents.recovery_attempts`) and the real `sendAlert` / iMessage door. The
// engine downstream of the Healer (runtime, A2A delivery) is stubbed and its timers are fake,
// so only the notice is measured.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST: the clause marked `it.fails` is the witness, failing before the fix; the fix
// commit flips it to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-healer');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-healer');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-healer', 'dojo.db'),
  };
});

const { transport } = vi.hoisted(() => ({ transport: [] as string[] }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: vi.fn(async () => ({ delivered: true })) }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../../db/migrations.js';
import { onAgentInjured } from '../injury-recovery.js';

const OWNER = 'owner@example.test';
const db = (): Database.Database => mockDb.current!;

beforeEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, '.dojo', 'logs'), { recursive: true });
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  transport.length = 0;
  d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true }]));
  d.prepare("INSERT INTO agents (id, name, status) VALUES ('ag', 'Helper', 'error'), ('hl', 'Healer', 'idle')").run();
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'hl')").run();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

const ownerOutbounds = (): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = 'platform' AND tool = 'alert' AND recipient_id = ?",
).get(OWNER) as { n: number }).n;
const sent = (): string[] => transport.filter((t) => !t.includes('--help') && !t.includes('which'));

describe('BROKEN: auto-recovery gave up on a stuck agent', () => {
  it.fails('the first entry into Healer backoff texts the owner once, naming the agent', () => {
    // Recovery attempts already at the maximum (3), as the durable counter would read after
    // three failed recoveries.
    db().prepare("UPDATE agents SET recovery_attempts = 3 WHERE id = 'ag'").run();
    onAgentInjured('ag', 'fetch failed: ECONNRESET');
    expect(ownerOutbounds()).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('Helper');
    expect(sent()[0]).toContain('stuck');

    // A re-injury inside the backoff window is silent: the owner already knows.
    onAgentInjured('ag', 'fetch failed: ECONNRESET');
    expect(ownerOutbounds()).toBe(1);
  });
});
