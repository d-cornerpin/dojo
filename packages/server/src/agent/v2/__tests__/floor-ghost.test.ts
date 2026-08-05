// ════════════════════════════════════════════════════════════════════════════════════════
// OR2's LAST CLAUSE — what happens when a floor is ignored. PHASE-4 T4.
//
// The engine used to answer a ghosting model by SPEAKING FOR IT: a pool line for the A2A
// handoff, the reminder row's own description for the reminder floor, a first-person
// paragraph for the thrash block — every one of them an assistant message on the owner's
// lane that the owner could not tell apart from their agent. OR2 removes exactly that and
// names the replacement: *"a system fault surfaced as the system (health/watchdog voice),
// never the engine wearing the agent's face."*
//
// This file is the replacement, proven three ways per ghost — a ROW, the PLATFORM'S OWN
// VOICE, and the HEALTH SURFACE — plus the two negative controls that keep it honest:
// nothing is written as the agent, and a ghost with no work row forges no id.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { WsEvent } from '@dojo/shared';
import { OWNER_ALERT_HEADS_UP_PREFIX, isOwnerAlertSystemNote } from '@dojo/shared';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join(os.tmpdir(), 'dojo-floor-ghost-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../../db/migrations.js';
import { recordFloorGhost, MAX_FLOOR_STEER_ATTEMPTS } from '../floor-ghost.js';

const AGENT = 'kevin';
const TURN = 77;
const WORK = 'task-ghosted-1';

let frames: WsEvent[] = [];
const broadcast = (e: WsEvent): void => { frames.push(e); };

function workRow(id: string): void {
  const at = Date.now();
  mockDb.current!.prepare(`
    INSERT INTO work (id, kind, agent_id, requester, requester_id, conversation_id,
                      root_kind, root_id, state, intent, wakes, closes_thread,
                      title, opened_at, updated_at, provenance)
    VALUES (?, 'task', ?, 'owner', 'owner', NULL, 'legacy', ?, 'claimed', 'task', 1, 0,
            'the thing that was owed', ?, ?, 'live')
  `).run(id, AGENT, `root:${id}`, at, at);
}

const events = (): Array<{ kind: string; payload: string | null; actor: string }> =>
  mockDb.current!.prepare('SELECT kind, payload, actor FROM work_events WHERE work_id = ? ORDER BY id')
    .all(WORK) as Array<{ kind: string; payload: string | null; actor: string }>;

const messages = (): Array<{ role: string; content: string; origin_intent: string | null }> =>
  mockDb.current!.prepare('SELECT role, content, origin_intent FROM messages WHERE agent_id = ? ORDER BY rowid')
    .all(AGENT) as Array<{ role: string; content: string; origin_intent: string | null }>;

const ghost = (over: Partial<Parameters<typeof recordFloorGhost>[0]> = {}) => recordFloorGhost({
  agentId: AGENT, turnNumber: TURN, floor: 'a2a-handoff-floor', workId: WORK,
  attempts: MAX_FLOOR_STEER_ATTEMPTS,
  ownerLine: 'your agent handed part of this to another agent and then went quiet without telling you.',
  ...over,
}, { broadcast });

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare(
    `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, 'Kevin', 'idle', '1970-01-01')`,
  ).run(AGENT);
  frames = [];
});

describe('the ROW — a ghost is countable, against a denominator', () => {
  it('writes work_events(kind=floor_ghosted) naming the floor and the attempts spent', () => {
    workRow(WORK);
    const rec = ghost();
    expect(rec.eventId).not.toBeNull();
    const rows = events();
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('floor_ghosted');
    expect(rows[0].actor).toBe('engine');
    const payload = JSON.parse(rows[0].payload!);
    expect(payload.floor).toBe('a2a-handoff-floor');
    expect(payload.steer_attempts).toBe(MAX_FLOOR_STEER_ATTEMPTS);
    expect(payload.turn_number).toBe(TURN);
  });

  it('the CHECK migration 152 landed admits it — this is the row T4-SCHEMA declared for', () => {
    workRow(WORK);
    ghost();
    const stored = mockDb.current!.prepare(
      `SELECT COUNT(*) AS c FROM work_events WHERE kind = 'floor_ghosted'`,
    ).get() as { c: number };
    expect(stored.c).toBe(1);
  });

  it('NEGATIVE CONTROL: no work row means NO event — an id is never forged to get one', () => {
    // The work row is deliberately absent. A ghost that invented a parent id would put a
    // record about agent A onto somebody else's work, which is worse than no record.
    const rec = ghost({ workId: 'work-that-does-not-exist' });
    expect(rec.eventId).toBeNull();
    expect(
      (mockDb.current!.prepare('SELECT COUNT(*) AS c FROM work_events').get() as { c: number }).c,
    ).toBe(0);
    // …and the owner is still told. The record failing is not a reason for silence.
    expect(rec.noticeId).not.toBeNull();
  });

  it('NEGATIVE CONTROL: a floor with genuinely no work row writes no event and still speaks', () => {
    const rec = ghost({ workId: null });
    expect(rec.eventId).toBeNull();
    expect(rec.noticeId).not.toBeNull();
  });
});

