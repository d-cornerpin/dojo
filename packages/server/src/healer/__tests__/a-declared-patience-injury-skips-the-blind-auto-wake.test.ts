// T81a — a declared-patience exhaustion earns injury-recovery's OWN treatment.
//
// The GPU livelock incident (2026-09-18/19): a first-chunk timeout on a provider that DECLARED
// its patience fell through `provider-error.ts`'s generic 'network' bucket and reached
// `onAgentInjured` indistinguishable from a dropped TCP connection. The blind 5-second
// auto-wake at :440-469 then cold-re-dialed the identical un-finishable 110K-token prompt,
// over and over, ~1s apart once the fast preempt/wakeup loop (`runtime.ts`) piled on top.
//
// This file drives `onAgentInjured` directly — the seam every recovery path funnels into — and
// asserts the OBSERVABLE difference: the engine-level auto-wake never fires for a
// declared-patience-exceeded injury (the same treatment `isKnownPermanent` already gets), the
// Healer is still notified, and the note the Healer reads names the prompt size and the
// declared patience. A genuine transient (ECONNRESET) keeps its free auto-wake retry —
// P3's carve-out is for THIS class, not for every injury.

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t81a-injury-test', 'dojo.db'),
  };
});

// The Healer's grace-period timer eventually reaches the runtime through a dynamic import.
// Stubbed so the clause under test is the SCHEDULE (did the auto-wake fire), not the engine.
const handleMessage = vi.fn(async () => undefined);
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({
    notifyPrimaryOfInjury: vi.fn(async () => undefined),
    handleMessage,
  }),
}));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
const deliverA2AMessage = vi.fn(async () => ({ delivered: true }));
vi.mock('../../agent/a2a-transport.js', () => ({ deliverA2AMessage }));

import { runMigrations } from '../../db/migrations.js';
import { onAgentInjured } from '../injury-recovery.js';
import { DECLARED_PATIENCE_EXCEEDED_CODE } from '../../agent/stream-patience.js';

const AGENT = 'kevin';
const HEALER = 'healer';

function seed(db: Database.Database): void {
  db.prepare(
    "INSERT INTO agents (id, name, status) VALUES (?, 'Kevin', 'error'), (?, 'Healer', 'idle')",
  ).run(AGENT, HEALER);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', ?)").run(HEALER);
}

// A realistic (but not code-constant — this is a TEST FIXTURE) shape of what `model.ts`'s
// `declaredPatienceClause` actually produces, so this file exercises the same string the throw
// site really builds rather than an invented one.
const PATIENCE_MSG =
  'model first-chunk timeout: no data from provider for too long (elapsed 300123ms; ' +
  '~92000 estimated prompt tokens against a declared 300000ms first-chunk patience)';

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seed(db);
  handleMessage.mockClear();
  deliverA2AMessage.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T81a — a declared-patience exhaustion skips the blind auto-wake', () => {
  it('RED: the engine auto-wake never fires when the injury carries the declared-patience code', async () => {
    vi.useFakeTimers();
    onAgentInjured(AGENT, PATIENCE_MSG, DECLARED_PATIENCE_EXCEEDED_CODE);
    await vi.advanceTimersByTimeAsync(6_000); // past the 5s AUTO_WAKE_DELAY_MS
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('the SAME detection survives on the message text alone — a restart carries no code', async () => {
    // `rehydrateInjuredAgents` calls this with only `agents.last_error`, a persisted STRING,
    // after a crash loses every in-memory timer. The code argument is omitted here on
    // purpose — this is the path that must survive a restart.
    vi.useFakeTimers();
    onAgentInjured(AGENT, PATIENCE_MSG);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(handleMessage).not.toHaveBeenCalled();
  });

  it('still notifies the Healer — this is a different TREATMENT, not a silence', async () => {
    vi.useFakeTimers();
    onAgentInjured(AGENT, PATIENCE_MSG, DECLARED_PATIENCE_EXCEEDED_CODE);
    await vi.advanceTimersByTimeAsync(10_000); // past the 5s non-transient grace period too
    expect(deliverA2AMessage).toHaveBeenCalledTimes(1);
  });

  it('the note the Healer reads names the prompt size and the declared patience', async () => {
    vi.useFakeTimers();
    onAgentInjured(AGENT, PATIENCE_MSG, DECLARED_PATIENCE_EXCEEDED_CODE);
    await vi.advanceTimersByTimeAsync(10_000);
    const call = deliverA2AMessage.mock.calls.at(-1) as [{ payload: string }] | undefined;
    expect(call).toBeDefined();
    const payload = call![0].payload;
    expect(payload).toContain('92000 estimated prompt tokens');
    expect(payload).toContain('300000ms first-chunk patience');
  });

  it('CONTROL: a genuine transient (ECONNRESET) still gets its free auto-wake retry', async () => {
    // P3's carve-out is for a declared-patience exhaustion specifically — a dropped connection
    // is exactly the case the auto-wake exists for, and it must be untouched by this task.
    vi.useFakeTimers();
    onAgentInjured(AGENT, 'fetch failed: ECONNRESET');
    await vi.advanceTimersByTimeAsync(6_000);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: a plain mid-stream idle timeout (no declared-patience marker) also still auto-wakes', async () => {
    // The other half of the same scope line: T81a must not widen the skip beyond the
    // first-chunk/declared-patience case into the genuinely-idle one.
    vi.useFakeTimers();
    onAgentInjured(
      AGENT,
      'model stream idle timeout: no data from provider for too long (elapsed 300ms)',
      'stream_idle_timeout',
    );
    await vi.advanceTimersByTimeAsync(6_000);
    expect(handleMessage).toHaveBeenCalledTimes(1);
  });
});
