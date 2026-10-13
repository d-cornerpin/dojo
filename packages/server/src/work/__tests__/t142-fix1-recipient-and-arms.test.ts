// ════════════════════════════════════════════════════════════════════════════════════════
// t142 FIX ROUND 1 — the review's I2 and I3, driven through the same real sweep and doors as
// `t142-a-person-was-told.test.ts` (its harness is repeated here verbatim; a shared helper
// module would be a new non-test file for one lane's convenience).
//
//   I2  the told record must be about the RIGHT PERSON and the RIGHT SEND:
//       · an agent's email to a VENDOR about a blocked task is not the owner being told;
//       · an owner notice fired inside an agent's own unrelated send must not credit the
//         agent's delivery as the owner's notice.
//   I3  "once per episode" is the ruled shape for BLOCKED only (told -> reopened -> blocked
//       again => told again). The pause, close and failure arms keep base behaviour: one
//       trip up the ladder per row.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t142-fix1-test', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* frames are not under test */ } }));

vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: () => Promise.resolve() }),
}));

import { runMigrations } from '../../db/migrations.js';
import { transition } from '../store.js';
import {
  selectRowsForOwnerEscalation, ESCALATION_STEER_MARKER, recordPersonTold, escalationSteerCount,
} from '../validation-drive.js';
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

/**
 * THE OWNER-NOTICE DOOR'S SHAPE. A platform outbound to the owner's phone, through the real
 * outbound scope (the door records the delivery), and then the told record keyed by the
 * delivery id that scope wrote — the exact call the t138/t143 door makes. (At the RED commit
 * the writer was looked up rather than imported, so the file ran at 00a2b34d and the RED was
 * the ladder's BEHAVIOUR, not a missing symbol.)
 */
