// ════════════════════════════════════════════════════════════════════════════════════════
// t146 — THE TOLD-RECORD GETS ITS WRITERS (scenario 5(e): "a blocked task the agent already
// raised with the owner is not raised again").
//
// t142 built the record ("a person was told about this work", `recordPersonTold`) and taught
// the owner-escalation ladder to read it, but left it with no production writer. So at
// `4cb9ed61` an owner told about a blocked task — by the platform's own owner-notice door, or by
// the agent texting him and naming the task — is steered about and told again by the ladder.
//
// The two writers the ruling permits, each driven through its REAL door:
//   §1 the owner-notice door (`sendAlert`) handed the work id as data (`aboutWorkId`);
//   §2 an agent's send tool whose ARGUMENTS name the task (`task_id`), recorded at the single
//      tool-dispatch door (`executeTool`), never from the text and never from the turn.
// And the contract the record enforces through those doors (§3): a send to someone who is
// neither the owner nor the row's requester records nothing; an omitted `task_id` records
// nothing; a notice fired inside an agent's own send opens its OWN scope.
//
// Only the operating-system transport (`child_process`) is replaced, so nothing is texted; the
// bridge itself is started for real, in a scratch home with no Messages database.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t146-told', 'dojo.db'),
  };
});

vi.mock('../../home.js', async () => {
  const p = await import('node:path');
  const o = await import('node:os');
  const dir = p.join((process.env.DOJO_TEST_HOME_ROOT || o.tmpdir()), 'dojo-t146-told');
  return {
    homeDir: (): string => dir,
    dojoDir: (...segs: string[]): string => p.join(dir, '.dojo', ...segs),
    isTestRun: (): boolean => true,
  };
});

vi.mock('../../gateway/ws.js', () => ({
  broadcast: () => { /* frames are not under test */ },
  stampPersistedRow: (e: unknown) => e,
}));

vi.mock('../../agent/runtime.js', () => ({
  getAgentRuntime: () => ({ handleMessage: () => Promise.resolve() }),
}));

const { transport } = vi.hoisted(() => ({ transport: [] as string[] }));
vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const record = (...a: unknown[]): string => { transport.push(JSON.stringify(a)); return ''; };
  return { ...orig, default: { ...orig, execSync: record, execFileSync: record }, execSync: record, execFileSync: record };
});

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

import { runMigrations } from '../../db/migrations.js';
import { transition } from '../../work/store.js';
import { ESCALATION_STEER_MARKER, selectRowsForOwnerEscalation } from '../../work/validation-drive.js';
import { sendAlert, startIMBridge, stopIMBridge } from '../imessage-bridge.js';
import { executeTool } from '../../agent/tools/index.js';
import { withOutboundAsync } from '../../agent/v2/outbound.js';

/** Fictional throughout (G1). */
const PRIMARY = 'primary';
const ASSIGNEE = 'quillon';
const OWNER_PHONE = '+15550100';
const NEIGHBOUR_PHONE = '+15550177';
const OBSTACLE = 'the greenhouse controller rejects every firmware upload with a checksum error';

const T = 1_700_000_000_000;
const NOW = T + 60 * 60_000;
const CUTOFF = NOW - 5 * 60_000;
const SERVICE_IDS = ['dreamer', 'healer'];

const db = (): Database.Database => mockDb.current!;

/** The door call with the work id as data. Typed loosely so the file also runs at 4cb9ed61,
 *  where the door has no such option: the RED is the ladder's behaviour, not a missing type. */
const noticeAbout = (words: string, workId: string): void =>
  (sendAlert as unknown as (m: string, u: 'notice', o: { aboutWorkId: string }) => void)(words, 'notice', { aboutWorkId: workId });

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
  db().prepare(`INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`).run(row);
}

function seedBlocked(id: string, over: Record<string, unknown> = {}): void {
  seedWork(id, over);
  const r = transition(id, {
    to: 'blocked', by: 'agent', actorId: ASSIGNEE,
    reason: 'work_update(action="status") -> blocked', note: OBSTACLE,
  });
  expect(r.kind, `${id} -> blocked`).toBe('applied');
  db().prepare('UPDATE work SET updated_at = ? WHERE id = ?').run(T, id);
}

const toldEvents = (id: string): Array<{ actor: string; via: string }> =>
  (db().prepare(
    `SELECT actor, json_extract(payload, '$.via') AS via FROM work_events
      WHERE work_id = ? AND kind = 'person_told' ORDER BY id`,
  ).all(id) as Array<{ actor: string; via: string }>);

const steersOn = (id: string): number =>
  (db().prepare(
    `SELECT COUNT(*) AS n FROM work_events
      WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.action_taken') = ?`,
  ).get(id, ESCALATION_STEER_MARKER) as { n: number }).n;

const headsUps = (): string[] =>
  (db().prepare(
    `SELECT content FROM messages
      WHERE agent_id = ? AND role = 'system' AND lane = 'owner' AND retired_at IS NULL ORDER BY rowid`,
  ).all(PRIMARY) as Array<{ content: string }>)
    .map((r) => r.content)
    .filter((c) => c.startsWith(OWNER_ALERT_HEADS_UP_PREFIX));

