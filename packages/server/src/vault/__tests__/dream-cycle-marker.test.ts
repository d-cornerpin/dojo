// ════════════════════════════════════════
// P2a: dream cycle in-flight marker (once-per-night cadence gate)
//
// Owner rule (2026-07-17): "dreamer cycles are once per night". The mid-day
// continuation sweep exists ONLY to recover a STALLED nightly cycle, never to
// START a new drain for archives produced during the day. These tests cover:
//   (1) runDreamerContinuationSweep no-ops when the marker is CLOSED, even with
//       unprocessed archives present and the Dreamer idle (the cadence fix);
//   (2) the marker set/clear lifecycle, including that it is DB-persisted (the
//       flag must survive a restart, FA-V4's whole point);
//   (+) when the marker is OPEN but nothing non-trivial remains (a finalize that
//       leaked the marker), the sweep finalizes and clears it instead of spinning.
//
// Test (3) from the brief (the loop.ts scaffold-trigger skip for the Dreamer)
// is NOT unit-testable here: both trigger sites live deep inside the v2 turn
// loop (loop.ts), guarded by `!isDreamerAgent(agentId)` amid model calls, the
// runtime, streaming, and DB writes. Exercising them needs the full loop
// harness. The skip's decision kernel is the `isDreamerAgent` predicate (config/
// platform.ts), which is outside this file's territory and already exists.
// ════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { VaultConversation } from '../store.js';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

// Fixed identities so the sweep resolves a primary + Dreamer without the real
// config lookups (which would need the platform config seeded).
vi.mock('../../config/platform.js', () => ({
  getPrimaryAgentId: () => 'primary',
  getDreamerAgentId: () => 'dreamer',
  getDreamerAgentName: () => 'Dreamer',
  isSetupCompleted: () => true,
}));

// Heavy collaborators pulled in at module load; stubbed so importing maintenance
// stays hermetic. None are exercised by the marker-gate path under test.
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/spawner.js', () => ({ spawnAgent: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock('../../agent/v2/counterparty.js', () => ({ rehomeUnclaimedEngineEvents: vi.fn() }));

// The store is the archive/report boundary. getUnprocessedConversations is the
// first archive-touching call the sweep makes AFTER the marker gate, so its call
// count is the clean observable for whether the gate let execution through.
const store = vi.hoisted(() => ({
  getUnprocessedConversations: vi.fn(),
  getVaultStats: vi.fn(() => ({ totalEntries: 0, pinnedCount: 0, permanentCount: 0 })),
  createDreamReport: vi.fn(),
  getConversation: vi.fn(() => null),
  incrementArchiveAttempt: vi.fn(() => 1),
  markArchivePoisoned: vi.fn(),
  markConversationProcessed: vi.fn(),
}));
vi.mock('../store.js', () => store);

import { activeRuns, pendingWakeups } from '../../agent/shared-state.js';
import {
  isDreamCycleOpen,
  setDreamCycleOpen,
  runDreamerContinuationSweep,
} from '../maintenance.js';

// A genuinely non-trivial archive (substantive user + assistant prose, so
// classifyTrivial keeps it). Used to prove the CLOSED-marker sweep no-ops even
// though there IS real work waiting.
function makeNonTrivialConversation(): VaultConversation {
  const messages = JSON.stringify([
    {
      role: 'user',
      content:
        'We need to redesign the onboarding flow so a new user can connect their calendar ' +
        'and mailbox in the first session without hitting the permission wall. Outline the ' +
        'concrete steps and the order to ship them in.',
    },
    {
      role: 'assistant',
      content:
        'Here is the plan. First, split the OAuth consent into per-service cards so calendar ' +
        'and mail are granted independently. Second, defer the mailbox scope until the user ' +
        'opens the inbox panel. Third, add a skip option that still lets them finish setup.',
    },
  ]);
  return {
    id: 'conv-nontrivial-1',
    agentId: 'primary',
    agentName: 'Primary',
    messages,
    messageCount: 2,
    tokenCount: 400,
    earliestAt: '2026-07-17T09:00:00Z',
    latestAt: '2026-07-17T09:05:00Z',
    isProcessed: false,
    processedAt: null,
    attempts: 0,
    poisoned: false,
    createdAt: '2026-07-17T09:05:00Z',
  };
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      status TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  // Idle Dreamer, so the sweep's activeRuns/status checks never short-circuit
  // for a reason OTHER than the marker gate under test.
  db.prepare("INSERT INTO agents (id, status, updated_at) VALUES ('dreamer', 'idle', datetime('now'))").run();
  mockDb.current = db;

  activeRuns.clear();
  pendingWakeups.clear();
  vi.clearAllMocks();
});

describe('dream cycle marker lifecycle (P2a)', () => {
  it('defaults to CLOSED when no config row has been written', () => {
    expect(isDreamCycleOpen()).toBe(false);
  });

  it('opens on set(true) and closes on set(false)', () => {
    setDreamCycleOpen(true);
    expect(isDreamCycleOpen()).toBe(true);

    setDreamCycleOpen(false);
    expect(isDreamCycleOpen()).toBe(false);
  });

  it('is DB-persisted so it survives a restart (config row, not in-memory)', () => {
    setDreamCycleOpen(true);
    // The value lives in the config table, not process memory: a fresh read
    // (as after a restart re-opening the same DB) still sees it open.
    const row = mockDb.current!
      .prepare("SELECT value FROM config WHERE key = 'dream_cycle_open'")
      .get() as { value: string } | undefined;
    expect(row?.value).toBe('1');
    expect(isDreamCycleOpen()).toBe(true);
  });
});

describe('runDreamerContinuationSweep marker gate (P2a)', () => {
  it('no-ops when the marker is CLOSED even with unprocessed archives + idle Dreamer', async () => {
    // Marker closed (default). Real work is waiting and the Dreamer is idle: the
    // ONLY thing that must stop the sweep is the once-per-night cadence gate.
    store.getUnprocessedConversations.mockReturnValue([makeNonTrivialConversation()]);
    expect(isDreamCycleOpen()).toBe(false);

    await runDreamerContinuationSweep();

    // The gate returns before any archive is inspected: no drain is started.
    expect(store.getUnprocessedConversations).not.toHaveBeenCalled();
    expect(store.markConversationProcessed).not.toHaveBeenCalled();
    // The sweep never opens the marker itself (only the nightly cycle may).
    expect(isDreamCycleOpen()).toBe(false);
  });

  it('proceeds past the gate when OPEN, and finalizes+clears a leaked marker when nothing remains', async () => {
    // A nightly cycle opened the marker; the Dreamer is idle and no non-trivial
    // archives remain (a finalize that leaked the marker, e.g. a mid-cycle
    // restart after the last batch filed). The sweep must close it, not spin.
    setDreamCycleOpen(true);
    store.getUnprocessedConversations.mockReturnValue([]);

    await runDreamerContinuationSweep();

    // Passed the gate (reached the archive query) ...
    expect(store.getUnprocessedConversations).toHaveBeenCalled();
    // ... and finalized the leaked-open cycle: report written, marker cleared.
    expect(store.createDreamReport).toHaveBeenCalledTimes(1);
    expect(isDreamCycleOpen()).toBe(false);
  });
});