function tellOwnerThroughTheNoticeDoor(workId: string): string {
  return withOutbound(
    { agentId: PLATFORM_SENDER, tool: 'alert', channel: 'imessage', recipientId: OWNER_PHONE },
    () => {
      recordAtDoor({ outcome: 'delivered', channel: 'imessage' });
      const deliveryId = currentOutboundDeliveryId();
      expect(deliveryId, 'the door wrote a delivery row').toBeTruthy();
      const told = recordPersonTold(workId, { deliveryId: deliveryId!, via: 'owner_notice' });
      expect(told.kind, 'the record is written').toBe('applied');
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

function move(id: string, to: 'blocked' | 'claimed' | 'abandoned' | 'paused', by: 'agent' | 'owner' = 'agent'): void {
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


const OWNER_PHONE_PRIMARY = OWNER_PHONE;

/** The owner's iMessage address, recorded the way Settings records it (the starred sender). */
function seedOwnerAddress(): void {
  mockDb.current!.prepare(
    `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('imessage_approved_senders', ?, datetime('now'))`,
  ).run(JSON.stringify([
    { address: OWNER_PHONE_PRIMARY, name: 'Owner', is_primary: true },
    { address: '+15550199', name: 'Garden supplier', is_primary: false },
  ]));
}

describe('I2 the record is about the right person and the right send', () => {
  beforeEach(seedOwnerAddress);

  it('was RED at 3d68e92d: an agent\'s email to a VENDOR about the blocked task does not settle the owner\'s episode', async () => {
    seedBlocked('t-vendor');
    const deliveryId = withOutbound(
      { agentId: PRIMARY, tool: 'gmail_send', channel: 'email', recipientId: 'orders@supplier.example' },
      () => { recordAtDoor({ outcome: 'delivered', channel: 'email' }); return currentOutboundDeliveryId()!; },
    );
    const r = recordPersonTold('t-vendor', { deliveryId, via: 'send_tool' });
    expect(r.kind, 'a vendor is not the owner and not the requester').toBe('refused');
    await driveLadderToTheEnd();
    expect(ownerAlerts().length, 'the owner still hears about his blocked task').toBeGreaterThanOrEqual(1);
  });

  it('was RED at 3d68e92d: a notice fired inside the agent\'s own send cannot borrow that send\'s delivery', () => {
    seedBlocked('t-borrow');
    // The agent is mid-send to the owner about something UNRELATED; the notice door is
    // reached inside that scope and reads the ambient delivery — the shape the review found.
    withOutbound(
      { agentId: PRIMARY, tool: 'imessage_send', channel: 'imessage', recipientId: OWNER_PHONE_PRIMARY },
      () => {
        recordAtDoor({ outcome: 'delivered', channel: 'imessage' });
        const ambient = currentOutboundDeliveryId()!;
        const r = recordPersonTold('t-borrow', { deliveryId: ambient, via: 'owner_notice' });
        expect(r.kind, 'an agent\'s delivery is not the platform\'s notice').toBe('refused');
      },
    );
    expect(candidates()).toContain('t-borrow');
  });

  it('CONTROL: the requester (a person who is not the owner) being told IS a tell', () => {
    seedWork('t-req', { requester: 'watcher', requester_id: 'neighbour@garden.example' });
    move('t-req', 'blocked');
    age('t-req');
    const deliveryId = withOutbound(
      { agentId: PRIMARY, tool: 'gmail_send', channel: 'email', recipientId: 'Neighbour@Garden.example' },
      () => { recordAtDoor({ outcome: 'delivered', channel: 'email' }); return currentOutboundDeliveryId()!; },
    );
    expect(recordPersonTold('t-req', { deliveryId, via: 'send_tool' }).kind).toBe('applied');
    expect(candidates()).not.toContain('t-req');
  });

  it('CONTROL: the owner told on the dashboard by the agent IS a tell', () => {
    seedBlocked('t-dash');
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, outcome, created_at)
       VALUES ('d-dash', ?, 'dashboard', 'dashboard', 'owner', 'delivered', datetime('now'))`,
    ).run(PRIMARY);
    expect(recordPersonTold('t-dash', { deliveryId: 'd-dash', via: 'send_tool' }).kind).toBe('applied');
  });
});

describe('I3 once-per-episode is the BLOCKED arm only; every other arm keeps one trip per row', () => {
  it('was RED at 3d68e92d: blocked, escalated, then back to claimed — the old block is not news again', async () => {
    seedBlocked('t-fail-arm');
    await driveLadderToTheEnd();
    const first = ownerAlerts().length;
    expect(first).toBeGreaterThanOrEqual(1);
    move('t-fail-arm', 'claimed');
    // Long idle, far past any patience rung: the failure arm (one recorded block) admits it.
    mockDb.current!.prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(NOW - 30 * 86_400_000, 't-fail-arm');
    await driveLadderToTheEnd();
    expect(steersOn('t-fail-arm'), 'no new steers about an old, already-escalated block').toBe(2);
    expect(ownerAlerts().length).toBe(first);
  });

  it('was RED at 3d68e92d: an unvalidated pause escalated once is not escalated again on a later pause', async () => {
    seedWork('t-pause');
    move('t-pause', 'paused');
    age('t-pause');
    await driveLadderToTheEnd();
    const first = ownerAlerts().length;
    expect(first, 'the pause arm reaches the owner once').toBeGreaterThanOrEqual(1);
    move('t-pause', 'claimed');
    move('t-pause', 'paused');
    age('t-pause');
    await driveLadderToTheEnd();
    expect(ownerAlerts().length, 'base behaviour: one trip per row on the pause arm').toBe(first);
  });

  it('CONTROL (the ruled shape): a NEW block after reopen still reaches the owner', async () => {
    seedBlocked('t-ruled');
    await driveLadderToTheEnd();
    const first = ownerAlerts().length;
    move('t-ruled', 'claimed');
    move('t-ruled', 'blocked');
    age('t-ruled');
    await driveLadderToTheEnd();
    expect(ownerAlerts().length).toBeGreaterThan(first);
  });
});

describe('the notice door\'s sender literal is the platform sender', () => {
  it('NOTICE_DOOR_SENDER === PLATFORM_SENDER (kept as a literal only to avoid an import cycle)', async () => {
    const { NOTICE_DOOR_SENDER } = await import('../validation-drive.js');
    expect(NOTICE_DOOR_SENDER).toBe(PLATFORM_SENDER);
  });
});

describe('the told record silences only the news it postdates', () => {
  beforeEach(seedOwnerAddress);

  it('told while the work was running, then it PAUSED unvalidated: the pause still reaches the owner', async () => {
    seedWork('t-news');
    const deliveryId = withOutbound(
      { agentId: PLATFORM_SENDER, tool: 'alert', channel: 'imessage', recipientId: OWNER_PHONE_PRIMARY },
      () => { recordAtDoor({ outcome: 'delivered', channel: 'imessage' }); return currentOutboundDeliveryId()!; },
    );
    expect(recordPersonTold('t-news', { deliveryId, via: 'owner_notice' }).kind).toBe('applied');
    move('t-news', 'paused');
    age('t-news');
    expect(candidates(), 'the pause is news the tell did not carry').toContain('t-news');
  });

  it('CONTROL: told AFTER the pause, the pause is settled', () => {
    seedWork('t-news2');
    move('t-news2', 'paused');
    age('t-news2');
    const deliveryId = withOutbound(
      { agentId: PLATFORM_SENDER, tool: 'alert', channel: 'imessage', recipientId: OWNER_PHONE_PRIMARY },
      () => { recordAtDoor({ outcome: 'delivered', channel: 'imessage' }); return currentOutboundDeliveryId()!; },
    );
    expect(recordPersonTold('t-news2', { deliveryId, via: 'owner_notice' }).kind).toBe('applied');
    expect(candidates()).not.toContain('t-news2');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// ROUND 2 (re-review 1, N2): the legacy `imessage_default_sender` key names the owner ONLY when
// no primary is starred — the bridge's own rule (`getDefaultSender`). Nothing ever clears the
// legacy key, so honouring it beside a starred primary would let a send to the owner's OLD
// address count as him being told.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('round 2 N2: the legacy owner key counts only when no primary is starred', () => {
  const OLD_ADDRESS = '+15550177';
  const sendTo = (recipient: string): string => withOutbound(
    { agentId: PRIMARY, tool: 'imessage_send', channel: 'imessage', recipientId: recipient },
    () => { recordAtDoor({ outcome: 'delivered', channel: 'imessage' }); return currentOutboundDeliveryId()!; },
  );
  const setConfig = (key: string, value: string): void => {
    mockDb.current!.prepare(
      `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))`,
    ).run(key, value);
  };

  it('a starred primary exists: a send to the stale legacy address is NOT the owner told', () => {
    seedOwnerAddress();
    setConfig('imessage_default_sender', OLD_ADDRESS);
    seedBlocked('t-legacy');
    expect(recordPersonTold('t-legacy', { deliveryId: sendTo(OLD_ADDRESS), via: 'send_tool' }))
      .toMatchObject({ kind: 'refused', reason: 'not-the-owner-or-requester' });
    expect(recordPersonTold('t-legacy', { deliveryId: sendTo(OWNER_PHONE_PRIMARY), via: 'send_tool' }).kind,
      'the starred address still is').toBe('applied');
  });

  it('CONTROL: no primary starred, the legacy key IS the owner (an install that never re-saved Settings)', () => {
    setConfig('imessage_approved_senders', JSON.stringify([{ address: '+15550199', name: 'Garden supplier', is_primary: false }]));
    setConfig('imessage_default_sender', OLD_ADDRESS);
    seedBlocked('t-legacy-only');
    expect(recordPersonTold('t-legacy-only', { deliveryId: sendTo(OLD_ADDRESS), via: 'send_tool' }).kind).toBe('applied');
  });
});