const candidates = (): string[] => selectRowsForOwnerEscalation(CUTOFF, SERVICE_IDS).map((r) => r.id);

async function driveLadderToTheEnd(): Promise<void> {
  const { sweepUnvalidatedTasksForUserEscalation } = await import('../../scheduler/runner.js');
  await sweepUnvalidatedTasksForUserEscalation();
  await sweepUnvalidatedTasksForUserEscalation();
  await sweepUnvalidatedTasksForUserEscalation();
}

/** The agent texts someone through the real tool-dispatch door. */
async function agentTexts(recipient: string, message: string, extra: Record<string, unknown> = {}) {
  return executeTool(PRIMARY, {
    id: `call-${Math.random().toString(36).slice(2)}`,
    name: 'imessage_send',
    arguments: { recipient, message, ...extra },
  });
}

const deliveriesTo = (recipient: string): Array<{ agent_id: string; tool: string; outcome: string }> =>
  db().prepare('SELECT agent_id, tool, outcome FROM deliveries WHERE recipient_id = ? ORDER BY rowid')
    .all(recipient) as Array<{ agent_id: string; tool: string; outcome: string }>;

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  for (const [id, name] of [[PRIMARY, 'Primary'], [ASSIGNEE, 'Quillon']]) {
    db().prepare(`INSERT INTO agents (id, name, status) VALUES (?, ?, 'idle')`).run(id, name);
  }
  db().prepare(
    `INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('imessage_approved_senders', ?, datetime('now'))`,
  ).run(JSON.stringify([
    { address: OWNER_PHONE, name: 'Owner', is_primary: true },
    { address: NEIGHBOUR_PHONE, name: 'Neighbour', is_primary: false },
  ]));
  transport.length = 0;
  vi.setSystemTime(new Date(NOW));
  // The real bridge, started the way the box starts it. Its poll finds no Messages database in
  // the test home and says so; the send door underneath is what this file drives.
  startIMBridge(OWNER_PHONE);
});

