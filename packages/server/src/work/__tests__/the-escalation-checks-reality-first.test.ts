// UX-REPAIR ROUND 2 / T12 — THE ASK-THE-USER ESCALATION CHECKS REALITY FIRST, SPEAKS PER OR2,
// AND CANNOT VANISH.
//
// ── WHAT WAS MEASURED (investigation-round2.md §3, orchestrator-verified) ──
// `selectRowsForOwnerEscalation` decides from the `work` row's own state plus
// `adjudications`/`work_events` and touches nothing else — no deliveries, no
// `result_delivery_id`, no parent ask. On S4 (2026-08-10) that fired an owner question about
// a job whose answer had shipped 25.4 seconds earlier:
//
//   06:20:15.120  ask:6224401b… → done, result_delivery_id 8eb0439c   (receipt on file)
//   06:20:40.569  77cba094 …    validation_escalated, actor scheduler
//
// The question the owner was to be asked was *"is this actually in_progress?"* about a job
// that was finished and delivered — semantically unanswerable. Three further links, all
// pinned below: the note was engine-composed and owner-addressed (pre-OR2, 2026-06-01, moved
// onto a live lane in July with *"The note text is unchanged"*); it was truncated to 400 chars
// mid-task-id so the instruction could not be complied with even in principle; and the one
// durable stamp it wrote is a permanent suppressor, so a silent drop ended the story.
//
// requirement preserved: the 5-minute failsafe and the ordering law both stand. The
// genuinely-undelivered case escalates exactly as it does today — that is the control in
// every clause below.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-escalation-reality-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../db/migrations.js';
import {
  selectRowsForOwnerEscalation, selectRowsSkippedAsDelivered, ownerVerdictNudgeText,
  escalationSteerCount, firstEscalationSteerAt, recordEscalationSteer,
} from '../validation-drive.js';
import { MAX_FLOOR_STEER_ATTEMPTS, OUT_OF_BAND_GHOST_SUBJECTS } from '../../agent/v2/floor-ghost.js';
import { gatesForCall } from '../../agent/tools/gates.js';
import { PM_ONLY_WORK_OPS } from '../../tracker/pm-agent.js';

const AGENT = 'behaviorbot';
const OWNER_MSG = 'msg-owner-1';
const STALE_BEFORE = 1_786_000_000_000;
const OPENED = STALE_BEFORE - 600_000;

