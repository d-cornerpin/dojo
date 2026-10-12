// ════════════════════════════════════════════════════════════════════════════════════════
// t142 — "A PERSON WAS TOLD ABOUT THIS WORK" IS A RECORD, AND THE LADDER READS IT.
//
// The pm-cluster ruling (`overhaul-plans/pm-cluster-triage.md`, RULING on t124's MAJOR) found
// that the owner-escalation ladder's verify step — "has a person been told about THIS row
// since the first steer?" — had nowhere to read an answer from: `deliveries` carries no work
// reference, and the only two edges it tried were dead (`ask`, by construction older than the
// steer) or over-generous (`occurrence`, any scheduled-run output retiring the escalation).
// The interim was FAIL-SAFE: the owner is told twice rather than never.
//
// This file drives the four shapes through the scheduler's real sweep, on the real migration
// chain, with the "told" fact established the only ways the ruling permits — by a door that
// structurally holds the work id (the owner-notice door's shape: a platform outbound through
// the real outbound scope, then the record keyed by the delivery that scope wrote). Turn
// coincidence and content inspection are refused by the ruling and appear nowhere here.
//
//   §1  RED at 00a2b34d: a blocked row the owner was ALREADY told about is escalated again.
//   §2  RED at 00a2b34d: the occurrence edge — an unrelated scheduled-run output retired an
//       escalation nobody delivered (the over-credit the ruling folded in).
//   §3  RED at 00a2b34d: told, reopened, blocked AGAIN — the owner must be told again (the
//       one-shot stamp was per ROW, forever, so the second block never reached him).
//   §4  cancelled after being told — nothing escalates, the record stays on the history.
//   §5  the record's contract: refusals, idempotence, and a downgraded send not counting.
//   §6  a record from BEFORE the current episode does not suppress the new one.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { OWNER_ALERT_HEADS_UP_PREFIX } from '@dojo/shared';

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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t142-told-test', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* frames are not under test */ } }));

vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: () => Promise.resolve() }),
}));

import { runMigrations } from '../../db/migrations.js';
import { transition } from '../store.js';
import * as drive from '../validation-drive.js';
import { selectRowsForOwnerEscalation, ESCALATION_STEER_MARKER } from '../validation-drive.js';
import { withOutbound, recordAtDoor, currentOutboundDeliveryId, PLATFORM_SENDER } from '../../agent/v2/outbound.js';

/** Fictional throughout (G1). */
const ASSIGNEE = 'quillon';
const PRIMARY = 'primary';
const OWNER_PHONE = '+15550100';

const T = 1_700_000_000_000;
const NOW = T + 60 * 60_000;
const CUTOFF = NOW - 5 * 60_000;
const SERVICE_IDS = ['dreamer', 'healer'];
const OBSTACLE = 'the greenhouse controller rejects every firmware upload with a checksum error';

type TellWriter = (workId: string, evidence: { deliveryId: string; via: string }) => unknown;

/**
 * THE OWNER-NOTICE DOOR'S SHAPE. A platform outbound to the owner's phone, through the real
 * outbound scope (the door records the delivery), and then the told record keyed by the
 * delivery id that scope wrote — the exact call the t138/t143 door makes. The writer is
 * looked up rather than imported so this file runs at 00a2b34d, where it does not exist: the
 * RED there is the ladder's BEHAVIOUR, not a missing symbol.
 */
function tellOwnerThroughTheNoticeDoor(workId: string): string {
  return withOutbound(
    { agentId: PLATFORM_SENDER, tool: 'alert', channel: 'imessage', recipientId: OWNER_PHONE },
    () => {
      recordAtDoor({ outcome: 'delivered', channel: 'imessage' });
      const deliveryId = currentOutboundDeliveryId();
      expect(deliveryId, 'the door wrote a delivery row').toBeTruthy();
      const writer = (drive as unknown as Record<string, TellWriter | undefined>).recordPersonTold;
      writer?.(workId, { deliveryId: deliveryId!, via: 'owner_notice' });
      return deliveryId!;
    },
  );
}

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: ASSIGNEE, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: id, state: 'claimed', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-it', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'flash the greenhouse controller', goal: null,
    priority: 'normal', notes: null, remaining_children: null, compile_pending: 0,
    ttl_at: null, reply_conversation_id: null, attempts: 0, next_attempt_at: null,
    schedule_json: null, tz: null, anchor_local: null, next_run_at: null, sequence: null,
    opened_at: T, closed_at: null, updated_at: T, provenance: 'live',
    missed_runs_paused_at: null, ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

const age = (id: string): void => {
  mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(T, id);
};

function move(id: string, to: 'blocked' | 'claimed' | 'abandoned', by: 'agent' | 'owner' = 'agent'): void {
  const r = transition(id, {
    to, by, actorId: by === 'owner' ? 'owner' : ASSIGNEE,
    reason: `work_update(action="status") -> ${to}`,
    note: to === 'blocked' ? OBSTACLE : undefined,
  });
  expect(r.kind, `${id} -> ${to}`).toBe('applied');
}

function seedBlocked(id: string): void {
  seedWork(id);
  move(id, 'blocked');
  age(id);
}

const candidates = (): string[] =>
  selectRowsForOwnerEscalation(CUTOFF, SERVICE_IDS).map((r) => r.id);

