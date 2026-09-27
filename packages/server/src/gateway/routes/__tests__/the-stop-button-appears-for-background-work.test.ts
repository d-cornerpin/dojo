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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-a5b-stop', 'dojo.db'),
  };
});
vi.mock('../../ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));

import { runMigrations } from '../../../db/migrations.js';
import { agentsRouter } from '../agents.js';
import { openAgentCall } from '../../../agent/abortable-call.js';
import { stopAffordance, type StopSubject } from '../../../../../dashboard/src/lib/stop-affordance.js';
import type { AgentDetail } from '@dojo/shared';

const AGENT = 'kevin-a5b';

function seed(): void {
  const db = mockDb.current!;
  db.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
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
    const block = src.slice(src.indexOf('inFlight: {'), src.indexOf('inFlight: {') + 400);
    expect(/countAbortable\(/.test(block), 'the payload stopped reading the live registry').toBe(true);
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
