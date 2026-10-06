// t109 item C — TWO ESCALATION SITES LOGGED "escalated to PM" REGARDLESS OF DELIVERY.
//
// BACKLOG (2026-10-05, t90 re-review 2 out-of-scope, pre-existing), verbatim: *"TWO ESCALATION
// SITES LOG 'escalated to PM' REGARDLESS OF DELIVERY: `tracker/pm-agent.ts:683–692`
// (closeout-miss) and `:781–791` (unattended-budget trip) `await deliverA2AMessage(…)` then
// `logger.info('… escalated')` without reading `res.delivered` — `AGENT_NOT_FOUND`
// (purged/deactivated assignee) and `PERSIST_SKIPPED` are reachable there. Same record-lie class
// the periodic re-drive just fixed (`b67cd244` is the template: read the result, warn with the
// reason, keep the record honest)."*
//
// Re-derived at this HEAD before the fix: both sites discarded the awaited result, and both
// `logger.info('… escalated to PM')` lines were unconditional. A DROP IS A RETURN, NOT A THROW
// (`a2a-transport.ts`'s `A2ADeliveryResult = { delivered, reason?, threadId }`), so the `.catch`
// wrapped around each site could never see one.
//
// EACH SITE GETS ITS OWN SECTION, and each section counts BOTH DIRECTIONS: a delivered send must
// still produce the "escalated" info line and NO warn, and a dropped send must produce the warn
// naming the transport's own reason and NOT the "escalated" line. A clause that only checked the
// drop would stay green if the fix silenced the happy path too.
//
// The transport spy answers in the transport's OWN result shape, which is the half of
// `b67cd244`'s template that mattered most: the always-`{delivered:true}` stub is exactly why
// this class of defect ships.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

/** The PM's own log is the only place a dropped escalation can be seen, so it is CAPTURED
 *  rather than silenced — the house pattern from
 *  `memory/__tests__/an-absent-embedder-is-one-warn-not-a-hundred-errors.test.ts`. */
const log = vi.hoisted(() => {
  const calls = { debug: [] as unknown[][], info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][] };
  return {
    calls,
    logger: {
      debug: (...a: unknown[]) => { calls.debug.push(a); },
      info: (...a: unknown[]) => { calls.info.push(a); },
      warn: (...a: unknown[]) => { calls.warn.push(a); },
      error: (...a: unknown[]) => { calls.error.push(a); },
    },
  };
});
vi.mock('../../logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../logger.js')>()),
  createLogger: () => log.logger,
}));

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
vi.mock('../../agent/agent-bus.js', () => ({ sendAgentMessage: () => { /* no-op */ } }));
vi.mock('../../agent/agent-notice.js', () => ({ postAgentNotice: () => { /* no-op */ } }));
vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: async () => { /* no-op */ } }),
}));
vi.mock('../../memory/message-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../memory/message-store.js')>()),
  insertEngineEventIfAbsent: () => null,
}));

/** `A2ADeliveryResult`'s own shape. `drops.next` makes exactly the NEXT call return a drop with
 *  the reason the backlog line names, which is how a RETURN rather than a throw is expressed. */
const drops = { next: null as string | null };
const deliverSpy = vi.fn(async (envelope?: unknown) => {
  const threadId = (envelope as { threadId?: string } | undefined)?.threadId ?? 'thread-unknown';
  const drop = drops.next;
  drops.next = null;
  return drop ? { delivered: false, reason: drop, threadId } : { delivered: true, threadId };
});
vi.mock('../../agent/a2a-transport.js', () => ({
  deliverA2AMessage: (...args: unknown[]) => deliverSpy(...args),
  makeThreadId: (seed: string) => `thread-${seed}`,
}));

import { escalateCloseoutMissToPM, escalateUnattendedBudgetTripToPM } from '../pm-agent.js';
import { clearPlatformConfigCache } from '../../config/platform.js';
import { createWorkTable, seedTrackerTask } from '../../work/__tests__/work-fixture.js';

const WORKER = 'worker-agent';
const PM_ID = 'pm-agent';
const TASK = 'task-dangling-1';

/** Every line the site emits, flattened to `{ message, meta }` — the logger is called as
 *  `(message, meta, agentId)`. */
function lines(level: 'info' | 'warn'): Array<{ message: string; meta: Record<string, unknown> }> {
  return log.calls[level].map((a) => ({
    message: String(a[0]),
    meta: (a[1] ?? {}) as Record<string, unknown>,
  }));
}
const matching = (level: 'info' | 'warn', needle: string) =>
  lines(level).filter((l) => l.message.includes(needle));

