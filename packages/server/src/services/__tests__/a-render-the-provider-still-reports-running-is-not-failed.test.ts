// ════════════════════════════════════════════════════════════════════════════════════════
// t114 (U4) — THE PROVIDER IS ASKED BEFORE THE CLOCK IS BELIEVED.
//
// `video-job-poller.ts` carried a wall-clock guard that force-failed the job ONE LINE above
// `pollProviderVideo`. The measured fact — the provider's own `status`, and the `progress`
// percentage reported beside it — was fetched on the very next line, and the clock pre-empted
// it. Because `startVideoJobPoller` only resumes rows in `('queued','polling')`, `failed` is
// TERMINAL: a render the provider finished two minutes after the wall had its asset dropped on
// the floor and the owner was billed for a video they never saw.
//
// THE BACKWARDS LIFECYCLE, both directions, which is the standing order for a timer fix:
//
//   §1 HEALTHY WORK IS DRIVEN INTO THE TIMER'S WINDOW AND MUST SURVIVE. A job 45 minutes old —
//      a quarter-hour PAST the 30-minute wall — whose provider answers `in_progress`. The
//      provider's answer is positive proof the work is alive, so it outranks the clock.
//
//   §2 DEAD WORK IS DRIVEN IN AND THE TIMER MUST STILL FIRE, LOUDLY AND HONESTLY. Same age,
//      but the provider answers nothing usable (a transient 503 every leg). Now there is no
//      evidence either way, the window has elapsed, and the job is as dead as we can prove.
//      The kill must name the ABSENCE OF EVIDENCE and carry the last poll error — not the old
//      fiction that "the provider did not finish".
//
//   §3 THE BILLED-AND-LOST CASE, which is the owner-facing point of the whole fix: a render
//      that COMPLETES past the wall is delivered, not discarded.
//
//   §4/§5 CONTROLS, so the clause cannot be satisfied by deleting the timer. A provider that
//      says `failed` still fails the job; and a YOUNG job on the same transient error is NOT
//      failed, which is what proves the window is still doing work.
//
// No real provider is contacted: `globalThis.fetch` is stubbed in every clause.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || osm.tmpdir()), 'dojo-t114-u4', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => undefined }));

vi.mock('../../config/loader.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getProviderCredential: () => 'test-key',
}));

// Nothing here is about the filesystem; the effects facade is answered rather than driven.
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

const AGENT = 't114-u4-agent';
const MODEL = 'model-video';
const PROVIDER = 'prov-video';

let dials: string[] = [];
const realFetch = globalThis.fetch;

const tick = (ms = 10) => new Promise<void>((r) => setTimeout(r, ms));

function answerWith(handler: (url: string) => Response): void {
  globalThis.fetch = vi.fn(async (input: unknown) => {
    dials.push(String(input));
    return handler(String(input));
  }) as unknown as typeof globalThis.fetch;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

async function untilDialled(n = 1): Promise<void> {
  for (let i = 0; i < 200 && dials.length < n; i += 1) await tick(5);
}

/** Insert a video job whose `started_at` is `ageMinutes` in the past. */
function queueJobAged(ageMinutes: number): string {
  const id = `vid_t114_${ageMinutes}`;
  mockDb.current!.prepare(`
    INSERT INTO video_jobs (id, agent_id, model_id, provider_id, provider_job_id, prompt, status, attempt_count, started_at)
    VALUES (?, ?, ?, ?, 'prov-job-u4', 'a long cinematic render', 'polling', 0, datetime('now', ?))
  `).run(id, AGENT, MODEL, PROVIDER, `-${ageMinutes} minutes`);
  return id;
}

/** Poll the row until it leaves the active statuses, or give up. */
async function settledStatus(jobId: string, tries = 1200): Promise<string> {
  let status = '';
  for (let i = 0; i < tries; i += 1) {
    status = (mockDb.current!.prepare('SELECT status FROM video_jobs WHERE id = ?')
      .get(jobId) as { status: string }).status;
    if (status !== 'queued' && status !== 'polling') break;
    await tick(5);
  }
  return status;
}

function rowOf(jobId: string): { status: string; error: string | null } {
  return mockDb.current!.prepare('SELECT status, error FROM video_jobs WHERE id = ?')
    .get(jobId) as { status: string; error: string | null };
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
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Quill', 'idle', '1970-01-01')`,
  ).run(AGENT);
}

