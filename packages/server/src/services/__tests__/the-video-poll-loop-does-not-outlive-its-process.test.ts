// ════════════════════════════════════════════════════════════════════════════════════════
// t126 — A `void`-ED POLL LOOP MUST NOT OUTLIVE THE PROCESS THAT STARTED IT.
//
// THE MEASURED DEFECT. `enqueueVideoJob`/`startVideoJobPoller` fired `pollLoop` with a bare
// `void` and nothing tied that loop to the process going down. The loop runs for up to thirty
// minutes and is ASLEEP in a 5–30s backoff for nearly all of them, so at shutdown — where
// `index.ts` calls `closeDb()` and exits — a loop that woke afterwards reached `getDb()` on a
// closed handle. The throw landed in the loop's own `catch`, whose `markFailed` calls `getDb()`
// AGAIN and threw the same error straight back out of the handler: the honest log path was
// skipped and the `void`-ed promise rejected with nobody listening.
//
// Measured before the fix, driven exactly as §1 drives it: `unhandledRejection: test DB not
// initialized`, one per surviving loop. That is what intermittently exited the full suite 1
// while reporting every test passed — the suite's teardown is just the cheapest shutdown to
// drive; the production path is the same two lines.
//
// THE LIFETIME IS OWNED, which is the fix the clauses hold:
//
//   §1 THE RED. A loop left mid-flight across a teardown rejects NOTHING, and its promise
//      actually SETTLES — the registry it took a slot from is empty again.
//   §2 The stop WAKES the loop; it does not wait out its remaining backoff first.
//   §3 A SHUTDOWN IS NOT A VERDICT. The exit writes no row and posts no apology — the render is
//      still running at the provider and the boot resume adopts it. This is the A-5 doctrine
//      (`cancelled` carries the owner's name; a process going down never earned it).
//   §4 The stop is a FENCE, and only a fresh boot lifts it.
//   §5 THE HONEST LOG PATH, proven independently of the lifetime: a throw from the loop's own
//      error path becomes a `logger.error` line, never an unhandled rejection.
//   §6 CONTROLS, so none of this can be satisfied by disabling the poller.
//
// No real provider is contacted: `globalThis.fetch` is stubbed in every clause.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { LogEntry } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', async () => {
  const osm = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || osm.tmpdir()), 'dojo-t126', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProviderCredential: () => 'test-key',
}));

vi.mock('../../agent/effects/fs.js', () => ({
  existsSync: () => true,
  mkdirSync: () => undefined,
  writeFileSync: () => undefined,
  copyFileSync: () => undefined,
  readFileSync: () => Buffer.alloc(0),
  statSync: () => ({ size: 1024 }),
}));

vi.mock('../../agent/v2/loop.js', () => ({ runV2Turn: vi.fn(async () => undefined) }));

import { runMigrations } from '../../db/migrations.js';
import { POLL_START_MS } from '../video-job-poller.js';

const AGENT = 't126-agent';
const MODEL = 'model-video';
const PROVIDER = 'prov-video';

let dials: string[] = [];
let rejections: unknown[] = [];
let logged: LogEntry[] = [];
const realFetch = globalThis.fetch;
const onRejection = (reason: unknown): void => { rejections.push(reason); };

const tick = (ms = 5) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * THE PHASE THE STOP LANDS IN IS CHOSEN, NOT HOPED FOR. The loop has two states a shutdown can
 * arrive in — on the wire, and asleep in its backoff — and they are guarded by two different
 * checks. An earlier draft of this file drove neither deliberately: it stopped the poller as
 * soon as a dial was RECORDED, which is mid-leg, so the mid-sleep guard was never exercised and
 * deleting it kept every clause green. The gate below holds a leg open until the clause lets it
 * go, and `untilSleeping` waits for the `attempt_count` write that happens immediately before
 * the sleep. One observable per phase, no timing guesses.
 */
let openGate: (() => void) | null = null;
let gate: Promise<void> | null = null;

function gateTheNextLeg(): void {
  gate = new Promise<void>((resolve) => { openGate = resolve; });
}

function releaseTheLeg(): void {
  openGate?.();
  gate = null;
  openGate = null;
}