/** The owner-visible rows the platform's own voice wrote, as the dashboard reads them. */
const ownerAlerts = (): string[] =>
  (mockDb.current!.prepare(
    `SELECT content FROM messages
      WHERE agent_id = ? AND role = 'system' AND lane = 'owner' AND retired_at IS NULL
      ORDER BY rowid`,
  ).all(PRIMARY) as Array<{ content: string }>)
    .map((r) => r.content)
    .filter((c) => c.startsWith(OWNER_ALERT_HEADS_UP_PREFIX));

/** How many times the platform steered the primary about this row (durable ledger). */
const steersOn = (id: string): number =>
  (mockDb.current!.prepare(
    `SELECT COUNT(*) AS n FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.action_taken') = ?`,
  ).get(id, ESCALATION_STEER_MARKER) as { n: number }).n;

async function sweep(): Promise<void> {
  const { sweepUnvalidatedTasksForUserEscalation } = await import('../../scheduler/runner.js');
  await sweepUnvalidatedTasksForUserEscalation();
}

async function driveLadderToTheEnd(): Promise<void> {
  await sweep();
  await sweep();
  await sweep();
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const [id, name] of [[PRIMARY, 'Primary'], [ASSIGNEE, 'Quillon']]) {
    mockDb.current.prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')`).run(id, name);
  }
  vi.setSystemTime(new Date(NOW));
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE WITNESS: an already-told blocked row is escalated again.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the owner already told about a blocked row is not told again', () => {
  it.fails('RED at 00a2b34d: told through the notice door, then the ladder steers and alerts anyway', async () => {
    seedBlocked('t-told');
    tellOwnerThroughTheNoticeDoor('t-told');

    await driveLadderToTheEnd();

    expect(steersOn('t-told'), 'the primary is not steered to raise what the owner already has').toBe(0);
    expect(ownerAlerts(), 'and the platform does not tell him a second time').toHaveLength(0);
    expect(candidates(), 'the row is not an escalation candidate this episode').not.toContain('t-told');
  });

  it('THE CONTROL: an identical row nobody told still reaches the owner', async () => {
    seedBlocked('t-untold');
    await driveLadderToTheEnd();
    expect(steersOn('t-untold')).toBeGreaterThanOrEqual(1);
    expect(ownerAlerts().length).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE OCCURRENCE OVER-CREDIT: a scheduled run's output is not news of the block.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 a scheduled run reaching the owner does not retire the escalation', () => {
  it.fails('RED at 00a2b34d: a run output after the first steer closed the case and the owner heard nothing', async () => {
    seedBlocked('t-recurring');
    seedWork('run-3', {
      kind: 'occurrence', parent_id: 't-recurring', root_kind: 'schedule', root_id: 't-recurring',
      state: 'open', intent: 'occurrence', title: 'occurrence #3', sequence: 3,
    });
    await sweep();   // steer 1
    expect(steersOn('t-recurring')).toBe(1);

    // The run delivered its routine output to the owner — rooted at the run, saying nothing
    // about the block. Written at the ledger's own door shape (migration 121's columns).
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, tool, channel, outcome, root_kind, root_id, created_at)
       VALUES ('d-run-output', ?, 'auto-route', 'imessage', 'delivered', 'occurrence', 'run-3',
               datetime(?, 'unixepoch'))`,
    ).run(PRIMARY, Math.floor(NOW / 1000));

    await sweep();
    await sweep();

    expect(ownerAlerts().length,
      'the run said nothing about the block; the owner must still be told',
    ).toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — BACKWARDS LIFECYCLE: told, then reopened, then blocked again means told again.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 told, reopened, blocked again — told again', () => {
  it.fails('RED at 00a2b34d: the second block of the same row never reaches the owner', async () => {
    seedBlocked('t-twice');
    await driveLadderToTheEnd();
    const firstEpisode = ownerAlerts().length;
    expect(firstEpisode, 'episode 1 reached the owner').toBeGreaterThanOrEqual(1);

    move('t-twice', 'claimed');      // the agent resolved it and went back to work
    move('t-twice', 'blocked');      // a NEW obstacle
    age('t-twice');
    await driveLadderToTheEnd();

    expect(ownerAlerts().length,
      'a fresh block is fresh news; the old episode\'s stamp must not swallow it',
    ).toBeGreaterThan(firstEpisode);
  });

  it.fails('RED at 00a2b34d: told through the door in episode 1 is not told in episode 2', async () => {
    seedBlocked('t-door-twice');
    tellOwnerThroughTheNoticeDoor('t-door-twice');
    await driveLadderToTheEnd();
    expect(ownerAlerts(), 'episode 1: already told, nothing more').toHaveLength(0);

    move('t-door-twice', 'claimed');
    move('t-door-twice', 'blocked');
    age('t-door-twice');
    await driveLadderToTheEnd();
    expect(ownerAlerts().length, 'episode 2: nobody told him about THIS block').toBeGreaterThanOrEqual(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — BACKWARDS LIFECYCLE: cancelled after being told.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 cancelled after being told', () => {
  it('nothing escalates, nothing throws, and the told record stays on the row\'s history', async () => {
    seedBlocked('t-cancelled');
    tellOwnerThroughTheNoticeDoor('t-cancelled');
    move('t-cancelled', 'abandoned', 'owner');
    age('t-cancelled');

    await driveLadderToTheEnd();
    expect(ownerAlerts()).toHaveLength(0);
    expect(steersOn('t-cancelled')).toBe(0);
    expect(candidates()).not.toContain('t-cancelled');
  });
});
