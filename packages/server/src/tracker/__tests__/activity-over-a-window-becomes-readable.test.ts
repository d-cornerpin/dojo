// ════════════════════════════════════════════════════════════════════════════════════════
// UX-REPAIR ROUND 13 / T60 — ACTIVITY OVER A WINDOW BECOMES READABLE.
//
// ── THE INCIDENT (round-13 S4, catalog §8.2–8.6, orchestrator-read) ──────────────────────
// The owner asked what had happened today. The turn made exactly ONE read —
// `work_update(action="list")` — and answered "Quiet day so far … nothing else changed on
// the tracker." The recorder's own independent count of the same window: 57 work rows
// OPENED and 57 CLOSED, 283 `work_events`, 142 deliveries, a whole delegated project run
// end-to-end and PM-validated. Catalog §8.5 marks both sentences UNBACKED.
//
// The list door is not at fault: it answers "what is open RIGHT NOW", and it answered that
// correctly (3 open rows). The finding is that NO surface anywhere served activity over a
// WINDOW — the two quantities are different questions, and only one of them had a door. The
// data was never missing: `work.opened_at` / `work.closed_at`, `work_events.created_at`,
// `deliveries.created_at` and `adjudications.created_at` are all timestamped and all were
// already on the box. The model guessed because honesty was structurally impossible.
//
// WHAT THIS PINS:
//   RED   — at HEAD `work_update(action="activity")` falls through to the LIST door (the
//           absorb-don't-refuse ladder's default) and returns current state, so a turn that
//           asks "what changed today" is handed "what is open now" and cannot tell.
//   GREEN — the activity door renders the window's own ledger: opened/closed by kind and by
//           outcome, scheduled runs fired, PM rulings, deliveries that reached a person,
//           notable rows titled and the rest COUNTED behind an elision line that states the
//           whole number (the HL5 snapshot's honesty idiom).
//   CONTROLS — the list output is byte-identical to HEAD except for the one registered
//           pointer sentence; the activity door performs NO write (no work rows, no
//           work_events, no deliveries appear because it was called).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t60-test', 'dojo.db'),
  };
});
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));

import { runMigrations } from '../../db/migrations.js';
import { openTrackerProject, openTrackerTask } from '../../work/tracker-store.js';
import { appendWorkEvent } from '../../work/store.js';
import { trackerListActive, trackerActivity, ACTIVITY_POINTER } from '../tools.js';
import { workOperation } from '../../tools/work-verbs.js';
import { trackerHandlers } from '../../agent/tools/cat/tracker.js';

const AGENT = 'behaviorbot';
const OTHER = 'ticky';

/** Local midnight for the box zone, in epoch ms — the door's own default window start. */
function localMidnightMs(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function seedWork(over: {
  id: string; kind: string; agent?: string; state?: string; title?: string | null;
  openedAt?: number; closedAt?: number | null;
}): void {
  const db = mockDb.current!;
  const at = over.openedAt ?? localMidnightMs() + 60_000;
  const state = over.state ?? 'open';
  // The spine's own CHECK: `done` means DELIVERED, so a done row must name its delivery.
  // The delivery rides an `a2a` channel here so that seeding a closed row never inflates
  // the door's people-reaching count — the delivery cases seed their own rows.
  let delivery: string | null = null;
  if (state === 'done') {
    delivery = `del-${over.id}`;
    seedDelivery(delivery, 'a2a', over.agent ?? AGENT);
  }
  db.prepare(`
    INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent,
                      wakes, closes_thread, title, opened_at, closed_at, updated_at,
                      result_delivery_id, provenance)
    VALUES (?, ?, ?, 'owner', 'ask', ?, ?, 'ask', 1, 0, ?, ?, ?, ?, ?, 'live')
  `).run(
    over.id, over.kind, over.agent ?? AGENT, `root-${over.id}`, state,
    over.title ?? null, at, over.closedAt ?? null, at, delivery,
  );
}

function seedDelivery(id: string, channel: string, agent = AGENT): void {
  mockDb.current!.prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, outcome, created_at)
     VALUES (?, ?, 'chat', ?, 'sent', datetime('now'))`,
  ).run(id, agent, channel);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.pragma('foreign_keys = ON');
  for (const a of [AGENT, OTHER]) {
    db.prepare(
      `INSERT INTO agents (id, name, status, session_started_at) VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(a, a);
  }
});

// ── RED ─────────────────────────────────────────────────────────────────────────────────

