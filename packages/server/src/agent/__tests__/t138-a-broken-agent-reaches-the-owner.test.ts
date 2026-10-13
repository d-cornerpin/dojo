// ════════════════════════════════════════════════════════════════════════════════════════
// t138 — AN AGENT THAT BREAKS REACHES THE OWNER'S PHONE (OR-V333-SET (3), the second class).
//
// At v3.3.2 the two agent-trouble notices in `agent/errors.ts` — "paused after repeated errors"
// and the strike-3 rate-limit notice — were sent as `'warning'`, which `sendAlert` drops before
// the phone (a v2.3.19 demotion: "a single agent paused is NOT a true blocker"). The owner has
// since ruled that a broken agent is exactly one of the two things the platform may tell him
// directly. Driven through the real error-loop door (`recordError`, backed by the durable
// `error_loop_state` table) and the real `sendAlert` / iMessage door.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 00a2b34d: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-agent-trouble');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-agent-trouble');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-agent-trouble', 'dojo.db'),
  };
});

const { transport } = vi.hoisted(() => ({ transport: [] as string[] }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

import { runMigrations } from '../../db/migrations.js';
import { recordError, notifyRateLimitHit } from '../errors.js';

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
  d.prepare(`INSERT INTO agents (id, name, model_id, status, created_at, updated_at)
             VALUES ('ag', 'Helper', NULL, 'idle', datetime('now'), datetime('now'))`).run();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

const ownerOutbounds = (): number => (db().prepare(
  "SELECT COUNT(*) AS n FROM deliveries WHERE agent_id = 'platform' AND tool = 'alert' AND recipient_id = ?",
).get(OWNER) as { n: number }).n;
const sent = (): string[] => transport.filter((t) => !t.includes('--help') && !t.includes('which'));

describe('BROKEN: an agent paused after repeated errors', () => {
  it('the trip that pauses the agent texts the owner once, naming the agent', () => {
    let paused = false;
    for (let i = 0; i < 10 && !paused; i++) paused = recordError('ag');
    expect(paused).toBe(true);
    expect(ownerOutbounds()).toBe(1);
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain('Helper');
    expect(sent()[0]).toContain('paused');
  });
});

describe('BROKEN: the strike-3 rate-limit notice', () => {
  it('reaches the owner once; a repeat inside the cooldown does not', () => {
    notifyRateLimitHit('ag', 'rate_limit');
    notifyRateLimitHit('ag', 'rate_limit');
    expect(ownerOutbounds()).toBe(1);
    expect(sent()[0]).toContain('Helper');
  });
});