beforeEach(() => {
  vi.resetModules();
  dials = [];
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seed();
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  const s = await import('../../agent/shared-state.js');
  s.stoppedAgents.clear();
  s.activeRuns.clear();
  s.activeAbortControllers.clear();
  s.stopFencedRuns.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

describe('§1 healthy work driven PAST the wall survives, because the provider says it is alive', () => {
  it('THE RED: a 45-minute-old render the provider still reports in_progress is NOT failed', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 72 }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJobAged(45);

    enqueueVideoJob(jobId);
    await untilDialled();
    await tick(60);

    const row = rowOf(jobId);
    expect(['queued', 'polling'], 'a provider reporting in_progress outranks the 30-minute wall').toContain(row.status);
    expect(row.error, 'a living render has no error to record').toBeNull();
  });

  it('the provider was ACTUALLY ASKED — the clock no longer pre-empts the poll', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 10 }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJobAged(45);

    enqueueVideoJob(jobId);
    await untilDialled();

    // The defect's signature was that NO poll ever happened for an over-age row: it was failed
    // on the line above the dial. One recorded dial to the provider's job URL is the proof.
    expect(dials.some((u) => u.includes('/videos/prov-job-u4')), 'the provider must be asked before any verdict').toBe(true);
  });

  it('no apology is posted into the owner\'s chat for a render that is still running', async () => {
    answerWith(() => json({ status: 'in_progress', progress: 50 }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJobAged(45);

    enqueueVideoJob(jobId);
    await untilDialled();
    await tick(60);

    const said = mockDb.current!.prepare('SELECT content FROM messages WHERE agent_id = ?')
      .all(AGENT) as Array<{ content: string }>;
    expect(said.map((m) => m.content).join('\n')).not.toMatch(/wasn't able to finish|timed out/i);
  });
});

describe('§2 dead work driven into the window still fires the timer, loudly and honestly', () => {
  it('THE OTHER DIRECTION: past the wall with NO usable provider answer, the job is failed', async () => {
    answerWith(() => json({ error: 'upstream unavailable' }, 503));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJobAged(45);

    enqueueVideoJob(jobId);
    const status = await settledStatus(jobId);

    expect(status, 'absence of evidence past the window is the one case the clock may end').toBe('failed');
  });

  it('the kill is HONEST: it names the absence of evidence and carries the last poll error', async () => {
    answerWith(() => json({ error: 'upstream unavailable' }, 503));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJobAged(45);

    enqueueVideoJob(jobId);
    await settledStatus(jobId);

    const row = rowOf(jobId);
    expect(row.error, 'the exit reason states what was actually observed — no usable answer').toMatch(/no usable answer/i);
    expect(row.error, 'and it carries the evidence it is based on').toMatch(/503/);
    expect(row.error, 'the old fiction is gone: we never observed the provider "not finishing"')
      .not.toMatch(/provider did not finish/i);
  });
});

describe('§3 the billed-and-lost case: a render that completes past the wall is delivered', () => {
  it('a completion arriving after 45 minutes is fetched and succeeds, not discarded', async () => {
    answerWith((url) => (url.includes('/content')
      ? new Response(new Uint8Array([0, 0, 0, 24]), { status: 200, headers: { 'content-type': 'video/mp4' } })
      : json({ status: 'completed', seconds: 8 })));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJobAged(45);

    enqueueVideoJob(jobId);
    const status = await settledStatus(jobId);

    expect(status, 'the owner paid for this render; past the wall is not a reason to drop it').toBe('succeeded');
  });
});

describe('§4/§5 controls — the window and the provider verdict both still bite', () => {
  it('CONTROL: a provider that reports `failed` still fails the job, with its own reason', async () => {
    answerWith(() => json({ status: 'failed', error: 'model refused the prompt' }));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJobAged(45);

    enqueueVideoJob(jobId);
    const status = await settledStatus(jobId);

    expect(status).toBe('failed');
    expect(rowOf(jobId).error, 'the provider\'s verdict is reported as the provider\'s, not as a timeout')
      .toMatch(/model refused the prompt/);
  });

  it('CONTROL: a YOUNG job on the same transient error is NOT failed — the window still governs', async () => {
    answerWith(() => json({ error: 'upstream unavailable' }, 503));
    const { enqueueVideoJob } = await import('../video-job-poller.js');
    const jobId = queueJobAged(1);

    enqueueVideoJob(jobId);
    await untilDialled();
    await tick(60);

    const row = rowOf(jobId);
    expect(['queued', 'polling'], 'inside the window a transient error is retried, never fatal').toContain(row.status);
    expect(row.error, 'a retrying job has recorded no failure').toBeNull();
  });
});
