// ════════════════════════════════════════════════════════════════════════════════════════
// A-5b — THE STOP BUTTON APPEARS FOR THE WORK IT CAN ACTUALLY STOP.
//
// A-5 made the owner's stop reach every media dial and A-6 made it reach the web and
// workspace transports. Neither made that work VISIBLE, and the review recorded the gap:
// *"stop button doesn't APPEAR for background jobs (TTS/video) even though stop now works
// underneath — needs route predicate + dashboard affordance"*.
//
// THE DEFECT IN ONE SENTENCE: a background media job deliberately OUTLIVES its turn — the
// image delivery waits for the agent to go idle before it dials, the video poller runs for up
// to thirty minutes — so the row reads `status: 'idle'` while the work is on the wire, and the
// card gated its Stop button on `status === 'working'`. The button was therefore withheld for
// exactly the work it would have cut. Stopping worked; asking for it was impossible.
//
// ── THE TWO HALVES, AND WHY THIS FILE HOLDS BOTH ──
// The SERVER half is a read of the live abort registry into the agent payload (`inFlight`), and
// the DASHBOARD half is the rule that decides what to render from it
// (`dashboard/src/lib/stop-affordance.ts`). `packages/dashboard` has no test runner, so the
// established arrangement — eight other lib files do this — is that the rule lives in
// `lib/*.ts` and is driven from the server suite. Holding both in one file is the point: §3
// feeds a REAL route payload into the REAL rule, which is the only place their agreement can
// be observed. Either half alone can be green while the button stays missing.
//
// ⚠ WHAT THIS FILE DOES NOT DECIDE. The BACKLOG entry also asks for "an owner ruling on what
// stopping an idle agent means for its proactive lane". That is a product decision and it is
// not invented here: the button is offered for work that is measurably in flight and says what
// it will cut. Nothing in this change touches the scheduler.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CARD = path.resolve(HERE, '../../../../../dashboard/src/components/AgentCard.tsx');

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-a5b-stop', 'dojo.db'),
  };
});
// L40's emission is the subject of §5-§7, so the broadcaster RECORDS rather than swallows.
const frames: Array<Record<string, unknown>> = [];
vi.mock('../../ws.js', () => ({
  broadcast: (e: Record<string, unknown>) => { frames.push(e); },
  stampPersistedRow: (e: unknown) => e,
}));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';
import { openAgentCall } from '../../../agent/abortable-call.js';
import {
  stopAffordance, composerStopControl, type StopSubject,
} from '../../../../../dashboard/src/lib/stop-affordance.js';
import { liveWork, hasLiveWork } from '../../../agent/live-work.js';
import { createGenerationJob, setCancelled } from '../../../services/generation-jobs.js';
import type { AgentDetail } from '@dojo/shared';

const AGENT = 'zargo-a5b';

const MODEL = 'model-a5b';
const PROVIDER = 'prov-a5b';

function seed(): void {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO providers (id, name, type, base_url, auth_type) VALUES (?, 'Test', 'openai-compatible', 'https://example.test/api', 'api_key')`,
  ).run(PROVIDER);
  db.prepare(
    `INSERT INTO models (id, provider_id, name, api_model_id, capabilities, is_enabled, pricing_unit, cost_per_unit)
     VALUES (?, ?, 'Media', 'api/media', '["audio_generation","video_generation"]', 1, 'token', 0)`,
  ).run(MODEL, PROVIDER);
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Zargo', 'idle', '1970-01-01')`,
  ).run(AGENT);
}

/** A fictional video render, in the state the poller leaves it in while it polls. */
function seedVideoJob(status: 'queued' | 'polling' | 'cancelled' = 'polling'): string {
  const id = 'vid-fictional-1';
  mockDb.current!.prepare(
    `INSERT INTO video_jobs (id, agent_id, model_id, provider_id, prompt, status)
     VALUES (?, ?, ?, ?, 'a teapot orbiting a lighthouse', ?)`,
  ).run(id, AGENT, MODEL, PROVIDER, status);
  return id;
}

const statusOf = () => (mockDb.current!.prepare('SELECT status FROM agents WHERE id = ?')
  .get(AGENT) as { status: string }).status;

const jobsFrames = () => frames.filter((f) => f.type === 'agent:jobs');
const lastJobsFrame = () => jobsFrames()[jobsFrames().length - 1];

