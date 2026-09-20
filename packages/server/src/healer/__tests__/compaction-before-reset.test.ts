// T82c (ANSWER-ANYWAY) — COMPACTION BEFORE RESET; RESET STAYS FOR DIRE.
//
// OWNER RULING, VERBATIM INTENT: the Healer KEEPS session reset — "We aren't taking that
// away" — it just can't be the first trigger pulled when compaction could have worked. For
// size-class injuries (declared-patience exhaustions): compaction-first; session reset ONLY
// when (a) compact-and-redial already failed on >=2 distinct turns, (b) context corruption is
// diagnosed, or (c) the owner explicitly asked. Non-size injuries: byte-identical behavior.
// The reset TOOL itself is untouched (R2).
//
// Incident trace: vault-archive -> "Session reset via tool" fired against an agent whose most
// recent injury was a declared-patience exhaustion, with no compaction attempt behind it. This
// file drives the REAL `reset_session` handler (`agent/tools/cat/session.ts`) against a real
// in-memory DB, the same way `nobody-force-resets-a-live-agent.test.ts` drives the Healer's
// other fixers — the guard under test is `evaluateSessionResetGuard` (`healer/injury-recovery.ts`),
// wired into the tool's executor, not a change to the reset mechanism itself.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t82c-reset-guard-test', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../vault/archive.js', () => ({ archiveAgentConversation: vi.fn(() => 'archive-1') }));
vi.mock('../../agent/session-reset.js', () => ({ buildSessionResetMessage: vi.fn(() => '[System: reoriented]') }));
vi.mock('../../agent/v2/counterparty.js', () => ({ rehomeUnclaimedEngineEvents: vi.fn() }));
vi.mock('../../memory/message-store.js', () => ({ insertMessageIfAbsent: vi.fn(() => null) }));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';

const HEALER = 'healer';
const TARGET = 'mrmeseeks';

// The literal phrase `classifyError` (injury-recovery.ts) matches for the size-class
// (declared-patience) injury bucket — copied here for the same reason every other test fixture
// in this codebase copies it: the reader under test holds only a persisted STRING.
const PATIENCE_LAST_ERROR =
  'model first-chunk timeout: no data from provider for too long (elapsed 300123ms; ' +
  '~92000 estimated prompt tokens against a declared 300000ms first-chunk patience)';

const CORRUPTION_LAST_ERROR = 'invalid_request: tool_use_id mismatch, messages.0 malformed';

function seedAgents(db: Database.Database): void {
  db.prepare(
    "INSERT INTO agents (id, name, status) VALUES (?, 'MrMeSeeks', 'error'), (?, 'Healer', 'idle')",
  ).run(TARGET, HEALER);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', ?)").run(HEALER);
}

function setLastError(agentId: string, lastError: string | null): void {
  mockDb.current!.prepare('UPDATE agents SET last_error = ? WHERE id = ?').run(lastError, agentId);
}

const statusOf = (id: string): string =>
  (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?').get(id) as { status: string }).status;

/** Drives the REAL `reset_session` handler, matching the cast idiom every other cat/*
 *  handler-driving test in this tree uses (see `the-delegation-door-states-capability.test.ts`). */
async function callReset(args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const { sessionHandlers } = await import('../../agent/tools/cat/session.js');
  const h = sessionHandlers['reset_session'];
  return h({ agentId: HEALER, args } as unknown as Parameters<typeof h>[0]);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seedAgents(db);
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T82c — the reset tool refuses a size-class injury with no prior honest-fail', () => {
  it('RED: a declared-patience injury with zero recorded honest-fails refuses reset with compaction-first text', async () => {
    setLastError(TARGET, PATIENCE_LAST_ERROR);
    const result = await callReset({ agent_id: TARGET });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('declared-patience exhaustion');
    expect(result.content).toContain('compaction');
    expect(result.content.toLowerCase()).not.toContain('archived');
    // The mechanism itself must not have run: status stays 'error', not healed to idle.
    expect(statusOf(TARGET)).toBe('error');
  });
});

describe('T82c — criterion (a): two honest-fails on distinct turns permits reset', () => {
  it('two distinct declared-patience honest-fails for this agent permit the reset', async () => {
    // Fake timers: `onAgentInjured` also schedules a real grace-period timer we never intend
    // to let fire (the count this test cares about is written SYNCHRONOUSLY, before any timer
    // runs) — faking them keeps a stray real setTimeout from firing minutes later against a
    // DB a later test has already replaced.
    vi.useFakeTimers();
    setLastError(TARGET, PATIENCE_LAST_ERROR);
    const { onAgentInjured } = await import('../injury-recovery.js');
    const { DECLARED_PATIENCE_EXCEEDED_CODE } = await import('../../agent/stream-patience.js');

    // Two SEPARATE calls = two distinct turns reaching the honest-fail class, per
    // injury-recovery.ts's own doc: `recordInjury` calls `onAgentInjured` exactly once per
    // failed turn, so two invocations here stand in for two distinct turns.
    onAgentInjured(TARGET, PATIENCE_LAST_ERROR, DECLARED_PATIENCE_EXCEEDED_CODE);
    onAgentInjured(TARGET, PATIENCE_LAST_ERROR, DECLARED_PATIENCE_EXCEEDED_CODE);

    const result = await callReset({ agent_id: TARGET });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Session reset complete');
  });

  it('CONTROL: only ONE recorded honest-fail still refuses', async () => {
    vi.useFakeTimers();
    setLastError(TARGET, PATIENCE_LAST_ERROR);
    const { onAgentInjured } = await import('../injury-recovery.js');
    const { DECLARED_PATIENCE_EXCEEDED_CODE } = await import('../../agent/stream-patience.js');
    onAgentInjured(TARGET, PATIENCE_LAST_ERROR, DECLARED_PATIENCE_EXCEEDED_CODE);

    const result = await callReset({ agent_id: TARGET });

    expect(result.isError).toBe(true);
  });
});