describe('T60 RED — the door the S4 turn needed did not exist', () => {
  it('action="activity" routes to its own operation, not to the list default', () => {
    // At HEAD `workOperation` has no `activity` arm, so the ladder's terminal `return
    // 'work_update:list'` claims it: the model asks what CHANGED and is answered with what
    // is OPEN, with nothing in the result saying the question was swapped.
    expect(workOperation('work_update', { action: 'activity' })).toBe('work_update:activity');
    expect(trackerHandlers['work_update:activity']).toBeDefined();
  });

  it('the S4 shape: 57 opened and 57 closed today, 3 still open — the list says "3", activity says both', async () => {
    // The catalog's own numbers, at the catalog's own scale.
    const base = localMidnightMs() + 60_000;
    for (let i = 0; i < 54; i++) {
      seedWork({ id: `ask-${i}`, kind: 'ask', state: 'done', title: `probe ${i}`,
        openedAt: base + i * 1000, closedAt: base + i * 1000 + 500, delivery: null });
    }
    seedWork({ id: 'cmt-1', kind: 'commitment', state: 'abandoned', title: 'send the summary',
      openedAt: base, closedAt: base + 1000 });
    seedWork({ id: 'cmt-2', kind: 'commitment', state: 'abandoned', title: 'send the other summary',
      openedAt: base, closedAt: base + 1000 });
    seedWork({ id: 'proj-1', kind: 'project', state: 'done', title: 'Leavenworth dog trip day plan',
      openedAt: base, closedAt: base + 1000 });
    // The three the list door shows, opened yesterday and still open.
    const yesterday = localMidnightMs() - 3_600_000;
    seedWork({ id: 'open-1', kind: 'task', state: 'on_deck', title: 'Reminder: dentist', openedAt: yesterday });
    seedWork({ id: 'open-2', kind: 'task', state: 'on_deck', title: 'Reminder: meds', openedAt: yesterday });
    seedWork({ id: 'open-3', kind: 'task', state: 'paused', title: 'Reorganize project notes', openedAt: yesterday });

    const activity = trackerActivity(AGENT, {});
    expect(activity).toMatch(/Opened \(57\)/);
    expect(activity).toMatch(/Closed \(57\)/);
    expect(activity).toMatch(/55 done/);
    expect(activity).toMatch(/2 abandoned/);
  });
});

// ── GREEN: what the door actually renders ───────────────────────────────────────────────

describe('T60 — the activity door renders the window\'s own ledger', () => {
  it('counts opened by kind and closed by outcome, and names the window it measured', () => {
    const base = localMidnightMs() + 60_000;
    seedWork({ id: 'a1', kind: 'ask', state: 'done', title: 'answered ask', openedAt: base, closedAt: base + 10 });
    seedWork({ id: 't1', kind: 'task', state: 'failed', title: 'a task that fell', openedAt: base, closedAt: base + 10 });
    seedWork({ id: 'p1', kind: 'project', state: 'open', title: 'a live project', openedAt: base });

    const out = trackerActivity(AGENT, {});
    expect(out).toMatch(/since local midnight/i);
    expect(out).toMatch(/Opened \(3\): /);
    expect(out).toMatch(/1 ask/);
    expect(out).toMatch(/1 task/);
    expect(out).toMatch(/1 project/);
    expect(out).toMatch(/Closed \(2\): 1 done, 1 failed/);
  });

  it('rows opened BEFORE the window are not counted as opened, and rows closed inside it are', () => {
    const yesterday = localMidnightMs() - 7_200_000;
    seedWork({ id: 'y1', kind: 'task', state: 'done', title: 'opened yesterday, closed today',
      openedAt: yesterday, closedAt: localMidnightMs() + 60_000 });
    const out = trackerActivity(AGENT, {});
    expect(out).toMatch(/Opened \(0\)|Nothing opened/);
    expect(out).toMatch(/Closed \(1\): 1 done/);
    expect(out).toContain('opened yesterday, closed today');
  });

  it('scheduled runs that fired are counted from the occurrence events, not guessed', () => {
    const base = localMidnightMs() + 60_000;
    seedWork({ id: 'occ-1', kind: 'occurrence', state: 'done', title: null, openedAt: base, closedAt: base + 5 });
    appendWorkEvent('occ-1', 'occurrence_fired', 'engine', { seq: 1 });
    const out = trackerActivity(AGENT, {});
    expect(out).toMatch(/Scheduled runs fired: 1/);
  });

  it('a window with nothing in it SAYS SO — the empty answer is stated, never implied', () => {
    const out = trackerActivity(AGENT, {});
    expect(out).toMatch(/nothing is recorded/i);
    expect(out).toMatch(/0 rows opened/);
    // And it never invents the word the S4 reply used.
    expect(out.toLowerCase()).not.toContain('quiet');
  });

  it('deliveries that reached a person are counted by channel; a2a traffic is not a person', () => {
    seedDelivery('d1', 'dashboard');
    seedDelivery('d2', 'imessage');
    seedDelivery('d3', 'imessage');
    seedDelivery('d4', 'a2a');
    const out = trackerActivity(AGENT, {});
    expect(out).toMatch(/Delivered to people \(3\)/);
    expect(out).toMatch(/imessage 2/);
    expect(out).toMatch(/dashboard 1/);
    expect(out).not.toMatch(/a2a/);
  });

  it('another agent\'s rows are not this agent\'s activity', () => {
    const base = localMidnightMs() + 60_000;
    seedWork({ id: 'mine', kind: 'ask', state: 'done', title: 'mine', openedAt: base, closedAt: base + 5 });
    seedWork({ id: 'theirs', kind: 'ask', agent: OTHER, state: 'done', title: 'theirs', openedAt: base, closedAt: base + 5 });
    const out = trackerActivity(AGENT, {});
    expect(out).toMatch(/Opened \(1\)/);
    expect(out).toContain('mine');
    expect(out).not.toContain('theirs');
  });

  it('the elision line states the WHOLE count — rows not listed are counted, never dropped', () => {
    const base = localMidnightMs() + 60_000;
    for (let i = 0; i < 30; i++) {
      seedWork({ id: `r-${i}`, kind: 'ask', state: 'done', title: `row ${i}`,
        openedAt: base + i * 100, closedAt: base + i * 100 + 10 });
    }
    const out = trackerActivity(AGENT, {});
    expect(out).toMatch(/Opened \(30\)/);
    // Some rows are titled, the rest counted, and the elision names the complete number.
    expect(out).toMatch(/… and \d+ more row/);
    expect(out).toMatch(/30 above is the complete number/);
  });
});

