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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t142-told-test', 'dojo.db'),
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
  // The owner's starred iMessage address — the record that makes OWNER_PHONE the owner (fix
  // round 1: the told record checks WHO was told).
  mockDb.current.prepare(
    `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('imessage_approved_senders', ?, datetime('now'))`,
  ).run(JSON.stringify([{ address: OWNER_PHONE, name: 'Owner', is_primary: true }]));
  vi.setSystemTime(new Date(NOW));
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE WITNESS: an already-told blocked row is escalated again.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the owner already told about a blocked row is not told again', () => {
  it('was RED at 00a2b34d: told through the notice door, then the ladder steers and alerts anyway', async () => {
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
  it('was RED at 00a2b34d: a run output after the first steer closed the case and the owner heard nothing', async () => {
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
  it('was RED at 00a2b34d: the second block of the same row never reaches the owner', async () => {
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

  it('was RED at 00a2b34d: told through the door in episode 1 is not told in episode 2', async () => {
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

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — THE RECORD'S CONTRACT. Self-verifying, idempotent, and it never claims a tell the
// ledger does not hold.
// ════════════════════════════════════════════════════════════════════════════════════════

function seedDelivery(id: string, over: { channel?: string; tool?: string; outcome?: string } = {}): void {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, outcome, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(id, PRIMARY, over.tool ?? 'imessage_send', over.channel ?? 'imessage', OWNER_PHONE, over.outcome ?? 'delivered');
}

describe('§5 the record refuses what is not a person being told', () => {
  beforeEach(() => { seedBlocked('t-c'); });

  it('an unknown work row, an unknown delivery', () => {
    seedDelivery('d-ok');
    expect(recordPersonTold('t-nope', { deliveryId: 'd-ok', via: 'send_tool' })).toMatchObject({ kind: 'refused', reason: 'no-such-work' });
    expect(recordPersonTold('t-c', { deliveryId: 'd-nope', via: 'send_tool' })).toMatchObject({ kind: 'refused', reason: 'no-such-delivery' });
  });

  it('a send that failed, was held, or was suppressed is not a tell', () => {
    for (const outcome of ['failed', 'held', 'suppressed']) {
      seedDelivery(`d-${outcome}`, { outcome });
      expect(recordPersonTold('t-c', { deliveryId: `d-${outcome}`, via: 'send_tool' }), outcome)
        .toMatchObject({ kind: 'refused', reason: 'not-delivered' });
    }
  });

  it('peer traffic, a crossing of no door, and the engine\'s "on it" do not reach a person', () => {
    seedDelivery('d-a2a', { channel: 'a2a' });
    seedDelivery('d-none', { channel: 'none' });
    seedDelivery('d-ack', { tool: 'engine-ack' });
    for (const d of ['d-a2a', 'd-none', 'd-ack']) {
      expect(recordPersonTold('t-c', { deliveryId: d, via: 'send_tool' }), d)
        .toMatchObject({ kind: 'refused', reason: 'not-a-person' });
    }
    expect(candidates(), 'none of them settled the episode').toContain('t-c');
  });

  it('idempotent per delivery, and the actor is the delivery\'s own sender', () => {
    seedDelivery('d-once');
    const first = recordPersonTold('t-c', { deliveryId: 'd-once', via: 'send_tool' });
    expect(first.kind).toBe('applied');
    expect(recordPersonTold('t-c', { deliveryId: 'd-once', via: 'send_tool' })).toMatchObject({ kind: 'no_change' });
    const rows = mockDb.current!.prepare(
      `SELECT actor, payload FROM work_events WHERE work_id = 't-c' AND kind = 'person_told'`,
    ).all() as Array<{ actor: string; payload: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].actor).toBe(PRIMARY);
    expect(JSON.parse(rows[0].payload)).toMatchObject({ delivery_id: 'd-once', via: 'send_tool', channel: 'imessage' });
  });

  it('a send the outbound scope later DOWNGRADED to failed stops counting', async () => {
    seedDelivery('d-later-failed');
    expect(recordPersonTold('t-c', { deliveryId: 'd-later-failed', via: 'send_tool' }).kind).toBe('applied');
    expect(candidates()).not.toContain('t-c');
    mockDb.current!.prepare(`UPDATE deliveries SET outcome = 'failed' WHERE id = 'd-later-failed'`).run();
    expect(candidates(), 'the record is only as good as the send it points at').toContain('t-c');
    await driveLadderToTheEnd();
    expect(ownerAlerts().length).toBeGreaterThanOrEqual(1);
  });

  it('it never throws into a send, even when the store cannot be written', () => {
    seedDelivery('d-ro');
    mockDb.current!.exec(`CREATE TRIGGER t142_block BEFORE INSERT ON work_events
      WHEN NEW.kind = 'person_told' BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
    const r = recordPersonTold('t-c', { deliveryId: 'd-ro', via: 'send_tool' });
    expect(r).toMatchObject({ kind: 'refused', reason: 'write-failed' });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — A TELL FROM BEFORE THE EPISODE IS NOT A TELL ABOUT IT.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 the record is scoped to the episode, by the sequence', () => {
  it('told while the work was in progress, then it blocked: the block still reaches the owner', async () => {
    seedWork('t-before');
    seedDelivery('d-progress');
    recordPersonTold('t-before', { deliveryId: 'd-progress', via: 'send_tool' });
    move('t-before', 'blocked');
    age('t-before');
    expect(candidates()).toContain('t-before');
    await driveLadderToTheEnd();
    expect(ownerAlerts().length).toBeGreaterThanOrEqual(1);
  });

  it('a new episode gets its two steers back instead of arriving with the old bound spent', async () => {
    seedBlocked('t-steers');
    await driveLadderToTheEnd();
    move('t-steers', 'claimed');
    move('t-steers', 'blocked');
    age('t-steers');
    expect(escalationSteerCount('t-steers'), 'the new block has been steered zero times').toBe(0);
    await sweep();
    expect(escalationSteerCount('t-steers')).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §7 — IS THE OLD MECHANISM GONE? A census, comments stripped first so a tombstone that
// NAMES the old code is never mistaken for the code (G4).
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§7 the turn-root verify step is gone, and nothing else reads the record but the ladder', () => {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const strip = (s: string): string => s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
  const all = (): Map<string, string> => {
    const out = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'migrations') walk(fp); }
        else if (e.name.endsWith('.ts')) out.set(path.relative(SRC, fp).split(path.sep).join('/'), strip(fs.readFileSync(fp, 'utf8')));
      }
    };
    walk(SRC);
    return out;
  };
  const files = all();
  const filesMatching = (re: RegExp): string[] => [...files].filter(([, s]) => re.test(s)).map(([f]) => f).sort();

  it('no production code computes `spokeSince` or reads the first steer\'s instant', () => {
    expect(filesMatching(/\bspokeSince\b/)).toEqual([]);
    expect(filesMatching(/\bfirstEscalationSteerAt\b/)).toEqual([]);
  });

  it('the turn-root read is gone (t146 deleted it once nothing called it)', () => {
    expect(filesMatching(/\bdeliveryAboutWorkSince\b/)).toEqual([]);
  });

  it('the record has ONE writer and the ladder\'s suppressor is its only reader', () => {
    // The declared list, the constant, and the one module that writes and reads it.
    expect(filesMatching(/WORK_EVENT\.personTold|'person_told'/))
      .toEqual(['work/event-kinds.ts', 'work/tracker-view.ts', 'work/validation-drive.ts']);
    const drive = files.get('work/validation-drive.ts')!;
    expect((drive.match(/appendWorkEvent\(workId, WORK_EVENT\.personTold/g) ?? []).length).toBe(1);
    // THE APPLICATION: the suppressor is what every owner-escalation lens filters on.
    expect((drive.match(/AND NOT \$\{ownerEpisodeSettledExpr\('w'\)\}/g) ?? []).length).toBe(3);
    expect(drive).not.toMatch(/NOT EXISTS \(SELECT 1 FROM work_events e WHERE e\.work_id = w\.id AND e\.kind = 'validation_escalated'\)/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §8 — THE NEW READS TAKE THEIR INDEX ON A GROWN BODY. The suppressor runs for every
// candidate row on every sweep, so each of its work_events / deliveries reads must be an
// index or rowid lookup, never a scan. Read off EXPLAIN QUERY PLAN, not timed (a timing clause
// reds on a loaded box).
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§8 the episode suppressor and the sequence reads take their index', () => {
  it('on 300 rows x 30 events, no work_events or deliveries access is a scan', async () => {
    const { ownerEpisodeSettledExpr } = await import('../validation-drive.js');
    const { validatedExpr, taskScope } = await import('../tracker-view.js');
    const db = mockDb.current!;
    const ins = db.prepare('INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 0; i < 300; i++) {
        seedWork(`g-${i}`, { state: i % 2 ? 'blocked' : 'claimed' });
        for (let e = 0; e < 30; e++) {
          ins.run(`g-${i}`, e % 3 ? 'activity' : 'transition',
            JSON.stringify({ to: e % 2 ? 'blocked' : 'claimed' }), 'agent', T + e);
        }
      }
    })();
    db.exec('ANALYZE');
    const sql = `SELECT w.id, ${validatedExpr('w', 'blocked')} AS v FROM work w
                  WHERE ${taskScope('w')} AND NOT ${ownerEpisodeSettledExpr('w')}`;
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
      .map((r) => r.detail);
    const scans = plan.filter((d) => /^SCAN (e|te|se|td|ne|fe|adj|work_events|deliveries)\b/.test(d));
    expect(scans, plan.join('\n')).toEqual([]);
    expect(plan.some((d) => /idx_work_events_work_id/.test(d)), plan.join('\n')).toBe(true);
  });
});