beforeEach(() => {
  mockDb.current?.close();
  const db = new Database(':memory:');
  mockDb.current = db;
  db.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)`);
  db.prepare(`INSERT INTO config (key, value) VALUES ('pm_agent_id', ?)`).run(PM_ID);
  db.exec(`CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT, status TEXT, model_id TEXT,
    updated_at TEXT, session_started_at TEXT)`);
  db.prepare(`INSERT INTO agents (id, name, status) VALUES (?, 'Worker', 'idle')`).run(WORKER);
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT, agent_id TEXT NOT NULL,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  createWorkTable(db);
  db.exec(`CREATE TABLE IF NOT EXISTS work_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, work_id TEXT NOT NULL, event TEXT NOT NULL,
    actor TEXT, detail TEXT, at INTEGER NOT NULL DEFAULT 0)`);
  seedTrackerTask(db, { id: TASK, title: 'ship the thing', agentId: WORKER, goal: 'ship it' });
  clearPlatformConfigCache();
  drops.next = null;
  deliverSpy.mockClear();
  for (const k of ['debug', 'info', 'warn', 'error'] as const) log.calls[k].length = 0;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 THE CLOSEOUT-MISS SITE
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the closeout-miss escalation', () => {
  const run = () => escalateCloseoutMissToPM({
    agentId: WORKER,
    danglingTaskIds: [TASK],
    agentText: 'all done, shipped it',
    source: 'pre-turn-gate',
  });

  it('a DELIVERED escalation still says it escalated, and warns about nothing', async () => {
    await run();
    expect(deliverSpy, 'precondition: the site did try to deliver').toHaveBeenCalledTimes(1);
    expect(matching('info', 'Closeout-miss escalated to PM').length,
      'the happy path keeps its record').toBe(1);
    expect(matching('warn', 'NOT delivered'),
      'nothing was dropped, so nothing is warned about').toEqual([]);
  });

  it('⚠ C: a DROPPED escalation is NOT recorded as escalated — it is warned, with the reason', async () => {
    drops.next = 'AGENT_NOT_FOUND';
    await run();

    expect(matching('info', 'Closeout-miss escalated to PM'),
      'the PM never received it, so the record may not claim it did').toEqual([]);
    const warns = matching('warn', 'Closeout-miss escalation to the PM was NOT delivered');
    expect(warns.length, 'said once, out loud').toBe(1);
    expect(warns[0].meta.reason, "and it names the transport's OWN reason").toBe('AGENT_NOT_FOUND');
    expect(warns[0].meta.pmId, 'and who it was for').toBe(PM_ID);
    expect(warns[0].meta.agentId, 'and whose close-out went unreviewed').toBe(WORKER);
  });

  it('PERSIST_SKIPPED is the same answer — the reason rides, the record does not lie', async () => {
    drops.next = 'PERSIST_SKIPPED';
    await run();
    expect(matching('info', 'Closeout-miss escalated to PM')).toEqual([]);
    const warns = matching('warn', 'Closeout-miss escalation to the PM was NOT delivered');
    expect(warns.length).toBe(1);
    expect(warns[0].meta.reason).toBe('PERSIST_SKIPPED');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 THE UNATTENDED-BUDGET TRIP SITE
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the unattended-budget trip escalation', () => {
  const run = () => escalateUnattendedBudgetTripToPM({
    agentId: WORKER,
    budgetMinutes: 60,
    continuationCap: 3,
    elapsedMinutes: 60,
    declaredByProvider: false,
  });

  it('a DELIVERED hand-off still says it escalated, and warns about nothing', async () => {
    await run();
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(matching('info', 'Unattended-budget trip escalated to PM').length).toBe(1);
    expect(matching('warn', 'NOT delivered')).toEqual([]);
  });

  it('⚠ C: a DROPPED hand-off is warned with its reason, and never recorded as escalated', async () => {
    drops.next = 'AGENT_NOT_FOUND';
    await run();

    expect(matching('info', 'Unattended-budget trip escalated to PM'),
      'nobody is holding this turn, and the record says so').toEqual([]);
    const warns = matching('warn', 'Unattended-budget trip escalation to the PM was NOT delivered');
    expect(warns.length, 'said once, out loud').toBe(1);
    expect(warns[0].meta.reason).toBe('AGENT_NOT_FOUND');
    expect(warns[0].meta.pmId).toBe(PM_ID);
    expect(warns[0].meta.agentId).toBe(WORKER);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 THE WIRE CLAUSE — BOTH DIRECTIONS, AND IT COUNTS
// ════════════════════════════════════════════════════════════════════════════════════════
//
// A presence-only clause ("the file mentions `res.delivered`") stays green when a THIRD
// escalation site is added that forgets to read its result, which is the whole shape of this
// defect. So this counts instead: every `deliverA2AMessage(` call in `pm-agent.ts` must bind
// its result, and the count of bindings must equal the count of calls. Comments are stripped
// first, so the prose above a call cannot satisfy it (G4).

describe('§3 every delivery in pm-agent.ts reads its own result', () => {
  it('the count of `deliverA2AMessage(` calls equals the count that bind a result', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, '..', 'pm-agent.ts'), 'utf8')
      // strip block comments, then line comments — a call SHAPE quoted in prose must not count
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    const calls = [...src.matchAll(/deliverA2AMessage\(/g)].length;
    // Either `const <name> = await deliverA2AMessage(` (the awaited form) or
    // `deliverA2AMessage({…}).then(res => …)` (the thenable form the poke loop uses). Both
    // bind the result; a bare `await deliverA2AMessage(` binds nothing and is the defect.
    const bound =
      [...src.matchAll(/(?:const|let)\s+\w+\s*=\s*await\s+deliverA2AMessage\(/g)].length +
      [...src.matchAll(/deliverA2AMessage\([\s\S]{0,4000}?\}\)\s*\.then\(/g)].length;

    expect(calls, 'precondition: the sites still exist').toBeGreaterThanOrEqual(3);
    expect(bound, `every one of the ${calls} deliveries must bind its result`).toBe(calls);
    expect(src, 'and the bare discarding form may not come back')
      .not.toMatch(/^\s*await deliverA2AMessage\(/m);
  });
});