/** The stop, through the door the dashboard actually presses. */
async function pressStop(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await agentsRouter.request(`/${AGENT}/stop`, { method: 'POST' });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

/** The agent as the dashboard is actually served it. */
async function payload(): Promise<AgentDetail> {
  const res = await agentsRouter.request(`/${AGENT}`);
  expect(res.status, 'the agent route did not answer').toBe(200);
  const body = await res.json() as { ok: boolean; data: AgentDetail };
  expect(body.ok).toBe(true);
  return body.data;
}

beforeEach(() => {
  frames.length = 0;
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  seed();
});

afterEach(async () => {
  const s = await import('../../../agent/shared-state.js');
  s.activeAbortControllers.clear();
  s.stoppedAgents.clear();
  s.stopFencedRuns.clear();
  // t116 E2: §9 drives the unwind window through these two, so they are torn down with the
  // rest of the shared state — a leaked `activeRuns` entry would make a later section's
  // "genuinely idle agent" stoppable and the 400 controls would pass for the wrong reason.
  s.activeRuns.clear();
  s.lastRunEndedAt.clear();
  mockDb.current?.close();
  mockDb.current = null;
});

// ── §1 — the route half ─────────────────────────────────────────────────────────────────

describe('§1 the route says how much of this agent\'s work a stop would cut', () => {
  it('reports zero in flight for an idle agent with nothing on the wire', async () => {
    const agent = await payload();
    expect(agent.status, 'the fixture is not the idle case this file is about').toBe('idle');
    expect(agent.inFlight, 'the field is missing — the dashboard has nothing to read')
      .toEqual({ turn: 0, background: 0 });
  });

  it('⚠ THE A-5b CASE: an IDLE agent with a background job in flight reports it', async () => {
    const slot = openAgentCall(AGENT, 'background');
    try {
      const agent = await payload();
      // The row still says idle — that is the whole defect, and it is not being papered over.
      expect(agent.status, 'the status was changed instead of the payload widened').toBe('idle');
      expect(agent.inFlight, 'the background job is invisible to the dashboard')
        .toEqual({ turn: 0, background: 1 });
    } finally {
      slot.release();
    }
  });

  it('counts turn-scoped and background work separately, and both are live', async () => {
    const bg1 = openAgentCall(AGENT, 'background');
    const bg2 = openAgentCall(AGENT, 'background');
    const t1 = openAgentCall(AGENT, 'turn');
    try {
      expect((await payload()).inFlight).toEqual({ turn: 1, background: 2 });
    } finally {
      bg1.release(); bg2.release(); t1.release();
    }
    // A RELEASED slot must vanish from the payload: a stale count is a Stop button offered for
    // work that finished minutes ago, which is the same lie as the missing button, reversed.
    expect((await payload()).inFlight).toEqual({ turn: 0, background: 0 });
  });

  it('is a READ — no new column, no new writer', () => {
    const src = fs.readFileSync(path.resolve(HERE, '../agents.ts'), 'utf-8');
    // RULING #9 moved the read behind `agent/live-work.ts` — the one owner of the question —
    // because the card's rule, this payload and the stop route's own `status` check were three
    // answers to it, and that is how a visible button and a working mechanism came apart. The
    // requirement is unchanged and §8 pins the module's own side: it reads, it never writes.
    expect(/inFlight: liveWork\(/.test(src), 'the payload stopped reading the live predicate').toBe(true);
    // The registry is module state; a route that WROTE to it would be a second writer for the
    // stop machinery, which is exactly what A-5's own census refuses.
    expect(/registerAbortable|abortInFlight/.test(src),
      'the agents route must never write the abort registry — it only reports it').toBe(false);
  });
});

// ── §2 — the dashboard rule ─────────────────────────────────────────────────────────────

describe('§2 the rule offers the button for work that exists, and only for that', () => {
  const s = (status: string, turn = 0, background = 0): StopSubject =>
    ({ status, inFlight: { turn, background } });

  it('⚠ THE A-5b CASE: idle with a background job offers the button, and names it', () => {
    const a = stopAffordance(s('idle', 0, 1));
    expect(a.show, 'the button is still withheld for background work — the A-5b defect').toBe(true);
    expect(a.label, 'the label must say what a stop on an idle-looking agent will do')
      .toBe('Stop background job');
    expect(a.why).toContain('background');
  });

  it('pluralises the label and the reason off the real count', () => {
    const a = stopAffordance(s('idle', 0, 3));
    expect(a.label).toBe('Stop background jobs');
    expect(a.why).toContain('3');
  });

  it('a working agent is offered the button, and is TOLD when a background job rides with it', () => {
    expect(stopAffordance(s('working')).show).toBe(true);
    expect(stopAffordance(s('working')).label).toBe('Stop');
    const both = stopAffordance(s('working', 1, 2));
    expect(both.label, 'a working agent\'s button is still just Stop').toBe('Stop');
    expect(both.why, 'the owner is not told the render behind the turn will go too')
      .toContain('2 background jobs');
  });

  it('an OLD payload with no counts keeps the pre-A-5b behaviour exactly', () => {
    // A server that predates `inFlight` sends nothing. `undefined` must read as "no claim",
    // never as zero-and-therefore-no-button, or this change would REMOVE the button that used
    // to work on every mixed-version box.
    expect(stopAffordance({ status: 'working' }).show, 'a working agent lost its button').toBe(true);
    expect(stopAffordance({ status: 'idle' }).show).toBe(false);
  });

  it('a terminated agent is never offered a stop, even with a count still standing', () => {
    // The opposite untruth: a button that would do nothing. A terminated agent cannot be sent
    // anything, and a leftover registration is not a reason to pretend otherwise.
    expect(stopAffordance(s('terminated', 1, 4)).show).toBe(false);
  });

  it('an idle agent with a TURN-scoped call still gets the button — the race is real', () => {
    // The status write and the registry are not one transaction, so `idle` with a turn call in
    // flight happens. There IS something to cut, so the honest answer is yes.
    expect(stopAffordance(s('idle', 1, 0)).show).toBe(true);
    expect(stopAffordance(s('idle', 0, 0)).show, 'a button for nothing').toBe(false);
  });
});

// ── §3 — the two halves, against each other ─────────────────────────────────────────────

describe('§3 the payload the server actually serves drives the rule', () => {
  it('a background job opened through the real door puts a real button on a real payload', async () => {
    const before = stopAffordance(await payload());
    expect(before.show, 'the button is offered with nothing in flight').toBe(false);

    const slot = openAgentCall(AGENT, 'background');
    try {
      const served = await payload();
      const after = stopAffordance(served);
      expect(after.show, 'route and rule disagree — the button is still missing').toBe(true);
      expect(after.label).toBe('Stop background job');
    } finally {
      slot.release();
    }

    // …and it goes away again when the work does.
    expect(stopAffordance(await payload()).show, 'a phantom button outlived the job').toBe(false);
  });

  it('the card asks the rule instead of keeping its own copy of the decision', () => {
    const src = fs.readFileSync(CARD, 'utf-8');
    expect(/stopAffordance\(/.test(src), 'the card no longer consults the rule').toBe(true);
    // The defect WAS this expression gating the button. It may still exist for other purposes
    // (the card uses `isWorking` for the status dot), but the stop branch must read the rule.
    const stopBranch = src.slice(src.indexOf('api.stopAgent') - 600, src.indexOf('api.stopAgent'));
    expect(/stop\.show/.test(stopBranch), 'the stop branch re-derives its own predicate').toBe(true);
    expect(/\{isWorking && \(/.test(stopBranch), 'the old `isWorking` gate is back on the button')
      .toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// OWNER RULING 2026-10-05 (#9) — "STOP MEANS STOP FOR ANYTHING THAT AGENT IS DOING."
//
// §1-§3 above proved the agent card can SEE background work. The ruling closed the two
// questions §1-§3 deliberately left open ("an owner ruling on what stopping an idle agent
// means"), and closing them exposed that seeing it was not the same as being able to stop it:
//
//   · THE ROUTE REFUSED THE PRESS. `POST /agents/:id/stop` gated on `agents.status`, which
//     answers "is a TURN in flight" — the wrong question for work that deliberately outlives
//     its turn. MEASURED at `7dc71325` with one live `background` registration on an idle row:
//     `400 {"ok":false,"error":"Agent is not currently working"}`, and the registration still
//     un-aborted afterwards. The button A-5b made visible did nothing when pressed.
//
//   · THE COMPOSER WAS NEVER TOLD. Its whole state comes from `agent:status` frames, which
//     describe a turn; a job still running after the turn's `idle` emits no further frame, so
//     there was nothing for a rendering rule to work with. BACKLOG L40's own words: *"needs a
//     new emission, not a rendering rule"*.
//
//   · THE PREDICATE EXISTED THREE TIMES. The card's rule, the route's `status` check and the
//     payload's registry read were three answers to one question — which is exactly how a
//     visible button and a working mechanism came apart. `agent/live-work.ts` is now the one
//     owner, and the route, the frame and both rendering rules read it.
//
// AND ONE FACT THE REGISTRY CANNOT SUPPLY, which is why the predicate reads job ROWS too:
// `image_create`'s delivery waits for the agent to go idle BEFORE it dials, so during that
// wait nothing is registered and nothing is fenced. §5 drives that window on a fictional job.
// ════════════════════════════════════════════════════════════════════════════════════════

// ── §4 — the route predicate ──────────────────────────────────────────────────────────────

describe('§4 the stop route answers the same question the button was offered on', () => {
  it('⚠ THE RED: an idle agent with a live background job is stoppable, and the stop lands', async () => {
    // This is the exact probe that returned 400 before the predicate moved.
    const slot = openAgentCall(AGENT, 'background');
    try {
      const { status, body } = await pressStop();
      expect(status, 'the route refused the press the card invited').toBe(200);
      expect(body.ok).toBe(true);
      expect(slot.signal.aborted, 'the route answered 200 and cut nothing').toBe(true);
      expect(slot.cutByStop(), 'the cut wore the engine\'s identity, not the owner\'s').toBe(true);
    } finally {
      slot.release();
    }
  });

  it('a genuinely idle agent is still refused — a button for nothing stays impossible', async () => {
    expect(hasLiveWork(liveWork(AGENT))).toBe(false);
    const { status, body } = await pressStop();
    expect(status).toBe(400);
    // The refusal now names BOTH questions it asked, because it is no longer asking only one.
    expect(String(body.error)).toContain('background jobs');
  });

  it('a working agent is still stoppable with nothing registered at all — unchanged', async () => {
    mockDb.current!.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(AGENT);
    expect(hasLiveWork(liveWork(AGENT)), 'the fixture registered something').toBe(false);
    expect((await pressStop()).status, 'the pre-A-5b path regressed').toBe(200);
  });

  it('an OPEN JOB ROW alone qualifies — the pre-dial window the registry cannot see', async () => {
    seedVideoJob('polling');
    expect(liveWork(AGENT), 'the row is invisible to the predicate').toEqual({ turn: 0, background: 1 });
    expect((await pressStop()).status).toBe(200);
  });

  it('a TERMINAL job row does not qualify — a stale row is not live work', async () => {
    seedVideoJob('cancelled');
    expect(liveWork(AGENT)).toEqual({ turn: 0, background: 0 });
    expect((await pressStop()).status, 'a finished render kept the agent stoppable for ever').toBe(400);
  });
});

// ── §5 — the predicate's own arithmetic ───────────────────────────────────────────────────

describe('§5 one job counts once, however many ways a stop can reach it', () => {
  it('a registration and the row it belongs to are ONE thing to stop, not two', () => {
    // The video poll loop holds a `background` registration for its whole life AND owns a row.
    // Summing would put "Stop background jobs — 2 jobs are still running" in front of an owner
    // who asked for one video. The number is the text on a button, so it is `max`, not `+`.
    const id = seedVideoJob('polling');
    const slot = openAgentCall(AGENT, 'background');
    try {
      expect(liveWork(AGENT)).toEqual({ turn: 0, background: 1 });
    } finally {
      slot.release();
    }
    // …and the row alone still counts once when the loop's leg has released.
    expect(liveWork(AGENT)).toEqual({ turn: 0, background: 1 });
    // `video_jobs` is the poller's own table (one owner per table — `setCancelled` is
    // `generation_jobs`'), so the terminal state is written the way the poller writes it.
    mockDb.current!.prepare("UPDATE video_jobs SET status = 'cancelled' WHERE id = ?").run(id);
    expect(liveWork(AGENT)).toEqual({ turn: 0, background: 0 });
  });

  it('two separate jobs count twice', () => {
    seedVideoJob('polling');
    createGenerationJob({
      kind: 'audio', agentId: AGENT, modelId: MODEL, providerId: PROVIDER, prompt: 'a lullaby',
    });
    expect(liveWork(AGENT)).toEqual({ turn: 0, background: 2 });
  });

  it('turn-scoped work is counted apart, and never folded into the background number', () => {
    const t = openAgentCall(AGENT, 'turn');
    try {
      expect(liveWork(AGENT)).toEqual({ turn: 1, background: 0 });
    } finally { t.release(); }
  });

  it('another agent\'s job is not this agent\'s work', () => {
    mockDb.current!.prepare(
      `INSERT INTO video_jobs (id, agent_id, model_id, provider_id, prompt, status)
       VALUES ('vid-other', 'some-other-agent', ?, ?, 'not mine', 'polling')`,
    ).run(MODEL, PROVIDER);
    expect(liveWork(AGENT)).toEqual({ turn: 0, background: 0 });
  });
});

// ── §6 — the emission (BACKLOG L40) ───────────────────────────────────────────────────────

describe('§6 the composer is TOLD, by a frame of its own', () => {
  it('⚠ a background dial opening after the turn ended emits `agent:jobs`', () => {
    const slot = openAgentCall(AGENT, 'background');
    try {
      const f = lastJobsFrame();
      expect(f, 'no frame — the composer learns nothing and the defect stands').toBeTruthy();
      expect(f.agentId).toBe(AGENT);
      expect(f.stoppable, 'the frame carries the server\'s own answer').toBe(true);
      expect(f.background).toBe(1);
    } finally { slot.release(); }
  });

  it('…and releasing it emits the zero, so the control goes away with the work', () => {
    const slot = openAgentCall(AGENT, 'background');
    slot.release();
    const f = lastJobsFrame();
    expect(f.stoppable, 'a phantom stop control outlived the job').toBe(false);
    expect(f.background).toBe(0);
  });

  it('a TURN-scoped call says nothing — `agent:status` already carries the turn', () => {
    // A turn makes dozens of these. A frame per model call would be a per-token stream wearing
    // a state change's clothes, and the composer already knows the turn is running.
    const t = openAgentCall(AGENT, 'turn');
    try {
      expect(jobsFrames().length, 'the turn lane started emitting too').toBe(0);
    } finally { t.release(); }
    expect(jobsFrames().length).toBe(0);
  });

  it('a media job ROW changing state emits it too — the window with no registration', () => {
    const id = createGenerationJob({
      kind: 'audio', agentId: AGENT, modelId: MODEL, providerId: PROVIDER, prompt: 'a lullaby',
    });
    expect(lastJobsFrame().stoppable, 'a queued job that has not dialled is invisible').toBe(true);
    setCancelled(id);
    expect(lastJobsFrame().stoppable).toBe(false);
  });

  it('the frame is delivered immediately, never coalesced', async () => {
    // The frame that matters most is the LAST one — the zero that takes the control away.
    // Held behind an unrelated flush it reads as a button that did nothing.
    const { EVENT_BATCHABLE } = await import('@dojo/shared');
    expect(EVENT_BATCHABLE['agent:jobs']).toBe(false);
  });
});

// ── §7 — the whole lifecycle, backwards, on a fictional job ───────────────────────────────

describe('§7 start a job · the turn ends · the control stays · stop · it is gone', () => {
  it('⚠ THE LIFECYCLE PROBE: a fictional narration outlives its turn and the stop cuts it', async () => {
    // 1. A turn is running and asks for a narration. The job row is the durable fact.
    mockDb.current!.prepare("UPDATE agents SET status = 'working' WHERE id = ?").run(AGENT);
    const jobId = createGenerationJob({
      kind: 'audio', agentId: AGENT, modelId: MODEL, providerId: PROVIDER,
      prompt: 'read the teapot chapter aloud',
    });
    const dial = openAgentCall(AGENT, 'background');

    // 2. THE TURN ENDS. This is the exact moment the defect lived in: `agents.status` goes
    //    idle, the composer's last `agent:status` frame says idle, and the job keeps running.
    mockDb.current!.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(AGENT);
    expect(statusOf(), 'the fixture is not the after-the-turn case this probe is about').toBe('idle');

    // 3. THE CONTROL IS STILL OFFERED — on all three surfaces, off one predicate.
    const served = await payload();
    expect(served.status).toBe('idle');
    expect(served.inFlight).toEqual({ turn: 0, background: 1 });
    expect(stopAffordance(served).show, 'the agent card dropped the button').toBe(true);
    expect(stopAffordance(served).label).toBe('Stop background job');
    const told = lastJobsFrame();
    expect(told.stoppable, 'the composer was never told').toBe(true);
    // …and the composer puts it BESIDE send, not in send's seat: the agent is idle and can be
    // messaged while the narration renders.
    expect(composerStopControl({
      isWorking: false, canStop: told.stoppable === true, hasHandler: true,
    }), 'a background render disabled the composer').toBe('beside-send');

    // 4. THE PRESS.
    const { status, body } = await pressStop();
    expect(status, 'the press was refused').toBe(200);

    // 5. THE JOB IS PROVABLY CANCELLED — the dial cut with the owner's identity on it, and the
    //    row in the one terminal state that is not a provider failure.
    expect(dial.signal.aborted, 'the provider call is still on the wire').toBe(true);
    expect(dial.cutByStop(), 'the cut was attributed to the engine, not the owner').toBe(true);
    const row = mockDb.current!.prepare('SELECT status, error FROM generation_jobs WHERE id = ?')
      .get(jobId) as { status: string; error: string | null };
    expect(row.status, 'a stopped job wrote `failed` and will blame a provider for the button')
      .toBe('cancelled');
    expect(row.error, 'a cancelled job carries no provider error').toBeNull();
    dial.release();

    // 6. THE AGENT READS IDLE AND NOTHING IS OFFERED ANY MORE.
    expect(statusOf()).toBe('idle');
    expect(liveWork(AGENT)).toEqual({ turn: 0, background: 0 });
    expect((body.data as { inFlight: unknown }).inFlight, 'the press answered with stale counts')
      .toEqual({ turn: 0, background: 0 });
    const after = await payload();
    expect(stopAffordance(after).show, 'a phantom button survived the stop').toBe(false);
    expect(lastJobsFrame().stoppable, 'the composer still shows a control over cut work').toBe(false);
    expect(composerStopControl({ isWorking: false, canStop: false, hasHandler: true })).toBe('none');
  });

  it('…and a plain idle agent, start to finish, is offered nothing at all', async () => {
    const served = await payload();
    expect(served.status).toBe('idle');
    expect(served.inFlight).toEqual({ turn: 0, background: 0 });
    expect(stopAffordance(served).show).toBe(false);
    expect(jobsFrames().length, 'a quiet box emitted a frame about nothing').toBe(0);
    expect(composerStopControl({ isWorking: false, canStop: false, hasHandler: true })).toBe('none');
    expect((await pressStop()).status).toBe(400);
  });
});

// ── §8 — the three surfaces read ONE predicate ────────────────────────────────────────────

describe('§8 nobody keeps a second copy of the question', () => {
  const codeOf = (abs: string) => fs.readFileSync(abs, 'utf-8')
    // Comments first, always: a clause satisfiable by the prose above a call tests the prose.
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  const ROUTE = path.resolve(HERE, '../agents.ts');
  const COMPOSER = path.resolve(HERE, '../../../../../dashboard/src/components/Dojo3Composer.tsx');
  const CHAT = path.resolve(HERE, '../../../../../dashboard/src/pages/Chat.tsx');

  it('the stop route decides on `liveWork`, not on the status column alone', () => {
    const src = codeOf(ROUTE);
    // The APPLICATION, not just the import: the refusal branch must consult the predicate.
    expect(/!hasLiveWork\(/.test(src), 'the route re-derived its own predicate').toBe(true);
    expect(/status !== 'working'\s*\)\s*\{\s*return c\.json\(\{ ok: false/.test(src),
      'the status-only refusal is back — this is the exact 400 the card walked into').toBe(false);
    // And the payload reads the module rather than the registry directly, so the job rows the
    // registry cannot see are in BOTH answers.
    expect(/inFlight: liveWork\(/.test(src)).toBe(true);
  });

  it('the composer asks the rule and the frame, and tallies nothing itself', () => {
    expect(/composerStopControl\(/.test(codeOf(COMPOSER)),
      'the composer went back to its own two booleans').toBe(true);
    const chat = codeOf(CHAT);
    expect(/subscribe\('agent:jobs'/.test(chat), 'the composer stopped listening for the emission')
      .toBe(true);
    expect(/canStop=\{canStop\}/.test(chat), 'the wider question stopped reaching the composer')
      .toBe(true);
    // The frame's own `stoppable` is what is read. A component re-deriving a predicate from the
    // counts is the second copy this section exists to refuse.
    expect(/setBackgroundStoppable\(e\.stoppable === true\)/.test(chat)).toBe(true);
  });

  it('the predicate module is a READER of both facts and a writer of neither', () => {
    const src = codeOf(path.resolve(HERE, '../../../agent/live-work.ts'));
    expect(/countAbortable\(/.test(src), 'it stopped reading the live registry').toBe(true);
    expect(/generation_jobs|video_jobs/.test(src), 'it stopped reading the job rows').toBe(true);
    expect(/registerAbortable|abortInFlight|UPDATE |INSERT /.test(src),
      'the predicate became a writer — two owners for the stop machinery').toBe(false);
  });

  it('every `background` registration in production announces itself through the one door', () => {
    // The emission lives inside `openAgentCall`, so a NEW background dial is heard about
    // without its author remembering anything. This clause is what keeps it there: moved out
    // to the call sites, the next one would be born silent exactly as these were.
    const src = codeOf(path.resolve(HERE, '../../../agent/abortable-call.ts'));
    expect(/scope === 'background'\) announceLiveWork\(agentId\)/.test(src),
      'the announcement left the one door every background dial comes through').toBe(true);
    // Both edges. An open with no matching release is a control that never goes away.
    expect(src.match(/announceLiveWork\(agentId\)/g)?.length,
      'one of the two lifecycle edges stopped speaking').toBe(2);
  });
});

// ── §9 — the turn-unwind window (t116 E2) ─────────────────────────────────────────────────

// ════════════════════════════════════════════════════════════════════════════════════════
// t116 E2 — THE PRESS THE DOOR REFUSED WHILE THE TURN WAS STILL COMING DOWN.
//
// From the release blast, attempt 1: `P6 stop: press=400 ok=false … {"ok":false,"error":
// "Agent is not currently working and has no background jobs running"}`. Nothing latched the
// stop, so the turn recorded `answered` and emitted no jobs frame — the two findings filed
// beside it are consequences of this one, not defects of their own.
//
// WHY §4's PREDICATE WAS NOT ENOUGH, THOUGH IT WAS RIGHT. Ruling #9 moved the guard off the
// status column and onto `liveWork`, and that fixed the background-job case §4 proves. But
// BOTH facts are instantaneous, and during a turn's unwind both are already false:
//
//   · teardown's `settleStatus` writes `status='idle'` BEFORE `finalizeTurnRecord` runs;
//   · `callModel` releases its abort registration in its own `finally`, so `liveWork` is 0;
//   · and the run's exit `finally` deletes `activeRuns` at its TOP, then runs a long awaited
//     tail (the A2A re-trigger, the drains).
//
// So between "the model stopped talking" and "the run is actually over" the agent looked
// completely quiet to this door while being anything but. `activeRuns` is the fact `stopAgent`
// itself reads to decide whether to raise the fence — the door asking a different question
// than the mechanism it drives is the whole defect.
//
// ── DRIVEN BY STATE, NOT BY A SLEEP ──
// The triage recorded E2 as flaky 1/3 because the probe could not tell it from a correct
// refusal: a press after a run genuinely ends SHOULD get a 400. There is no ambiguity here
// because the unwind state is constructed rather than waited for — the row says `idle`,
// nothing is registered, and `activeRuns` holds the agent, which is exactly the shape
// teardown leaves behind. The grace window is driven by stamping `lastRunEndedAt` to a chosen
// value, so no clause in this section reads the wall clock or depends on how loaded the box
// is.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§9 a stop lands on a turn that is still unwinding', () => {
  /** The state teardown actually leaves behind: idle row, nothing registered, run in flight. */
  async function unwinding(): Promise<void> {
    const s = await import('../../../agent/shared-state.js');
    mockDb.current!.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(AGENT);
    s.activeRuns.add(AGENT);
    // The premise, asserted rather than assumed: if either of the door's two original facts
    // were still true here, this section would be re-proving §4 instead of E2.
    expect(statusOf(), 'the fixture left the row saying working').toBe('idle');
    expect(hasLiveWork(liveWork(AGENT)), 'the fixture registered live work').toBe(false);
  }

  it('⚠ THE RED: idle row, nothing registered, run still in flight — the press is ACCEPTED', async () => {
    await unwinding();

    const { status, body } = await pressStop();
    expect(status, 'the door refused a press landing inside the turn unwind — this is E2')
      .toBe(200);
    expect(body.ok).toBe(true);
  });

  it('…and the accepted press RAISES THE FENCE, which is the only reason accepting it matters', async () => {
    // A 200 that latched nothing would be a worse defect than the 400: the owner would be
    // told the stop took. The fence is the fact E1's checkpoints read, so this is the clause
    // that joins the two halves of this lane — the door accepts, and what it accepts onto is
    // the thing that actually suppresses the reply.
    await unwinding();
    const s = await import('../../../agent/shared-state.js');

    await pressStop();

    expect(s.isStopFenced(AGENT), 'the press was accepted and stopped nothing').toBe(true);
    // Run-scoped, not just the liftable flag: `stopAgent` raises the fence only when a run is
    // in flight, and the whole point of this window is that one still is.
    expect(s.stopFencedRuns.has(AGENT), 'the run-scoped fence was not raised for a live run')
      .toBe(true);
  });

  it('the DRAIN TAIL is covered too — the window after `activeRuns` is released', async () => {
    // The run's exit `finally` deletes `activeRuns` at its top and then awaits a long tail.
    // That residual is named in the fence's own header; the stamp is what closes it.
    const s = await import('../../../agent/shared-state.js');
    mockDb.current!.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(AGENT);
    s.activeRuns.delete(AGENT);
    s.lastRunEndedAt.set(AGENT, Date.now());

    expect((await pressStop()).status, 'a press in the drain tail was told nothing was happening')
      .toBe(200);
  });

  it('the grace window is BOUNDED — an old stamp does not make an agent stoppable for ever', async () => {
    // Driven by the stamp's value, never by waiting: a clause that slept for the window would
    // be a timing clause on a box seven lanes share, and would red for the wrong reason.
    const s = await import('../../../agent/shared-state.js');
    mockDb.current!.prepare("UPDATE agents SET status = 'idle' WHERE id = ?").run(AGENT);
    s.lastRunEndedAt.set(AGENT, Date.now() - (s.RUN_UNWIND_GRACE_MS + 1_000));

    expect((await pressStop()).status, 'a long-finished run left the agent permanently stoppable')
      .toBe(400);
  });

  it('CONTROL: a genuinely quiet agent is STILL refused — no run, no stamp, no jobs', async () => {
    // The 400 has to survive, and this is the clause that makes the fix a narrowing rather
    // than a widening. Accepting this press would set `stopMarkerPending` on a turn that
    // never happened, which is the refusal's own stated reason for existing.
    const s = await import('../../../agent/shared-state.js');
    expect(s.activeRuns.has(AGENT)).toBe(false);
    expect(s.lastRunEndedAt.has(AGENT)).toBe(false);

    const { status, body } = await pressStop();
    expect(status, 'a button for nothing became possible').toBe(400);
    expect(String(body.error)).toContain('background jobs');
  });

  it('CONTROL: ANOTHER agent\'s run in flight does not make this agent stoppable', async () => {
    const s = await import('../../../agent/shared-state.js');
    s.activeRuns.add('some-other-agent');
    s.lastRunEndedAt.set('some-other-agent', Date.now());

    expect((await pressStop()).status, 'one agent\'s unwind made every agent stoppable').toBe(400);
  });

  it('the door reads the SHARED fact, never a fourth copy of "is a run in flight"', () => {
    const src = fs.readFileSync(path.resolve(HERE, '../agents.ts'), 'utf-8')
      // Comments first, always: this disjunct is introduced by a long paragraph naming
      // `activeRuns`, and a clause satisfiable by that prose tests the prose.
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
    // THE APPLICATION, not the import: the refusal branch itself must consult it, as the
    // sibling clause in §8 requires of `hasLiveWork`.
    expect(/!isRunUnwinding\(id\)/.test(src), 'the route stopped asking whether a run is unwinding')
      .toBe(true);
    // And it is a DISJUNCT added beside the other two, not a replacement for either —
    // ruling #9's predicate and the status check both still have to be in the condition.
    expect(/status !== 'working' && !hasLiveWork\(live\) && !isRunUnwinding\(id\)/.test(src),
      'the three facts stopped being asked together — one of them was widened or dropped')
      .toBe(true);
    // The route must not re-derive the window from `activeRuns` itself: one predicate, one
    // owner, same rule §8 holds the other two surfaces to.
    expect(/activeRuns/.test(src), 'the route grew its own copy of the in-flight question')
      .toBe(false);
  });
});
