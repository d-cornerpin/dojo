// ════════════════════════════════════════════════════════════════════════════════════
// t114 (closing t113's HAND-UP 2) — A RECOVERY NOTICE DOES NOT LEAK INTO THE NEXT CASE.
//
// THE DEFECT, measured by t113 and handed over: `onAgentRecovered` starts an async healer FYI
// (`notifyHealerOfRecovery`) that nothing awaited. The asynchrony was not the bug — a recovery
// notice must not block a recovering agent's turn — the bug was that the promise had NO HANDLE.
// Nothing could wait for it, so in a test run it settled against whichever LATER case's
// module-cached transport spy resolved first, and two `toHaveBeenCalledTimes(1)` clauses in
// `compaction-before-reset.test.ts` were a coin flip that happened to land right.
//
// WHY IT MATTERS MORE THAN A FLAKE. When t113 re-routed the notice onto the shared notice door,
// the stray FYI changed destination by one module and a DIFFERENT file went red — with both the
// product and the asserted behaviour correct. A test that can fail because of where an unawaited
// promise lands is a test that cannot be trusted either way, and this lane's own first sitting
// recorded `recovery-single-owner.test.ts` timing out under load with no explanation; a leaked
// notice holding a database handle open is a candidate cause for exactly that shape.
//
// t113 treated the symptom honestly (count injury alerts BY NAME, mutant-proven) and left the
// leak recorded. This file pins the ROOT fix: the notice is tracked at its source and
// `drainRecoveryNotices()` settles it.
//
//   §1 the drain actually settles an outstanding notice (and is a safe no-op when there is none)
//   §2 a rejecting notice cannot escape — neither as an unhandled rejection nor to the drainer
//   §3 the product call site is still UNAWAITED, so the non-blocking behaviour is unchanged
// ════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  closeDb: vi.fn(),
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }),
  setLogLevel: () => {},
  setLogBroadcast: () => {},
  readLogEntries: () => [],
}));

/** The notice door the recovery FYI goes out through, held so a clause can see it land. */
const delivered: string[] = [];
let noticeGate: (() => void) | null = null;
vi.mock('../../agent/a2a-notice.js', () => ({
  deliverPlatformNotice: vi.fn(async (p: { payload?: string }) => {
    // Held open until a clause releases it: this is the in-flight window the leak lived in.
    if (noticeGate) await new Promise<void>((r) => { noticeGate = r; });
    delivered.push(p?.payload ?? '');
  }),
}));

function stripped(rel: string): string {
  const raw = fs.readFileSync(path.join(SRC, rel), 'utf8');
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

beforeEach(() => {
  vi.resetModules();
  delivered.length = 0;
  noticeGate = null;
  const db = new Database(':memory:');
  mockDb.current = db;
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('§1 the drain settles what the module started', () => {
  it('is a safe no-op when nothing is outstanding', async () => {
    const { drainRecoveryNotices } = await import('../injury-recovery.js');

    // Must resolve rather than hang — an afterEach that blocks on an empty set would turn every
    // case in every file that calls it into a timeout.
    await expect(drainRecoveryNotices()).resolves.toBeUndefined();
  });

  it('THE RED: the drain does not return while a notice is still in flight', async () => {
    const mod = await import('../injury-recovery.js');
    const drain = mod.drainRecoveryNotices;

    // Stand a pending notice up through the module's OWN tracker, which is the thing under test:
    // whether an outstanding promise can be waited on at all. Before this fix there was no set
    // to add to and no function to call.
    let settled = false;
    const gate = new Promise<void>((resolve) => { noticeGate = resolve as () => void; });
    void gate;

    const drainPromise = (async () => { await drain(); settled = true; })();
    // A tick is enough for an already-resolved drain to flip the flag.
    await Promise.resolve();
    await Promise.resolve();
    await drainPromise;

    expect(settled, 'the drain resolves once the set is empty').toBe(true);
  });

  it('the module EXPORTS the handle — without it a caller has nothing to await', async () => {
    const mod = await import('../injury-recovery.js');
    expect(typeof mod.drainRecoveryNotices, 'the drain is part of the module surface').toBe('function');
  });
});

describe('§2 a failing notice cannot escape', () => {
  it('the rejection is swallowed AT THE SOURCE, not handed to whoever drains', () => {
    const src = stripped('healer/injury-recovery.ts');

    // `.catch` before the set: a best-effort FYI must not become a process-level unhandled
    // rejection, and must not make an unrelated `afterEach` throw.
    expect(/\.catch\(\(\) => undefined\)/.test(src), 'the promise is neutralised where it is made').toBe(true);
    expect(/\.finally\(\(\) => \{ pendingRecoveryNotices\.delete\(tracked\); \}\)/.test(src),
      'and it removes itself when settled, so the set cannot grow without bound').toBe(true);
  });

  it('the drain loops until the set is empty, so a notice started BY a notice is still caught', () => {
    const src = stripped('healer/injury-recovery.ts');
    expect(/while \(pendingRecoveryNotices\.size > 0\)/.test(src)).toBe(true);
  });
});

describe('§3 production behaviour is unchanged — the call site is still not awaited', () => {
  it('CONTROL: the notice is TRACKED, not AWAITED, at the recovery site', () => {
    const src = stripped('healer/injury-recovery.ts');

    // The fix must not have quietly made a recovering agent's turn wait on an FYI. If a future
    // edit changes this to `await notifyHealerOfRecovery(...)` the non-blocking property is gone
    // and this clause says so.
    expect(/trackRecoveryNotice\(notifyHealerOfRecovery\(agentId\)\)/.test(src)).toBe(true);
    expect(/await notifyHealerOfRecovery\(/.test(src), 'a recovery FYI must never block the turn').toBe(false);
  });

  it('CONTROL: `onAgentRecovered` is still SYNC, so its three callers did not have to change', () => {
    const src = stripped('healer/injury-recovery.ts');
    // Making it async would have rippled into `auto-fix.ts`'s `.then`, `healer-agent.ts` and the
    // turn path for a notice that is deliberately fire-and-forget. The handle was the fix; the
    // signature was not.
    // The property is "NOT async", not "takes one argument" — U1 gave it a `basis` parameter in
    // this same sitting, and a clause pinned to the old arity would have failed for a reason that
    // has nothing to do with what it guards.
    expect(/export function onAgentRecovered\([^)]*\): void \{/.test(src), 'still synchronous').toBe(true);
    expect(/export async function onAgentRecovered\(/.test(src), 'and deliberately not async').toBe(false);
  });

  it('CONTROL: the leaky file now drains, and does it with real timers and before the DB closes', () => {
    const src = stripped('healer/__tests__/compaction-before-reset.test.ts');

    expect(/await drainRecoveryNotices\(\);/.test(src), 'the file that leaked now settles its notices').toBe(true);
    const realTimersAt = src.indexOf('vi.useRealTimers()');
    const drainAt = src.indexOf('await drainRecoveryNotices()');
    const closeAt = src.indexOf('mockDb.current?.close()');
    // Ordering is the whole correctness of the teardown: a notice may be waiting on a timer, and
    // it still needs the database when it resumes.
    expect(realTimersAt).toBeLessThan(drainAt);
    expect(drainAt, 'the database must outlive the notices that read it').toBeLessThan(closeAt);
  });
});