function answerWith(handler: (url: string) => Response): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    dials.push(String(input));
    if (gate) await gate;        // the leg is now ON THE WIRE and stays there
    return handler(String(input));
  }) as unknown as typeof globalThis.fetch;
}

/** Drive until the loop is provably IN ITS BACKOFF SLEEP: `attempt_count` is written on the line
 *  after the poll returns and the line before the sleep, so a bump means "past the leg". */
async function untilSleeping(jobId: string, from = 0): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (attemptsOf(jobId) <= from && Date.now() < deadline) await tick(5);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/** Wait until the provider has been asked at least `n` times. Budgeted PAST one full backoff,
 *  because a second dial is a `POLL_START_MS` wait away and a tighter budget made the §6 control
 *  vacuous — it passed while only ever observing the first dial. */
async function untilDialled(n = 1): Promise<void> {
  const deadline = Date.now() + 3_000 + (n - 1) * (POLL_START_MS + 3_000);
  while (dials.length < n && Date.now() < deadline) await tick(5);
}

/**
 * DRIVEN, NOT SLEPT. A loop that has stood down has run its `finally`, which releases the slot
 * it registered — and `releaseAbortable` drops the agent's key when its last controller goes.
 * So "the registry no longer knows this agent" IS "the loop's promise settled and no timer of
 * its own is still pending", observed rather than waited out.
 */
async function untilLoopSettled(budgetMs = 4_000): Promise<number> {
  const started = Date.now();
  const { activeAbortControllers } = await import('../../agent/shared-state.js');
  while (Date.now() - started < budgetMs) {
    if (!activeAbortControllers.has(AGENT)) return Date.now() - started;
    await tick(5);
  }
  return Date.now() - started;
}

async function loopIsSettled(): Promise<boolean> {
  const { activeAbortControllers } = await import('../../agent/shared-state.js');
  return !activeAbortControllers.has(AGENT);
}

function queueJob(id = 'vid_t126'): string {
  mockDb.current!.prepare(`
    INSERT INTO video_jobs (id, agent_id, model_id, provider_id, provider_job_id, prompt, status, attempt_count, started_at)
    VALUES (?, ?, ?, ?, 'prov-job-t126', 'a cinematic render', 'polling', 0, datetime('now'))
  `).run(id, AGENT, MODEL, PROVIDER);
  return id;
}

function rowOf(jobId: string): { status: string; error: string | null } {
  return mockDb.current!.prepare('SELECT status, error FROM video_jobs WHERE id = ?')
    .get(jobId) as { status: string; error: string | null };
}

function attemptsOf(jobId: string): number {
  return (mockDb.current!.prepare('SELECT attempt_count FROM video_jobs WHERE id = ?')
    .get(jobId) as { attempt_count: number }).attempt_count;
}

function chatOf(agentId: string): string {
  const rows = mockDb.current!.prepare('SELECT content FROM messages WHERE agent_id = ?')
    .all(agentId) as Array<{ content: string }>;
  return rows.map((m) => m.content).join('\n');
}

function seed(): void {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type) VALUES (?, 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')`,
  ).run(PROVIDER);
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Video', 'api/video', '["video_generation"]', 1, 'second', 0)`,
  ).run(MODEL, PROVIDER);
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Fixture', 'idle', '1970-01-01')`,
  ).run(AGENT);
}

beforeEach(async () => {
  vi.resetModules();
  dials = [];
  rejections = [];
  logged = [];
  gate = null;
  openGate = null;
  process.on('unhandledRejection', onRejection);
  const { setLogBroadcast } = await import('../../logger.js');
  setLogBroadcast((entry) => { logged.push(entry); });
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seed();
});