function seedTask(id: string, over: { sourceMessageId?: string | null } = {}): void {
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id, state,
                       intent, wakes, closes_thread, title, source_message_id, opened_at, updated_at)
     VALUES (?, 'task', ?, 'agent', ?, 'tracker', ?, 'claimed', 'tracker', 0, 0,
             'synthesize the two research pieces', ?, ?, ?)`,
  ).run(id, AGENT, AGENT, id, over.sourceMessageId ?? null, OPENED, OPENED);
  // Key 1 filed: the worker said it was finished. This is what makes the row a candidate.
  mockDb.current!.prepare(
    `INSERT INTO work_events (work_id, kind, payload, actor, created_at)
     VALUES (?, 'validation_requested', ?, ?, ?)`,
  ).run(id, JSON.stringify({ requested_state: 'done' }), AGENT, OPENED);
  // …and the ordering law: a recorded validation attempt exists.
  mockDb.current!.prepare(
    `INSERT INTO work_events (work_id, kind, payload, actor, created_at)
     VALUES (?, 'audit', ?, 'engine', ?)`,
  ).run(id, JSON.stringify({ action_taken: 'validation_review_miss' }), OPENED);
}

/** The parent ask, terminal with a receipt — the fact the predicate never consulted. */
function seedAnsweredAsk(): string {
  const askId = `ask:${OWNER_MSG}`;
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
     VALUES ('8eb0439c', ?, 4555, 'dashboard', 'dashboard', 'delivered', datetime('now'))`,
  ).run(AGENT);
  mockDb.current!.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                       wakes, closes_thread, title, result_delivery_id, opened_at, closed_at, updated_at)
     VALUES (?, 'ask', ?, 'owner', 'ask', ?, 'done', 'ask', 0, 0, 'the owner ask',
             '8eb0439c', ?, ?, ?)`,
  ).run(askId, AGENT, askId, OPENED, OPENED, OPENED);
  return askId;
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  db.prepare(`INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'BehaviorBot', 'idle', '1970-01-01')`).run(AGENT);
});

describe('T12 (1): the escalation reads whether the work was DELIVERED before bothering the owner', () => {
  it('THE S4 SHAPE: a task whose linked ask is terminal WITH a receipt is not escalated', () => {
    seedAnsweredAsk();
    seedTask('77cba094', { sourceMessageId: OWNER_MSG });
    expect(selectRowsForOwnerEscalation(STALE_BEFORE, []).map((r) => r.id)).toEqual([]);
  });

  it('CONTROL: the genuinely undelivered row escalates exactly as it does today', () => {
    seedTask('undelivered-1');
    expect(selectRowsForOwnerEscalation(STALE_BEFORE, []).map((r) => r.id)).toEqual(['undelivered-1']);
  });

  it('CONTROL: an ask that is terminal with NO receipt does not suppress the escalation', () => {
    const askId = `ask:${OWNER_MSG}`;
    mockDb.current!.prepare(
      `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                         wakes, closes_thread, title, opened_at, updated_at)
       VALUES (?, 'ask', ?, 'owner', 'ask', ?, 'open', 'ask', 0, 0, 'the owner ask', ?, ?)`,
    ).run(askId, AGENT, askId, OPENED, OPENED);
    seedTask('still-open', { sourceMessageId: OWNER_MSG });
    expect(selectRowsForOwnerEscalation(STALE_BEFORE, []).map((r) => r.id)).toEqual(['still-open']);
  });

  it('a task carrying its OWN delivered receipt is not escalated either', () => {
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, outcome, created_at)
       VALUES ('d-own', ?, 4555, 'dashboard', 'dashboard', 'delivered', datetime('now'))`,
    ).run(AGENT);
    seedTask('own-receipt');
    mockDb.current!.prepare(`UPDATE work SET result_delivery_id = 'd-own' WHERE id = 'own-receipt'`).run();
    expect(selectRowsForOwnerEscalation(STALE_BEFORE, []).map((r) => r.id)).toEqual([]);
  });
});

describe('T12 (2): the skip is VISIBLE and does not burn the one-shot stamp', () => {
  it('a row skipped because it was delivered is reported, not silently dropped', () => {
    seedAnsweredAsk();
    seedTask('77cba094', { sourceMessageId: OWNER_MSG });
    const skipped = selectRowsSkippedAsDelivered(STALE_BEFORE, []);
    expect(skipped.map((r) => r.id)).toEqual(['77cba094']);
    expect(skipped[0].deliveryId).toBe('8eb0439c');
  });

  it('CONTROL: an undelivered row is not reported as skipped', () => {
    seedTask('undelivered-1');
    expect(selectRowsSkippedAsDelivered(STALE_BEFORE, [])).toEqual([]);
  });

  it('the suppressor is untouched by a skip: the row is still escalatable if it un-delivers', () => {
    seedAnsweredAsk();
    seedTask('77cba094', { sourceMessageId: OWNER_MSG });
    void selectRowsSkippedAsDelivered(STALE_BEFORE, []);
    const stamps = mockDb.current!.prepare(
      `SELECT COUNT(*) AS n FROM work_events WHERE work_id = '77cba094' AND kind = 'validation_escalated'`,
    ).get() as { n: number };
    expect(stamps.n).toBe(0);
  });
});