describe('the PLATFORM’S OWN VOICE — never the agent’s', () => {
  beforeEach(() => workRow(WORK));

  it('the owner-visible note is role=system with the allowlisted platform prefix', () => {
    ghost();
    const rows = messages();
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe('system');
    expect(rows[0].content.startsWith(OWNER_ALERT_HEADS_UP_PREFIX)).toBe(true);
    // The dashboard's own owner-alert allowlist is what decides this reaches the owner's
    // chat, and it is keyed on the shared constant rather than on retyped text.
    expect(isOwnerAlertSystemNote(rows[0].content)).toBe(true);
  });

  it('THE OR2 CLAUSE: not one assistant row is written, on any path', () => {
    ghost();
    ghost({ floor: 'reminder-silence', workId: null });
    expect(messages().filter((m) => m.role === 'assistant')).toEqual([]);
  });

  it('THE OR2 CLAUSE: the note never speaks in the first person', () => {
    ghost();
    const body = messages()[0].content;
    // "I", "I've", "I'll" — the voice the engine used to borrow. The platform says "your
    // agent", which is a sentence only the platform can be saying.
    expect(/\b(I|I['’](?:ve|ll|m))\b/.test(body)).toBe(false);
    expect(body).toContain('your agent');
  });

  it('carries no origin_intent stamp — it is not a delivery and must not read as one', () => {
    ghost();
    expect(messages()[0].origin_intent).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// THE ANNOUNCEMENT — SWEEP-A TB4, and it is a RED the full battery found.
//
// Battery `bmsgc3l0cnb` tripped `BROADCAST_EQUALS_ROW` for the FIRST TIME IN THE INVARIANT'S
// LIFE on this module's own row: *"1 SILENT INSERT(S): a user-visible row was written and
// never announced on chat:message, interagent:message or chat:workingnote (reload-only;
// appears out of nowhere on refresh)"* — message `94f56e36-f107-42ab-bde6-c585e2a2dc62`,
// `role=system / lane=owner / display_kind=owner-alert`, written by TB2's ladder at rung 6.
//
// The row was ALWAYS user-visible; what was missing was the wire. Part 2 of this module wrote
// it and part 3 broadcast a `chat:error` — a health frame, on a different channel, carrying no
// message id — so the owner learned about a platform fault only by reloading the page. That is
// research 17's D4 ("reload-only rows") exactly, on the one surface whose whole job is to be
// noticed.
//
// WHAT IS AND IS NOT CHANGED. The OR2 boundary is untouched: the platform still says the same
// sentence, still as `role='system'`, still only when the ladder's bound is spent. Only WHERE
// it is announced changed — it now rides the SAME `chat:message` frame every other owner-lane
// system row rides (`destructive-gate.ts:notifyOwnerApprovalExpired`,
// `scheduler/runner.ts:postSkippedReminderHeadsUp`, `a2a-transport.ts`'s platform-voice join
// notice), which is the one announce path for these rows and gets the ws seam's row stamp for
// free. No new mechanism, no second broadcast path, and the health frame stays exactly as it
// was — the two surfaces answer different questions.
//
// The clauses below are the kit invariant's own three, in miniature and offline: every
// user-visible row this call wrote is announced under ITS OWN id (clause 3), no frame is
// emitted for an id with no row (clause 1), and the announcement is not an assistant bubble.
// ════════════════════════════════════════════════════════════════════════════════════════
describe('THE ANNOUNCEMENT — the platform’s own voice reaches the socket, not just the table', () => {
  /** Every id a `chat:message` frame announced, in emission order. */
  const announced = (): string[] => frames
    .filter((f) => f.type === 'chat:message')
    .map((f) => (f as { message?: { id?: string } }).message?.id)
    .filter((id): id is string => typeof id === 'string');

  /** Every row this call wrote that the display taxonomy calls user-visible. */
  const userVisibleRows = (): Array<{ id: string; role: string; content: string; display_kind: string }> =>
    mockDb.current!.prepare(
      `SELECT id, role, content, display_kind FROM messages
        WHERE agent_id = ? AND display_tier = 'user-visible' ORDER BY rowid`,
    ).all(AGENT) as Array<{ id: string; role: string; content: string; display_kind: string }>;

  it('the owner-alert row is ANNOUNCED on chat:message under its own id', () => {
    workRow(WORK);
    const rec = ghost();
    expect(rec.noticeId).not.toBeNull();
    expect(announced()).toContain(rec.noticeId!);
  });

  it('THE BATTERY’S RED, at the ladder’s own call shape: no silent insert', () => {
    // `bmsgc3l0cnb`'s row exactly — TB2's rung 6: the out-of-band subject, no turn (a SWEEP
    // has none), the delegated-job line. This is the shape that went out user-visible and
    // unannounced, and it is the one the clause has to hold for.
    workRow(WORK);
    ghost({
      floor: 'delegated-job-stuck', turnNumber: null,
      ownerLine:
        'your agent delegated part of a request, the pieces came back, and it has not been able to '
        + 'finish or report on it — the platform steered it several times and got no reply.',
    });
    const rows = userVisibleRows();
    expect(rows.length).toBe(1);
    const silent = rows.filter((r) => !announced().includes(r.id));
    expect(silent.map((r) => `${r.display_kind}:${r.content.slice(0, 40)}`)).toEqual([]);
  });

  it('the frame carries the row’s own role and text — a system note, never an assistant bubble', () => {
    workRow(WORK);
    const rec = ghost();
    const frame = frames.find(
      (f) => f.type === 'chat:message' && (f as { message?: { id?: string } }).message?.id === rec.noticeId,
    ) as { agentId?: string; message?: { role?: string; content?: string } } | undefined;
    expect(frame).toBeDefined();
    expect(frame!.agentId).toBe(AGENT);
    expect(frame!.message!.role).toBe('system');
    expect(frame!.message!.content).toBe(userVisibleRows()[0].content);
    expect(frames.filter((f) => f.type === 'chat:message')
      .filter((f) => (f as { message?: { role?: string } }).message?.role === 'assistant')).toEqual([]);
  });

  it('NEGATIVE CONTROL: no ORPHAN BROADCAST — every announced id resolves to a real row', () => {
    workRow(WORK);
    ghost();
    ghost({ floor: 'reminder-silence', workId: null });
    for (const id of announced()) {
      const row = mockDb.current!.prepare('SELECT id FROM messages WHERE id = ?').get(id);
      expect(row, `announced id ${id} has no row (live-only; vanishes on refresh)`).toBeDefined();
    }
  });

  it('NEGATIVE CONTROL: the health frame is still its own surface, not the announcement', () => {
    // Two frames, two questions. `chat:error` is the dashboard's platform-fault indicator and
    // names no message id; collapsing them would either lose the fault badge or re-introduce
    // the silent insert. Both must be present, and exactly once each.
    workRow(WORK);
    ghost();
    expect(frames.filter((f) => f.type === 'chat:error').length).toBe(1);
    expect(frames.filter((f) => f.type === 'chat:message').length).toBe(1);
  });

  it('NEGATIVE CONTROL: a broadcast that throws still leaves both durable halves written', () => {
    workRow(WORK);
    const rec = recordFloorGhost({
      agentId: AGENT, turnNumber: null, floor: 'delegated-job-stuck', workId: WORK,
      attempts: 5, ownerLine: 'your agent went quiet.',
    }, { broadcast: () => { throw new Error('ws is down'); } });
    expect(rec.eventId).not.toBeNull();
    expect(rec.noticeId).not.toBeNull();
    expect(userVisibleRows().length).toBe(1);
  });
});

describe('the HEALTH SURFACE — a platform fault shows up as one', () => {
  beforeEach(() => workRow(WORK));

  it('broadcasts chat:error FLOOR_GHOSTED at warning severity', () => {
    ghost();
    const errs = frames.filter((f) => f.type === 'chat:error');
    expect(errs.length).toBe(1);
    const e = errs[0] as { code?: string; severity?: string; retryable?: boolean; error: string };
    expect(e.code).toBe('FLOOR_GHOSTED');
    expect(e.severity).toBe('warning');
    expect(e.retryable).toBe(false);
    expect(e.error).toContain('went quiet');
  });

  it('NEGATIVE CONTROL: a broadcast that throws never costs the durable halves', () => {
    const rec = recordFloorGhost({
      agentId: AGENT, turnNumber: TURN, floor: 'a2a-handoff-floor', workId: WORK,
      attempts: 2, ownerLine: 'your agent went quiet.',
    }, { broadcast: () => { throw new Error('ws is down'); } });
    expect(rec.eventId).not.toBeNull();
    expect(rec.noticeId).not.toBeNull();
  });
});

describe('the bound is TWO, and it is declared rather than inlined', () => {
  it('MAX_FLOOR_STEER_ATTEMPTS is 2 — the plan’s "bounded re-steer (2 attempts)"', () => {
    expect(MAX_FLOOR_STEER_ATTEMPTS).toBe(2);
  });
});