afterEach(async () => {
  // The poller is asked to stand down FIRST — which is the very interlock under test, so every
  // clause here also exercises it — and only then are the fixtures torn down.
  try {
    const { stopVideoJobPoller } = await import('../video-job-poller.js');
    stopVideoJobPoller();
    await untilLoopSettled(2_000);
  } catch { /* a clause that never imported the module */ }
  process.off('unhandledRejection', onRejection);
  const { setLogBroadcast } = await import('../../logger.js');
  setLogBroadcast(() => undefined);
  releaseTheLeg();               // never leave a held leg behind for the next clause
  globalThis.fetch = realFetch;
  const s = await import('../../agent/shared-state.js');
  s.stoppedAgents.clear();
  s.activeRuns.clear();
  s.activeAbortControllers.clear();
  s.stopFencedRuns.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('§1 a loop left mid-flight across a teardown rejects nothing and actually settles', () => {
  it('THE RED: the DB goes away under a live poll loop and NOTHING rejects unhandled', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob, stopVideoJobPoller } = await import('../video-job-poller.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    await untilSleeping(jobId);    // the leg is done; the loop is now ASLEEP in its backoff

    // The shutdown, in the order `index.ts` performs it: ask the loops to stand down, then the
    // handle goes. Before the fix the loop woke after this and reached `getDb()` on a corpse.
    stopVideoJobPoller();
    mockDb.current!.close();
    const db = mockDb.current;
    mockDb.current = null;

    await untilLoopSettled();

    expect(rejections.map((r) => (r instanceof Error ? r.message : String(r))),
      'a poll loop that outlives its DB must not reject with nobody listening').toEqual([]);

    // AND IT STOOD DOWN CLEANLY, which is the stronger half. Anything at warn-or-above means the
    // loop reached a DB on a closed handle and unwound through its error path instead of
    // returning at a guard — the near-miss the old code turned into an unhandled rejection.
    expect(logged.filter((e) => e.level === 'warn' || e.level === 'error').map((e) => e.message),
      'a stand-down is silent: no guard was missed, nothing threw').toEqual([]);

    mockDb.current = db;           // hand afterEach something closeable
  }, 30_000);

  it('the loop\'s promise SETTLED — it released the slot it took, so nothing of it survives', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob, stopVideoJobPoller } = await import('../video-job-poller.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    await untilDialled();
    // Proof the observable is live rather than vacuously true: while the loop RUNS, the registry
    // knows it.
    expect(await loopIsSettled(), 'a running poll loop holds a registered slot').toBe(false);

    stopVideoJobPoller();
    await untilLoopSettled();

    expect(await loopIsSettled(),
      'after the stop the loop has run its finally: no promise and no timer of its own is left').toBe(true);
  }, 30_000);
});

describe('§1a the other phase: a shutdown that lands while a leg is ON THE WIRE', () => {
  it('stands down just as cleanly mid-leg, and still records no attempt', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob, stopVideoJobPoller } = await import('../video-job-poller.js');
    const jobId = queueJob();

    gateTheNextLeg();
    enqueueVideoJob(jobId);
    await untilDialled();          // dialled, and the leg is HELD open by the gate
    const attemptsAtStop = attemptsOf(jobId);

    stopVideoJobPoller();
    releaseTheLeg();               // the held leg now comes back, into a stopped poller
    await untilLoopSettled();

    expect(rejections, 'a stop landing mid-leg must not reject either').toEqual([]);
    expect(logged.filter((e) => e.level === 'warn' || e.level === 'error').map((e) => e.message),
      'and it returns at a guard rather than unwinding through the error path').toEqual([]);
    expect(attemptsOf(jobId),
      'the attempt UPDATE sits between the leg and the sleep — a stand-down must not reach it')
      .toBe(attemptsAtStop);
    expect(['queued', 'polling'], 'and the render is left alone').toContain(rowOf(jobId).status);
  }, 30_000);
});

describe('§1b a stopped loop asks the provider NOTHING MORE', () => {
  it('not one further dial after the stop — the exit is above the poll, not after it', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob, stopVideoJobPoller } = await import('../video-job-poller.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    await untilSleeping(jobId);
    const dialsAtStop = dials.length;

    stopVideoJobPoller();
    await untilLoopSettled();
    // Past a whole further backoff, so "no more dials" is a measured absence and not a budget
    // that simply ended early.
    const deadline = Date.now() + POLL_START_MS + 2_000;
    while (Date.now() < deadline) await tick(10);

    expect(dials.length - dialsAtStop,
      'a loop whose exit sits BELOW the poll burns one more provider call per stop').toBe(0);
  }, 40_000);
});