describe('T12 (3): the nudge speaks per OR2 and survives the 400-char events gist intact', () => {
  const nudge = (): string => ownerVerdictNudgeText({
    taskId: '77cba094-e823-4c22-88d4-bea9645b3191',
    title: 'Synthesize the Squarespace and WordPress research into one rundown',
    status: 'in_progress', agentName: 'BehaviorBot', ownerName: 'David', boundMin: 5,
  });

  it('it fits the events lane gist WHOLE — the cap is not touched, the copy is', () => {
    // `memory/lanes.ts:308` slices an awareness row to 400 chars. The old note was 732 raw /
    // 694 after the source tag, and the cut landed mid-task-id: the primary could not have
    // complied even in principle. O15 (raise the cap) is refused; this fits inside it.
    expect(nudge().length).toBeLessThanOrEqual(400);
  });

  it('it hands the AGENT the fact and asks it to decide and speak — no owner-addressed question', () => {
    const t = nudge();
    expect(t).toContain('your own voice');
    expect(t).not.toMatch(/\bDavid,\s/);           // the engine does not address the owner
    expect(t).not.toContain('Reply yes/no');
  });

  it('it carries no raw task id and no canned tool call (the two recorded objections)', () => {
    // `packages/shared/src/visibility.ts:282-284` refused to allowlist this note because it
    // "embeds raw task ids and a '**Primary agent**: call …' tool instruction". Both are gone;
    // the allowlisting is still NOT done, because the AGENT speaks, not the notice.
    const t = nudge();
    expect(t).not.toContain('77cba094-e823-4c22-88d4-bea9645b3191');
    expect(t).not.toContain('**Primary agent**');
    expect(t).not.toContain('task_id=');
    expect(t).toContain('77cba094');               // the short id, as every other surface uses
  });

  it('it still names the fact the failsafe exists for', () => {
    const t = nudge();
    expect(t).toContain('BehaviorBot');
    expect(t).toContain('5');
  });
});

describe('T12 (3b): a silent turn no longer ends the story — bounded re-steer, then the platform surface', () => {
  it('the steer ladder counts DISTINCT PRIMARY TURNS, so a 30-second sweep cannot burn it', () => {
    seedTask('bounded-1');
    expect(escalationSteerCount('bounded-1')).toBe(0);
    recordEscalationSteer('bounded-1', { attempt: 1, bound: MAX_FLOOR_STEER_ATTEMPTS, turnNumber: 606 });
    recordEscalationSteer('bounded-1', { attempt: 1, bound: MAX_FLOOR_STEER_ATTEMPTS, turnNumber: 606 });
    expect(escalationSteerCount('bounded-1')).toBe(1);
    recordEscalationSteer('bounded-1', { attempt: 2, bound: MAX_FLOOR_STEER_ATTEMPTS, turnNumber: 607 });
    expect(escalationSteerCount('bounded-1')).toBe(2);
  });

  it('the bound is CARRIED, not chosen: it is the platform\'s existing steer bound', () => {
    expect(MAX_FLOOR_STEER_ATTEMPTS).toBe(2);
  });

  it('the first steer\'s instant is readable, so the verify step has a boundary', () => {
    seedTask('bounded-2');
    expect(firstEscalationSteerAt('bounded-2')).toBeNull();
    recordEscalationSteer('bounded-2', { attempt: 1, bound: MAX_FLOOR_STEER_ATTEMPTS, turnNumber: 606 });
    expect(firstEscalationSteerAt('bounded-2')).toBeGreaterThan(0);
  });

  it('the ghost subject is DECLARED, never a free string', () => {
    expect(OUT_OF_BAND_GHOST_SUBJECTS).toContain('owner-verdict-unasked');
  });
});

describe('T12 (4): the user verdict finally has a door, and it is the one the user speaks to', () => {
  const gateKinds = (agentIsPM: boolean): string[] => {
    void agentIsPM;
    return gatesForCall('work_validate', { action: 'apply_user_validation', task_id: 'x' })
      .map((g) => g.kind);
  };

  it('apply_user_validation is no longer PM-ONLY (the PM already failed to rule)', () => {
    expect(PM_ONLY_WORK_OPS.has('work_validate:apply_user_validation')).toBe(false);
  });

  it('it is PRIMARY-only: the op transcribes THE USER\'s verdict, and the user speaks to the primary', () => {
    expect(gateKinds(false)).toContain('primary_only');
  });

  it('CONTROL: the other four work_validate ops are still PM-only', () => {
    for (const op of ['validate', 'retask', 'override', 'apply_user_verdict']) {
      expect(PM_ONLY_WORK_OPS.has(`work_validate:${op}`)).toBe(true);
      expect(gatesForCall('work_validate', { action: op, task_id: 'x' }).map((g) => g.kind))
        .toContain('pm_only_operation');
    }
  });
});
