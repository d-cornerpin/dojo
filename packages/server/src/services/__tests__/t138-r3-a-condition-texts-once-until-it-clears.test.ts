// ════════════════════════════════════════════════════════════════════════════════════════
// t138 round 3 — A CONDITION TEXTS ONCE WHEN IT STARTS, AND AGAIN ONLY AFTER IT CLEARED.
//
// The round-2 census found three owner texts that repeat while NOTHING has changed:
//   - "System memory below 512MB" — once a minute for as long as memory stays low (a one-minute
//     cooldown was the only brake);
//   - "The Healer agent is broken" — on every injury of the Healer;
//   - "<agent> is stuck and the Healer agent is missing" — on every injury of any agent while
//     the Healer is missing.
// Owner ruling (2026-10-13): "I don't want to put hard limits on the dojo. The dojo should be
// smart enough to know when enough is enough." So no count and no time cap: each texts once
// when its condition starts, and again only after the condition genuinely cleared and came
// back. Driven through the real doors: `canSpawnAgent` (the spawn gate that measures memory),
// `onAgentInjured` / `onAgentRecovered` (the Healer's doors), and the real `sendAlert` /
// iMessage door. Only `child_process` (the phone, and `vm_stat`), `os` memory figures and the
// engine downstream of the Healer are replaced.
// ════════════════════════════════════════════════════════════════════════════════════════

// RED-FIRST at 71247b35: clauses marked `it.fails` are the witness, failing before the fix;
// the fix commits flip them to `it`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(process.env.DOJO_TEST_HOME_ROOT || os.tmpdir(), 'dojo-t138-r3-once');

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r3-once');
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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t138-r3-once', 'dojo.db'),
  };
});

const { transport, memory, broadcasts } = vi.hoisted(() => ({
  transport: [] as string[],
  /** The box's free memory as `vm_stat` would report it, in MB (total 16 GB). */
  memory: { freeMb: 8000 },
  broadcasts: [] as Array<Record<string, unknown>>,
}));
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { broadcasts.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage: vi.fn(async () => undefined),
  }),
}));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage: vi.fn(async () => ({ delivered: true })) }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => {
    if (a[0] === 'vm_stat') {
      // 16 GB box, 16 KB pages: used = total - free.
      const usedPages = Math.round(((16384 - memory.freeMb) * 1024 * 1024) / 16384);
      return `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages active: ${usedPages}.\nPages wired down: 0.\nPages occupied by compressor: 0.\n`;
    }
    transport.push(JSON.stringify(a));
    return '';
  };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  const totalmem = (): number => 16384 * 1024 * 1024;
  return { ...orig, default: { ...orig, totalmem }, totalmem };
});

import { runMigrations } from '../../db/migrations.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

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
  broadcasts.length = 0;
  memory.freeMb = 8000;
  d.prepare(`INSERT INTO config (key, value) VALUES ('imessage_approved_senders', ?)`)
    .run(JSON.stringify([{ address: OWNER, name: 'Owner', is_primary: true }]));
  d.prepare(`INSERT INTO agents (id, name, status, created_at, updated_at)
             VALUES ('ag', 'Helper', 'error', datetime('now'), datetime('now')),
                    ('hl', 'Mender', 'idle', datetime('now'), datetime('now'))`).run();
  d.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', 'hl')").run();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
  vi.resetModules();
});

const texts = (): string[] => transport.filter((t) => !t.includes('--help') && !t.includes('which'));
const about = (word: string): string[] => texts().filter((t) => t.includes(word));

describe('memory below 512MB', () => {
  it('texts once while it stays low, however long; again only after it recovered and fell again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let now = Date.now();
    vi.setSystemTime(now);
    const { canSpawnAgent } = await import('../resource-monitor.js');
    memory.freeMb = 300;
    for (let i = 0; i < 5; i++) { // five spawn attempts, a few minutes apart, memory never recovers
      expect(canSpawnAgent().allowed).toBe(false);
      now += 3 * 60_000; vi.setSystemTime(now);
    }
    expect(about('512MB'), 'one text for one low-memory stretch').toHaveLength(1);

    memory.freeMb = 6000; // it genuinely cleared
    expect(canSpawnAgent().allowed).toBe(true);
    memory.freeMb = 300; // and came back
    now += 3 * 60_000; vi.setSystemTime(now);
    canSpawnAgent();
    expect(about('512MB')).toHaveLength(2);
  });

  it('a restart in the middle of a low stretch does not text again', async () => {
    memory.freeMb = 300;
    (await import('../resource-monitor.js')).canSpawnAgent();
    vi.resetModules();
    (await import('../resource-monitor.js')).canSpawnAgent();
    expect(about('512MB')).toHaveLength(1);
  });
});

describe('the Healer itself is broken', () => {
  it('texts once however many times it is injured; again only after it recovered and broke again', async () => {
    vi.useFakeTimers();
    const healer = await import('../../healer/injury-recovery.js');
    healer.onAgentInjured('hl', 'provider down');
    healer.onAgentInjured('hl', 'provider down');
    healer.onAgentInjured('hl', 'provider down');
    expect(about('Healer agent is broken')).toHaveLength(1);
    (await import('../../agent/errors.js')).clearErrors('hl'); // r6: only the Healer working ends it (a reset is not recovery)
    healer.onAgentInjured('hl', 'provider down');
    expect(about('Healer agent is broken')).toHaveLength(2);
  });
});

describe('the Healer is missing', () => {
  it('texts once however many agents are injured meanwhile; again only after it was back and went missing again', async () => {
    vi.useFakeTimers();
    db().prepare("UPDATE agents SET status = 'terminated' WHERE id = 'hl'").run();
    const healer = await import('../../healer/injury-recovery.js');
    const injure = async (): Promise<void> => {
      db().prepare("UPDATE agents SET status = 'error', recovery_attempts = 0 WHERE id = 'ag'").run();
      healer.onAgentInjured('ag', 'provider down');
      await vi.runAllTimersAsync(); // auto-wake, grace period, then the Healer is looked for
    };
    await injure();
    await injure();
    await injure();
    expect(about('Healer agent is missing')).toHaveLength(1);

    db().prepare("UPDATE agents SET status = 'idle' WHERE id = 'hl'").run(); // restored
    await injure(); // an injury while it is present: the condition has cleared
    db().prepare("UPDATE agents SET status = 'terminated' WHERE id = 'hl'").run(); // gone again
    await injure();
    expect(about('Healer agent is missing')).toHaveLength(2);
  });
});