describe('§2 the stop WAKES the loop rather than being noticed a backoff later', () => {
  it('the loop stands down well inside its own backoff window, because the signal cuts the sleep', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob, stopVideoJobPoller } = await import('../video-job-poller.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    await untilDialled();

    stopVideoJobPoller();
    const tookMs = await untilLoopSettled();

    expect(await loopIsSettled(), 'the stop must actually end the loop').toBe(true);
    // One-directional and deliberately slack: the wake is synchronous with the abort, so this
    // only has to separate "woken" from "slept the backoff out". Seven lanes share this box.
    expect(tookMs, `a woken loop exits promptly, not after its ${POLL_START_MS}ms backoff`)
      .toBeLessThan(POLL_START_MS);
  }, 30_000);
});

describe('§3 a shutdown is not a verdict on the render', () => {
  it('the stood-down loop writes NO row — the job stays open for the boot resume', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob, stopVideoJobPoller } = await import('../video-job-poller.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    await untilSleeping(jobId);
    const attemptsAtStop = attemptsOf(jobId);
    stopVideoJobPoller();
    await untilLoopSettled();

    const row = rowOf(jobId);
    expect(['queued', 'polling'],
      'the provider is still rendering; a process going down may not close the job').toContain(row.status);
    expect(row.error, 'nothing failed, so nothing is recorded as a failure').toBeNull();
    // NOT EVEN A COUNTER BUMP. `attempt_count` is the finest-grained write the loop makes, so it
    // is the honest test of "the exit touches nothing" — and it is the one a shutdown landing
    // mid-leg would otherwise record, since the UPDATE sits between the poll and the sleep.
    expect(attemptsOf(jobId), 'a stand-down records no attempt against the job').toBe(attemptsAtStop);
  }, 30_000);

  it('and posts NO apology into the owner\'s chat — a shutdown never wears the owner\'s stop', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob, stopVideoJobPoller } = await import('../video-job-poller.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    await untilDialled();
    stopVideoJobPoller();
    await untilLoopSettled();

    expect(chatOf(AGENT), 'the owner is told nothing, because nothing happened to his render')
      .not.toMatch(/wasn't able to finish|timed out|Internal poller error/i);
  }, 30_000);

  it('the row it leaves open is one the boot resume actually ADOPTS — the exit is not a leak', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const poller = await import('../video-job-poller.js');
    const jobId = queueJob();

    poller.enqueueVideoJob(jobId);
    await untilDialled();
    poller.stopVideoJobPoller();
    await untilLoopSettled();

    // The contract §3 relies on: `startVideoJobPoller`'s scan sees this row. Asked of the census
    // rather than of a re-poll, so the clause does not depend on a second dial's timing.
    expect(poller.countActiveVideoJobs(),
      'a row left open must be one the next boot picks up, or standing down loses the render').toBeGreaterThan(0);
  }, 30_000);
});

describe('§4 the stop is a fence, and only a fresh boot lifts it', () => {
  it('a job enqueued after the stop does NOT start a loop', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob, stopVideoJobPoller, videoJobPollerStopped } = await import('../video-job-poller.js');
    stopVideoJobPoller();
    expect(videoJobPollerStopped()).toBe(true);

    const { activeAbortControllers } = await import('../../agent/shared-state.js');
    enqueueVideoJob(queueJob('vid_t126_fenced'));
    // SAMPLED SYNCHRONOUSLY, with no await in between, and that is the point: `openAgentCall`
    // runs before the loop's first await, so a fenced enqueue that got as far as taking a slot
    // would be visible RIGHT HERE and nowhere later — the slot is released again a tick later
    // and a post-drive check cannot tell the two apart. A slot also means an `announceLiveWork`
    // frame, i.e. the box claiming background work it is never going to do.
    expect(activeAbortControllers.has(AGENT),
      'a fenced enqueue must not even register a slot — it does not start at all').toBe(false);

    for (let i = 0; i < 40; i += 1) await tick(5);

    expect(dials, 'a stopped poller does not quietly resume polling on the next enqueue').toEqual([]);
    expect(await loopIsSettled(), 'and nothing of it is left registered').toBe(true);
  }, 30_000);

  it('and the fence holds after the DB itself is gone — a late enqueue is a silent no-op', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob, stopVideoJobPoller } = await import('../video-job-poller.js');
    const jobId = queueJob('vid_t126_late');

    // The real shutdown order, and the real late caller: `submitVideoJob` can enqueue from a
    // turn that is still unwinding while `index.ts` has already closed the handle. Without a
    // fence ABOVE the first `getJob`, that enqueue reaches `getDb()` on a corpse and the
    // detached loop logs an error for a job nobody asked it to touch.
    stopVideoJobPoller();
    const db = mockDb.current;
    mockDb.current!.close();
    mockDb.current = null;

    enqueueVideoJob(jobId);
    for (let i = 0; i < 40; i += 1) await tick(5);

    expect(rejections, 'a late enqueue must not reject').toEqual([]);
    expect(logged.filter((e) => e.level === 'warn' || e.level === 'error').map((e) => e.message),
      'a stopped poller declines the work silently — it does not touch the DB to find that out')
      .toEqual([]);
    expect(dials, 'and it certainly does not dial').toEqual([]);

    mockDb.current = db;
  }, 30_000);

  it('a fresh boot re-arms it — the fence is a process generation, not a permanent kill', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const poller = await import('../video-job-poller.js');
    poller.stopVideoJobPoller();
    queueJob('vid_t126_rearm');

    poller.startVideoJobPoller();          // the boot resume adopts the open row
    await untilDialled();

    expect(poller.videoJobPollerStopped(), 'a boot lifts the fence').toBe(false);
    expect(dials.some((u) => u.includes('/videos/prov-job-t126')),
      'and the re-armed poller actually resumes the open render').toBe(true);
  }, 30_000);
});

