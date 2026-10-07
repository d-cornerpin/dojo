// ════════════════════════════════════════════════════════════════════════════════════════
// t122 — AN ABANDONED JOB ROW DOES NOT FAKE LIVE WORK.
//
// THE REGRESSION, as the owner met it minutes after an upgrade: every agent he opened offered
// the stop control while its own card correctly read `idle`. Nothing was running. The rows said
// so. `agent/live-work.ts` had just become the first reader of `generation_jobs` and
// `video_jobs`, and a box that has been running for months carries non-terminal rows abandoned
// by crashes and by versions that predate that read — one row, one permanent phantom button.
//
// THE CLAUSES COUNT BOTH WAYS, which is the only way this file is worth having:
//   §1  A ROW NOBODY OWNS IS NOT WORK — the planted stale rows stop being counted, and the
//       REAL dashboard rule (`dashboard/src/lib/stop-affordance.ts`) then offers no button.
//   §2  A ROW SOMEBODY OWNS IS STILL WORK — a job written in THIS process survives the sweep
//       and is still counted, and the button is still offered. A sweep that passes §1 by
//       closing everything fails here.
//   §3  ONCE, AND ONLY AT BOOT — the second call is refused, because by then live jobs exist
//       and the "no owning process" argument that licenses the sweep is no longer true.
//   §4  THE VIDEO CONTRACT SURVIVES IT — a row with a provider render behind it is left for
//       `startVideoJobPoller` to adopt. Failing it here would re-create t114/U4: `failed` is
//       terminal, the resume skips it, the asset is never fetched, the owner is billed.
//   §5  THE VOCABULARY — a status word neither table's lifecycle mentions is treated as OPEN
//       by the reader and swept by the sweep, in both directions.
//   §6  THE GROWN-BOX FIXTURE — the owner's exact shape, as a fixture: old stale rows, idle
//       agents, nothing running. This is the construction lesson the campaign keeps relearning
//       (a defect that only exists on a body with a history cannot be found on a fresh one),
//       and this clause is what makes THIS regression red forever.
//   §7  THE WIRE, both ways — boot calls the reconciliation, and calls it BEFORE either
//       adopter, which is the whole argument for why the sweep is sound.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_TS = path.resolve(HERE, '../../index.ts');

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
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t122', 'dojo.db'),
  };
});
// The frame is the composer's ONLY clearing edge, so the broadcaster RECORDS rather than swallows.
const frames: Array<Record<string, unknown>> = [];
vi.mock('../../gateway/ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../db/migrations.js';
import { liveWork, hasLiveWork } from '../../agent/live-work.js';
import {
  reconcileOrphanedJobsAtBoot, sweepAbandonedJobRows, resetBootReconciliationForTests,
  ABANDONED_AT_BOOT,
} from '../job-orphans.js';
import { stopAffordance } from '../../../../dashboard/src/lib/stop-affordance.js';

const AGENT = 'agent-t122-one';
const AGENT_B = 'agent-t122-two';
const MODEL = 'model-t122';
const PROVIDER = 'prov-t122';

const db = (): Database.Database => mockDb.current!;

function seed(): void {
  db().prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type) VALUES (?, 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')`,
  ).run(PROVIDER);
  db().prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Media', 'api/media', '["audio_generation","video_generation"]', 1, 'token', 0)`,
  ).run(MODEL, PROVIDER);
  for (const id of [AGENT, AGENT_B]) {
    db().prepare(
      `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, `Agent ${id.slice(-3)}`);
  }
}

/** A run-once media job row, in whatever state a dead process left it. */
function genJob(id: string, status: string, agentId = AGENT, kind = 'image'): string {
  db().prepare(
    `INSERT INTO generation_jobs (id, kind, agent_id, model_id, provider_id, prompt, status, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'a teapot orbiting a lighthouse', ?, '2026-01-02 03:04:05', '2026-01-02 03:04:05')`,
  ).run(id, kind, agentId, MODEL, PROVIDER, status);
  return id;
}

/** A video job row. `providerJobId: null` is the one a boot resume cannot adopt. */
function vidJob(id: string, status: string, providerJobId: string | null, agentId = AGENT): string {
  db().prepare(
    `INSERT INTO video_jobs (id, agent_id, model_id, provider_id, provider_job_id, prompt, status, started_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'a lighthouse at dusk', ?, '2026-01-02 03:04:05', '2026-01-02 03:04:05')`,
  ).run(id, agentId, MODEL, PROVIDER, providerJobId, status);
  return id;
}

const rowOf = (table: 'generation_jobs' | 'video_jobs', id: string): { status: string; error: string | null } =>
  db().prepare(`SELECT status, error FROM ${table} WHERE id = ?`).get(id) as { status: string; error: string | null };

/** The agent as the card's rule sees it: idle status, live counts from the one predicate. */
const subject = (agentId = AGENT) => ({ status: 'idle', inFlight: liveWork(agentId) });

const jobsFrames = () => frames.filter((f) => f.type === 'agent:jobs');

/** The source with comments stripped — a clause satisfiable by the prose above a call is a
 *  clause about the prose (G4). */
const code = (file: string): string => fs.readFileSync(file, 'utf-8')
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('//'))
  .join('\n');

beforeEach(() => {
  frames.length = 0;
  resetBootReconciliationForTests();
  const d = new Database(':memory:');
  d.pragma('foreign_keys = ON');
  mockDb.current = d;
  runMigrations();
  seed();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

// ── §1 ──────────────────────────────────────────────────────────────────────────────────

describe('§1 a row nobody owns is not work', () => {
  it('counts as live work BEFORE the sweep — the regression, reproduced', () => {
    genJob('g-stale', 'queued');
    // This is what the owner saw: an idle agent with something to stop.
    expect(liveWork(AGENT).background, 'the regression did not reproduce').toBe(1);
    expect(hasLiveWork(liveWork(AGENT))).toBe(true);
    expect(stopAffordance(subject()).show).toBe(true);
  });

  it('is closed by the sweep, marked failed with the reason, and never deleted', () => {
    genJob('g-stale', 'queued');
    genJob('g-stale-2', 'running', AGENT, 'audio');

    const moved = reconcileOrphanedJobsAtBoot();

    expect(moved.map((j) => j.id).sort()).toEqual(['g-stale', 'g-stale-2']);
    // The record STAYS. A sweep that deletes destroys the evidence of its own necessity.
    expect(db().prepare('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 2 });
    for (const id of ['g-stale', 'g-stale-2']) {
      expect(rowOf('generation_jobs', id)).toEqual({ status: 'failed', error: ABANDONED_AT_BOOT });
    }
  });

  it('and then the REAL dashboard rule offers no stop button at all', () => {
    genJob('g-stale', 'queued');
    reconcileOrphanedJobsAtBoot();

    expect(liveWork(AGENT).background).toBe(0);
    expect(hasLiveWork(liveWork(AGENT))).toBe(false);
    const a = stopAffordance(subject());
    expect(a.show, 'a phantom stop button survived the sweep').toBe(false);
    expect(a.label).toBe('Stop');
    expect(a.why).toBe('');
  });

  it('tells an already-open dashboard, which has no other clearing edge', () => {
    genJob('g-stale', 'queued');
    genJob('g-stale-b', 'running', AGENT_B, 'music');
    frames.length = 0;

    reconcileOrphanedJobsAtBoot();

    const announced = jobsFrames();
    // One frame per AGENT, not per row: two rows for one agent is one answer.
    expect(announced.map((f) => f.agentId).sort()).toEqual([AGENT, AGENT_B]);
    for (const f of announced) {
      expect(f.stoppable, 'the frame still claimed there was work to stop').toBe(false);
      expect(f.background).toBe(0);
    }
  });
});

// ── §2 ──────────────────────────────────────────────────────────────────────────────────

describe('§2 a row somebody owns is still work', () => {
  it('a job written after the reconciliation is untouched and still counted', () => {
    reconcileOrphanedJobsAtBoot();
    // The ordinary case: a tool call writes a row during this process's life.
    genJob('g-live', 'queued');

    expect(rowOf('generation_jobs', 'g-live').status, 'a live job was closed').toBe('queued');
    expect(liveWork(AGENT).background, 'live work stopped being counted').toBe(1);
    const a = stopAffordance(subject());
    expect(a.show, 'the owner lost the button for work that IS running').toBe(true);
    expect(a.label).toBe('Stop background job');
  });

  it('a terminal row keeps its own error text and its own verdict', () => {
    db().prepare(
      `INSERT INTO generation_jobs (id, kind, agent_id, model_id, provider_id, prompt, status, error, finished_at, started_at, updated_at)
       VALUES ('g-done', 'audio', ?, ?, ?, 'a real failure', 'failed', 'the provider refused the voice',
               '2026-01-01 00:00:00', '2026-01-01 00:00:00', '2026-01-01 00:00:00')`,
    ).run(AGENT, MODEL, PROVIDER);
    genJob('g-ok', 'succeeded');
    genJob('g-cut', 'cancelled');
    const before = db().prepare('SELECT * FROM generation_jobs ORDER BY id').all();

    const moved = sweepAbandonedJobRows();

    expect(moved).toEqual([]);
    expect(db().prepare('SELECT * FROM generation_jobs ORDER BY id').all()).toEqual(before);
    expect(liveWork(AGENT).background).toBe(0);
  });

  it('is idempotent by its predicate, not by a flag', () => {
    genJob('g-stale', 'queued');
    expect(sweepAbandonedJobRows()).toHaveLength(1);
    // A second pass of the SWEEP matches nothing — the WHERE is the safety, the once-guard
    // in §3 is a separate argument about when the sweep is licensed at all.
    expect(sweepAbandonedJobRows()).toEqual([]);
    expect(rowOf('generation_jobs', 'g-stale').error).toBe(ABANDONED_AT_BOOT);
  });
});

// ── §3 ──────────────────────────────────────────────────────────────────────────────────

describe('§3 the boot reconciliation fires exactly once', () => {
  it('refuses a second call, and the refusal protects live work', () => {
    genJob('g-stale', 'queued');
    expect(reconcileOrphanedJobsAtBoot()).toHaveLength(1);

    // By now this process has written real jobs, so "no process can own this row" is FALSE.
    genJob('g-live', 'queued');
    expect(reconcileOrphanedJobsAtBoot(), 'the boot sweep ran twice').toEqual([]);
    expect(rowOf('generation_jobs', 'g-live').status, 'a live job was closed by a second sweep').toBe('queued');
    expect(liveWork(AGENT).background).toBe(1);
  });
});

// ── §4 ──────────────────────────────────────────────────────────────────────────────────

describe('§4 the video resume contract survives the sweep', () => {
  it('leaves a row with a provider render for the boot poller to adopt', () => {
    vidJob('v-live', 'polling', 'provider-job-1');
    vidJob('v-queued-live', 'queued', 'provider-job-2');

    expect(reconcileOrphanedJobsAtBoot()).toEqual([]);

    // t114/U4: `failed` is terminal and `startVideoJobPoller` skips it, so closing these would
    // mean an asset the owner paid for is never fetched.
    expect(rowOf('video_jobs', 'v-live').status).toBe('polling');
    expect(rowOf('video_jobs', 'v-queued-live').status).toBe('queued');
    expect(liveWork(AGENT).background, 'a resumable render stopped being counted').toBe(2);
  });

  it('closes the one a resume cannot adopt — no provider job id, no render, no worker', () => {
    const blank = vidJob('v-blank', 'queued', '');
    const space = vidJob('v-space', 'polling', '   ');
    const none = vidJob('v-none', 'queued', null);

    const moved = reconcileOrphanedJobsAtBoot();

    expect(moved.map((j) => j.id).sort()).toEqual([blank, none, space].sort());
    for (const id of [blank, space, none]) {
      expect(rowOf('video_jobs', id)).toEqual({ status: 'failed', error: ABANDONED_AT_BOOT });
    }
    expect(liveWork(AGENT).background).toBe(0);
    expect(stopAffordance(subject()).show).toBe(false);
  });
});

// ── §5 ──────────────────────────────────────────────────────────────────────────────────

describe('§5 the status vocabulary is read from the terminal end', () => {
  it('an unrecognised status is OPEN to the reader and SWEPT by the sweep', () => {
    // Neither lifecycle has this word. The old `IN ('queued','running')` shape was blind to it
    // in both directions at once: uncounted by the reader AND unreachable by any sweep.
    genJob('g-odd', 'uploading');
    expect(liveWork(AGENT).background, 'an open row went uncounted').toBe(1);

    expect(reconcileOrphanedJobsAtBoot().map((j) => j.id)).toEqual(['g-odd']);
    expect(rowOf('generation_jobs', 'g-odd').status).toBe('failed');
    expect(liveWork(AGENT).background).toBe(0);
  });

  it('and case matters the safe way: a shouted status is open, not terminal', () => {
    genJob('g-shout', 'QUEUED');
    expect(liveWork(AGENT).background).toBe(1);
    expect(reconcileOrphanedJobsAtBoot().map((j) => j.id)).toEqual(['g-shout']);
  });

  it('an unrecognised VIDEO status still respects the resume contract', () => {
    vidJob('v-odd-live', 'uploading', 'provider-job-9');
    vidJob('v-odd-dead', 'uploading', null);

    expect(reconcileOrphanedJobsAtBoot().map((j) => j.id)).toEqual(['v-odd-dead']);
    expect(rowOf('video_jobs', 'v-odd-live').status).toBe('uploading');
  });
});

// ── §6 ──────────────────────────────────────────────────────────────────────────────────

describe('§6 the grown box — the owner\'s own shape, as a fixture', () => {
  /**
   * THE CONSTRUCTION LESSON, extended. This defect could not exist on a fresh install: it needs
   * a body with a HISTORY — rows written by processes that are gone, versions that predate the
   * reader, agents that have long since gone idle. A fresh fixture is green on the broken code.
   * So the fixture is a grown box: three agents, all idle, with the wreckage of months.
   */
  const growBox = (): void => {
    // Two crashes mid-render, from different versions, on two different agents.
    genJob('old-image', 'queued', AGENT, 'image');
    genJob('old-audio', 'running', AGENT, 'audio');
    genJob('old-music', 'queued', AGENT_B, 'music');
    // A video submitted and never acknowledged before the process died.
    vidJob('old-video', 'queued', null, AGENT_B);
    // …and the ordinary history that must survive untouched: finished work, failures with
    // their own reasons, and jobs the owner cancelled himself.
    genJob('hist-ok', 'succeeded', AGENT);
    genJob('hist-cut', 'cancelled', AGENT_B);
    vidJob('hist-video', 'succeeded', 'provider-job-old', AGENT);
  };

  it('every agent on it offers a stop button for nothing — then none of them do', () => {
    growBox();

    // BEFORE: the owner's report, reproduced exactly. Idle agents, stop controls everywhere.
    for (const id of [AGENT, AGENT_B]) {
      expect(hasLiveWork(liveWork(id)), `${id} should have looked busy`).toBe(true);
      expect(stopAffordance(subject(id)).show).toBe(true);
      expect(stopAffordance(subject(id)).label).toMatch(/background/);
    }

    const moved = reconcileOrphanedJobsAtBoot();
    expect(moved).toHaveLength(4);

    // AFTER: nothing to stop, and the history is intact.
    for (const id of [AGENT, AGENT_B]) {
      expect(liveWork(id).background, `${id} is still being called busy`).toBe(0);
      expect(stopAffordance(subject(id)).show, `${id} kept a phantom button`).toBe(false);
    }
    expect(rowOf('generation_jobs', 'hist-ok').status).toBe('succeeded');
    expect(rowOf('generation_jobs', 'hist-cut').status).toBe('cancelled');
    expect(rowOf('video_jobs', 'hist-video').status).toBe('succeeded');
    expect(db().prepare('SELECT COUNT(*) AS n FROM generation_jobs').get()).toEqual({ n: 5 });
    expect(db().prepare('SELECT COUNT(*) AS n FROM video_jobs').get()).toEqual({ n: 2 });
  });
});

// ── §7 ──────────────────────────────────────────────────────────────────────────────────

describe('§7 the wire', () => {
  it('boot calls the reconciliation', () => {
    const src = code(INDEX_TS);
    expect(/reconcileOrphanedJobsAtBoot\s*\(\s*\)/.test(src), 'boot stopped reconciling abandoned job rows').toBe(true);
  });

  it('and calls it BEFORE either adopter, which is the whole argument', () => {
    const src = code(INDEX_TS);
    const sweep = src.indexOf('reconcileOrphanedJobsAtBoot');
    const video = src.indexOf('startVideoJobPoller()');
    const notice = src.indexOf('notifyAbandonedGenerationJobs(');
    expect(sweep).toBeGreaterThan(-1);
    expect(video).toBeGreaterThan(-1);
    expect(notice).toBeGreaterThan(-1);
    // After the poller has adopted rows and the first tool call has written one, "no process
    // can own this row" is no longer decidable without guessing. The order IS the soundness.
    expect(sweep, 'the sweep moved below the video resume — it can now close live renders').toBeLessThan(video);
    expect(sweep, 'the notice half runs before the rows it describes are closed').toBeLessThan(notice);
  });

  it('the notice half is driven by what the sweep moved, not by a status scan of its own', () => {
    const src = code(path.resolve(HERE, '../generation-jobs.ts'));
    expect(/export function notifyAbandonedGenerationJobs/.test(src)).toBe(true);
    // The scan is what made one throwing row poison every row behind it. It must not come back,
    // and neither may a bare `for` loop around a delivery that can throw.
    expect(
      /SELECT[^;]*FROM generation_jobs WHERE status IN \('queued','running'\)/.test(src),
      'the boot status scan came back',
    ).toBe(false);
    expect(/startGenerationJobsWorker/.test(src), 'the old terminaliser came back').toBe(false);
  });

  it('no open-question predicate anywhere still enumerates the OPEN end', () => {
    // THE CENSUS, COUNTING BOTH WAYS. Every reader that asks "is this job still open" is asked
    // from the terminal end; what remains are CAS transition guards (`status='queued'` ->
    // running, `status='running'` -> succeeded, `status='queued'` -> polling), which are
    // narrow on purpose — widening those would let a terminal row be re-opened.
    const files = [
      '../generation-jobs.ts', '../video-job-poller.ts', '../video-generation.ts',
      '../../agent/live-work.ts', '../../agent/tools/cat/media.ts',
      '../../gateway/routes/config.ts',
    ];
    for (const f of files) {
      const src = code(path.resolve(HERE, f));
      const open = src.match(/status\s+IN\s*\(\s*'queued'\s*,\s*'(running|polling)'\s*\)/g) ?? [];
      expect(open, `${f} still enumerates the open end: ${open.join(' | ')}`).toEqual([]);
    }
  });
});