describe('T82c — criterion (b): corruption diagnosed permits reset and is audit-logged', () => {
  it('reason="corruption" permits the reset with zero recorded honest-fails, and writes an audit row', async () => {
    setLastError(TARGET, PATIENCE_LAST_ERROR);
    const result = await callReset({ agent_id: TARGET, reason: 'corruption' });

    expect(result.isError).toBe(false);
    const auditRows = mockDb.current!.prepare(
      "SELECT * FROM healer_actions WHERE category = 'session_reset_guard' AND agent_id = ?",
    ).all(TARGET) as Array<{ result: string }>;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].result).toBe('corruption');
  });
});

describe('T82c — criterion (c): owner-asked permits reset and is audit-logged', () => {
  it('owner_requested=true permits the reset with zero recorded honest-fails, and writes an audit row', async () => {
    setLastError(TARGET, PATIENCE_LAST_ERROR);
    const result = await callReset({ agent_id: TARGET, owner_requested: true });

    expect(result.isError).toBe(false);
    const auditRows = mockDb.current!.prepare(
      "SELECT * FROM healer_actions WHERE category = 'session_reset_guard' AND agent_id = ?",
    ).all(TARGET) as Array<{ result: string }>;
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].result).toBe('owner_requested');
  });
});

describe('T82c — CONTROL: non-size injuries (and no injury at all) are byte-identical to today', () => {
  it('a context-corruption injury (non-size class) resets exactly as before, no guard text', async () => {
    setLastError(TARGET, CORRUPTION_LAST_ERROR);
    const result = await callReset({ agent_id: TARGET });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Session reset complete');
  });

  it('an agent with no recorded last_error at all resets exactly as before', async () => {
    // last_error is NULL by default (never set in seedAgents).
    const result = await callReset({ agent_id: TARGET });

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Session reset complete');
  });

  it('a plain network injury (non-size class) is unaffected by any honest-fail count', async () => {
    setLastError(TARGET, 'fetch failed: ECONNRESET');
    const result = await callReset({ agent_id: TARGET });

    expect(result.isError).toBe(false);
  });
});

describe('T82c — the steering note for size-class injuries carries the ordering text', () => {
  it('the injury note for a declared-patience injury names compaction first and never suggests reset_session', async () => {
    vi.useFakeTimers();
    const deliverA2AMessage = vi.fn(async () => ({ delivered: true }));
    vi.doMock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage }));
    vi.doMock('../../agent/runtime.js', () => ({
      getAgentRuntime: () => ({ notifyPrimaryOfInjury: vi.fn(async () => undefined), handleMessage: vi.fn(async () => undefined) }),
    }));

    const { onAgentInjured } = await import('../injury-recovery.js');
    const { DECLARED_PATIENCE_EXCEEDED_CODE } = await import('../../agent/stream-patience.js');

    onAgentInjured(TARGET, PATIENCE_LAST_ERROR, DECLARED_PATIENCE_EXCEEDED_CODE);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(deliverA2AMessage).toHaveBeenCalledTimes(1);
    const payload = (deliverA2AMessage.mock.calls.at(-1) as [{ payload: string }])[0].payload;
    expect(payload).toContain('already ran ONE forced compaction');
    expect(payload).toContain('BEFORE session reset');
    expect(payload).not.toContain('context corruption: reset_session');
    vi.useRealTimers();
  });

  it('CONTROL: the injury note for a non-size injury keeps its original generic remedy list, including reset_session', async () => {
    vi.useFakeTimers();
    const deliverA2AMessage = vi.fn(async () => ({ delivered: true }));
    vi.doMock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage }));
    vi.doMock('../../agent/runtime.js', () => ({
      getAgentRuntime: () => ({ notifyPrimaryOfInjury: vi.fn(async () => undefined), handleMessage: vi.fn(async () => undefined) }),
    }));

    const { onAgentInjured } = await import('../injury-recovery.js');
    onAgentInjured(TARGET, CORRUPTION_LAST_ERROR);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(deliverA2AMessage).toHaveBeenCalledTimes(1);
    const payload = (deliverA2AMessage.mock.calls.at(-1) as [{ payload: string }])[0].payload;
    expect(payload).toContain('context corruption: reset_session');
    vi.useRealTimers();
  });
});