describe('§5 the honest log path: a throw from the loop is a log line, never an unhandled rejection', () => {
  it('the DB goes away WITHOUT a stop — the loop\'s own error path throws, and it is LOGGED', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    await untilDialled();

    // Deliberately NOT calling stopVideoJobPoller: this drives the backstop on its own. The loop
    // wakes into a closed handle, its `catch` runs, and `markFailed` inside that `catch` throws
    // the same error back out of the handler — the exact shape that used to reject unhandled.
    const db = mockDb.current;
    mockDb.current!.close();
    mockDb.current = null;

    for (let i = 0; i < 400 && !logged.some((e) => e.level === 'error'); i += 1) await tick(10);

    expect(rejections.map((r) => (r instanceof Error ? r.message : String(r))),
      'a detached loop routes its own failures to the log, not to unhandledRejection').toEqual([]);
    expect(logged.filter((e) => e.level === 'error').map((e) => e.message).join('\n'),
      'and the failure is actually reported rather than swallowed').toMatch(/poll loop rejected outside its own handler/i);

    mockDb.current = db;
  }, 40_000);
});

describe('§6 controls — none of the above is satisfiable by disabling the poller', () => {
  it('CONTROL: an un-stopped poller still polls a living render and leaves it open', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    await untilDialled(2);          // it kept polling, not just dialled once
    expect(dials.length, 'the control must really observe a SECOND poll, or it proves nothing').toBeGreaterThanOrEqual(2);

    const row = rowOf(jobId);
    expect(['queued', 'polling'], 'a living render keeps being polled').toContain(row.status);
    expect(row.error).toBeNull();
  }, 30_000);

  it('CONTROL: an un-stopped poller still delivers a completed render', async () => {
    answerWith((url) => (url.includes('/content')
      ? new Response(new Uint8Array([0, 0, 0, 24]), { status: 200, headers: { 'content-type': 'video/mp4' } })
      : json({ status: 'completed', seconds: 8 })));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    for (let i = 0; i < 2000 && rowOf(jobId).status === 'polling'; i += 1) await tick(5);
    expect(rowOf(jobId).status, 'the lifetime interlock must not cost the delivery path').toBe('succeeded');
  }, 30_000);

  it('CONTROL: the owner\'s own stop still reads as HIS stop, not as a shutdown', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 40 }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const s = await import('../../agent/shared-state.js');
    const jobId = queueJob();

    enqueueVideoJob(jobId);
    await untilDialled();
    s.abortInFlight(AGENT, 'user-stop', { scope: 'all' });   // the real stop path (`runtime.ts`)

    for (let i = 0; i < 400 && rowOf(jobId).status === 'polling'; i += 1) await tick(5);

    expect(rowOf(jobId).status,
      'a user stop is still a cancel — the shutdown exit must not have swallowed it').toBe('cancelled');
  }, 30_000);
});