// ── CONTROLS ────────────────────────────────────────────────────────────────────────────

describe('T60 CONTROLS — the list door is untouched but for one sentence, and nothing is written', () => {
  it('the list output is byte-identical to HEAD except for the registered pointer line', () => {
    const projectId = openTrackerProject({
      title: 'Live project', createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
    });
    openTrackerTask({
      projectId, title: 'A task', status: 'in_progress', assignedTo: AGENT, createdBy: AGENT,
      origin: { kind: 'agent', sourceMessageId: null, turn: null, convKey: null },
    });
    const out = trackerListActive(AGENT, { scope: 'all' });
    expect(out).toContain(ACTIVITY_POINTER);
    // Everything else: the same rendering the S4 catalog transcribed.
    const withoutPointer = out.split(ACTIVITY_POINTER)[0].trimEnd();
    expect(withoutPointer).toContain('Active Projects (1):');
    expect(withoutPointer).toContain('In Progress Tasks (1):');
    expect(withoutPointer).toContain('task/project row');
    // The one sentence is the ONLY place the new door is named.
    expect(withoutPointer).not.toContain('action="activity"');
  });

  it('an EMPTY board still carries the pointer — the empty board is when the guess happens', () => {
    const out = trackerListActive(AGENT, { scope: 'all' });
    expect(out).toContain('No active projects.');
    expect(out).toContain(ACTIVITY_POINTER);
  });

  it('the activity door has NO write path: no work rows, no events, no deliveries', () => {
    const base = localMidnightMs() + 60_000;
    seedWork({ id: 'w1', kind: 'ask', state: 'done', title: 'a row', openedAt: base, closedAt: base + 5 });
    const db = mockDb.current!;
    const before = {
      work: (db.prepare('SELECT COUNT(*) c FROM work').get() as { c: number }).c,
      events: (db.prepare('SELECT COUNT(*) c FROM work_events').get() as { c: number }).c,
      deliveries: (db.prepare('SELECT COUNT(*) c FROM deliveries').get() as { c: number }).c,
    };
    trackerActivity(AGENT, {});
    trackerActivity(AGENT, {});
    const after = {
      work: (db.prepare('SELECT COUNT(*) c FROM work').get() as { c: number }).c,
      events: (db.prepare('SELECT COUNT(*) c FROM work_events').get() as { c: number }).c,
      deliveries: (db.prepare('SELECT COUNT(*) c FROM deliveries').get() as { c: number }).c,
    };
    expect(after).toEqual(before);
  });

  it('the door is a READ operation everywhere the engine keys on read-ness', async () => {
    const { isWorkReadOp } = await import('../../tools/work-verbs.js');
    const { classifyConcurrency } = await import('../../agent/v2/classifiers/concurrency.js');
    expect(isWorkReadOp('work_update:activity')).toBe(true);
    expect(classifyConcurrency('work_update', { action: 'activity' })).toBe('safe');
  });
});