afterEach(() => { stopIMBridge(); });

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — the owner-notice door, handed the work id, writes the record.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the owner-notice door records that the owner was told about the row', () => {
  it.fails('RED at 4cb9ed61: a notice about the blocked task reaches the owner, then the ladder raises it again', async () => {
    seedBlocked('t-door');
    noticeAbout('The greenhouse firmware task is blocked: the controller rejects every upload.', 't-door');

    expect(deliveriesTo(OWNER_PHONE).map((d) => d.agent_id), 'the notice reached the owner as the platform').toEqual(['platform']);

    await driveLadderToTheEnd();
    expect(steersOn('t-door'), 'no agent is steered to raise what the owner already has').toBe(0);
    expect(headsUps(), 'and the platform does not tell him a second time').toHaveLength(0);
    expect(toldEvents('t-door'), 'because the door wrote the told record').toEqual([{ actor: 'platform', via: 'owner_notice' }]);
  });

  it('control: the same notice WITHOUT a work id records nothing, and the ladder still runs', async () => {
    seedBlocked('t-door-untold');
    sendAlert('A budget line was crossed.', 'notice');
    expect(toldEvents('t-door-untold')).toHaveLength(0);
    await driveLadderToTheEnd();
    expect(steersOn('t-door-untold')).toBeGreaterThanOrEqual(1);
  });

  it.fails('a notice fired INSIDE an agent send opens its own scope: its own platform row, and the record names it', async () => {
    seedBlocked('t-door-nested');
    await withOutboundAsync(
      { agentId: PRIMARY, tool: 'imessage_send', channel: 'imessage', recipientId: NEIGHBOUR_PHONE },
      async () => { noticeAbout('The greenhouse firmware task is blocked.', 't-door-nested'); },
    );
    expect(deliveriesTo(OWNER_PHONE).map((d) => d.agent_id), 'the notice is the platform\'s own row').toEqual(['platform']);
    expect(toldEvents('t-door-nested')).toEqual([{ actor: 'platform', via: 'owner_notice' }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — the agent's send tool, its arguments naming the task, writes the record.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 an agent text that names its task records that the owner was told', () => {
  it.fails('RED at 4cb9ed61: the agent raised the block with the owner, naming the task, and the ladder raises it again', async () => {
    seedBlocked('t-raised');
    const r = await agentTexts(OWNER_PHONE, 'Heads up: the greenhouse firmware task is stuck on a checksum error.', { task_id: 't-raised' });
    expect(r.kind, JSON.stringify(r)).not.toBe('error');
    expect(deliveriesTo(OWNER_PHONE).map((d) => d.agent_id), 'the text reached the owner as the agent').toEqual([PRIMARY]);

    await driveLadderToTheEnd();
    expect(steersOn('t-raised'), 'the agent is not steered to raise it again').toBe(0);
    expect(headsUps(), 'and the owner is not told a second time').toHaveLength(0);
    expect(candidates()).not.toContain('t-raised');
    expect(toldEvents('t-raised'), 'because the dispatch door wrote the told record').toEqual([{ actor: PRIMARY, via: 'send_tool' }]);
  });

  it.fails('a task id given as an 8+ character prefix resolves to the row, as the work tools resolve it', async () => {
    const id = '9f3c2a71-5d1e-4b8a-a0c4-2e6f1b7d9c03';
    seedBlocked(id);
    await agentTexts(OWNER_PHONE, 'The greenhouse firmware task is stuck.', { task_id: id.slice(0, 8) });
    expect(toldEvents(id)).toEqual([{ actor: PRIMARY, via: 'send_tool' }]);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — the contract, through the real doors: no record is invented.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the record refuses what is not a tell to the owner or the requester', () => {
  it('a text to a NEIGHBOUR naming the task records nothing, and the owner is still told by the ladder', async () => {
    seedBlocked('t-neighbour');
    await agentTexts(NEIGHBOUR_PHONE, 'The greenhouse firmware task is stuck, can you look at the controller?', { task_id: 't-neighbour' });
    expect(deliveriesTo(NEIGHBOUR_PHONE).map((d) => d.outcome), 'the text itself went out').toEqual(['delivered']);
    expect(toldEvents('t-neighbour'), 'a neighbour is not the owner and not the requester').toHaveLength(0);
    await driveLadderToTheEnd();
    expect(steersOn('t-neighbour')).toBeGreaterThanOrEqual(1);
  });

  it('a text to the owner WITHOUT task_id records nothing: no inference from the words or the turn', async () => {
    seedBlocked('t-unnamed');
    await agentTexts(OWNER_PHONE, 'Heads up: task t-unnamed, the greenhouse firmware task, is blocked.');
    expect(deliveriesTo(OWNER_PHONE)).toHaveLength(1);
    expect(toldEvents('t-unnamed'), 'the task id in the TEXT is not the argument').toHaveLength(0);
    await driveLadderToTheEnd();
    expect(steersOn('t-unnamed')).toBeGreaterThanOrEqual(1);
  });

  it.fails('the row\'s own person-requester counts as told', async () => {
    seedBlocked('t-requested', { requester: 'watcher', requester_id: NEIGHBOUR_PHONE });
    await agentTexts(NEIGHBOUR_PHONE, 'Your greenhouse firmware task is stuck on a checksum error.', { task_id: 't-requested' });
    expect(toldEvents('t-requested')).toEqual([{ actor: PRIMARY, via: 'send_tool' }]);
  });

  it('an unknown task id records nothing and does not fail the send', async () => {
    seedBlocked('t-real');
    const r = await agentTexts(OWNER_PHONE, 'The greenhouse firmware task is stuck.', { task_id: 'no-such-task-anywhere' });
    expect(r.kind, JSON.stringify(r)).not.toBe('error');
    expect(deliveriesTo(OWNER_PHONE).map((d) => d.outcome)).toEqual(['delivered']);
    expect(toldEvents('t-real')).toHaveLength(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — the door's dashboard record says whether a card was raised (coordinator, 2026-10-13).
// When the phone cannot carry a notice, the door's `owner-notice` log entry is what the owner
// sees. A status line ("Dojo is online") and an all-clear raise NO card by design (R-V333-13);
// every other notice raises one. The entry says which, so the kit's NO_SILENT_NOTICE_LOSS check
// can tell a deliberately cardless notice on a no-phone box from a notice that was lost.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the owner-notice record says whether a dashboard card was raised', () => {
  const ownerNoticeEntries = async (fire: () => void): Promise<Array<Record<string, unknown> | undefined>> => {
    const seen: Array<{ component: string; meta?: Record<string, unknown> }> = [];
    (await import('../../logger.js')).setLogBroadcast((e) => { seen.push(e); });
    try { fire(); } finally { (await import('../../logger.js')).setLogBroadcast(() => { /* off */ }); }
    return seen.filter((e) => e.component === 'owner-notice').map((e) => e.meta);
  };
  const noPhone = (): void => { db().prepare(`DELETE FROM config WHERE key = 'imessage_approved_senders'`).run(); };

  it.fails('no phone: a notice that raises a card says so; a status line and an all-clear say "none by design"', async () => {
    stopIMBridge();
    noPhone();
    const raised = await ownerNoticeEntries(() => sendAlert('The greenhouse agent is paused after repeated errors.', 'notice'));
    const status = await ownerNoticeEntries(() => sendAlert('Dojo is online at a fictional address.', 'notice', { card: false }));
    const allClear = await ownerNoticeEntries(() => sendAlert('The greenhouse agent recovered.', 'notice', { clears: 'The greenhouse agent is paused after repeated errors.' }));
    expect(raised.map((m) => m?.card)).toEqual(['raised']);
    expect(status.map((m) => m?.card)).toEqual(['none_by_design']);
    expect(allClear.map((m) => m?.card)).toEqual(['none_by_design']);
  });
});
