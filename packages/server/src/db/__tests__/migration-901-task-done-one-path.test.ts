// Migration 901 on a lived-in box: every board task and project lands in the new states with nothing lost
// and nothing woken, history is appended, the old trigger and dead columns go, and the file runs once.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task } from '@dojo/shared';

vi.mock('../connection.js', async () => (await import('../../work/done/__tests__/helpers/done-db.js')).connectionMock());
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

import { runMigrations } from '../migrations.js';
import { getTask } from '../../tracker/schema.js';
import { freshDoneDb, doneDb } from '../../work/done/__tests__/helpers/done-db.js';
import { boxBefore901, seedLivedInBox, upgrade, FILE } from './helpers/a-box-before-901.js';

type Row = Record<string, unknown>;
const all = (sql: string, ...p: unknown[]): Row[] => doneDb().prepare(sql).all(...p) as Row[];
const one = (sql: string, ...p: unknown[]): Row => doneDb().prepare(sql).get(...p) as Row;
const work = (id: string): Row => one('SELECT * FROM work WHERE id = ?', id);
const entriesOf = (id: string, entry: string): Row[] =>
  all("SELECT * FROM work_events WHERE work_id = ? AND kind = 'audit' AND json_extract(payload, '$.entry_kind') = ?", id, entry);
const eventsOf = (id: string, kind: string): Row[] => all('SELECT * FROM work_events WHERE work_id = ? AND kind = ? ORDER BY id', id, kind);

/** What each class lands as: its state and its hold. */
const LANDS: Record<string, { state: string | 'same'; hold: string | null | 'old' }> = {
  history_done: { state: 'done', hold: null }, history_failed: { state: 'failed', hold: null }, history_abandoned: { state: 'abandoned', hold: null },
  blocked: { state: 'claimed', hold: 'blocked' }, paused: { state: 'claimed', hold: 'paused' }, on_deck: { state: 'open', hold: null },
  claimed: { state: 'claimed', hold: null }, open: { state: 'open', hold: null },
  rehandin: { state: 'claimed', hold: null }, rehandin_recurring: { state: 'claimed', hold: null }, sent_back: { state: 'sent_back', hold: null },
  project_empty: { state: 'open', hold: null }, project_working: { state: 'claimed', hold: null }, project_done: { state: 'done', hold: null },
  project_paused: { state: 'open', hold: 'paused' }, project_blocked: { state: 'open', hold: 'blocked' },
  project_abandoned: { state: 'abandoned', hold: null },
};

let ids: Record<string, string[]>;
let before: { work: Row[]; events: Row[]; seq: number; adjudications: Row[]; deliveries: number; messages: number };

beforeEach(() => {
  boxBefore901();
  ids = seedLivedInBox();
  before = {
    work: all('SELECT * FROM work ORDER BY id'),
    events: all('SELECT * FROM work_events ORDER BY id'),
    seq: (one("SELECT seq FROM sqlite_sequence WHERE name = 'work_events'") as { seq: number }).seq,
    adjudications: all('SELECT * FROM adjudications ORDER BY id'),
    deliveries: (one('SELECT COUNT(*) AS n FROM deliveries') as { n: number }).n,
    messages: (one('SELECT COUNT(*) AS n FROM messages') as { n: number }).n,
  };
  upgrade();
});

const old = (id: string): Row => before.work.find((r) => r.id === id)!;
/** The row before and after, over the columns both schemas have. */
const unchanged = (id: string): void => {
  const now = work(id), was = old(id);
  const shared = (r: Row): Row => Object.fromEntries(Object.entries(r).filter(([k]) => k in now && k in was));
  expect(shared(now), id).toEqual(shared(was));
};

describe('migration 901 on a lived-in box', () => {
  it('1. every row lands in the state and hold of its class, and rows that are not board work are untouched', () => {
    for (const [cls, rows] of Object.entries(ids)) {
      for (const id of rows) {
        const w = work(id);
        if (cls === 'not_board') { unchanged(id); continue; }
        expect([cls, id, w.state, w.hold_kind]).toEqual([cls, id, LANDS[cls].state, LANDS[cls].hold]);
      }
    }
    expect(work('t-blocked-reason').hold_reason).toBe("waiting on the owner's login");
    expect(work('t-blocked-unvalidated').hold_reason).toBe('the venue is closed on weekends');
    expect(work('t-blocked-bare').hold_reason).toBe('Blocked before the upgrade; no reason recorded.');
    expect(work('t-blocked-tool-reason').hold_reason).toBe('waiting for the vendor quote');
    expect(work('t-blocked-dashboard').hold_reason).toBe('Blocked before the upgrade; no reason recorded.');
    expect(work('t-paused-named').hold_reason).toBe('Paused before the upgrade; no reason recorded.');
    expect(work('t-piece-paused')).toMatchObject({ state: 'claimed', hold_kind: 'paused', hold_reason: 'Paused before the upgrade; no reason recorded.' });
    expect(work('t-paused-step').hold_at).toBe(old('t-paused-step').updated_at);
    expect(work('t-paused-until').paused_until).toBe(old('t-paused-until').paused_until);
    for (const id of ['t-paused-pm-confirmed', 't-blocked-pm-confirmed']) expect(entriesOf(id, 'upgrade_rehandin_hint'), id).toHaveLength(0);
  });

  it('2. a filed close or an open request comes back to Working with one hint, its requests answered once, a recurring stop paused', () => {
    for (const id of [...ids.rehandin, ...ids.rehandin_recurring]) {
      expect(entriesOf(id, 'upgrade_rehandin_hint'), id).toHaveLength(1);
      expect(work(id).hold_kind, id).toBeNull();
    }
    expect(entriesOf('t-claimed-fresh', 'upgrade_rehandin_hint')).toHaveLength(0);
    expect(eventsOf('t-override-open', 'override_resolved').map((e) => e.actor)).toEqual(['migration-901']);
    expect(eventsOf('t-verdict-open', 'user_verdict_cleared').map((e) => e.actor)).toEqual(['migration-901']);
    expect(work('t-recurring-stop')).toMatchObject({ is_paused: 1, schedule_status: 'paused' });
  });

  it('3. a project is derived from its tasks, and a derived Done stands on its newest done task\'s delivery', () => {
    expect(work('p-all-done')).toMatchObject({ state: 'done', result_delivery_id: work('t-child-done-2').result_delivery_id });
    expect(work('p-all-done').closed_at).not.toBeNull();
    expect(work('p-done-one-cancelled-child').state).toBe('done');
    expect(work('p-on-deck-all-done')).toMatchObject({ state: 'done', result_delivery_id: work('t-on-deck-child-done').result_delivery_id });
    expect(all(`SELECT p.id FROM work p WHERE p.kind = 'project' AND p.state NOT IN ('done','failed','abandoned')
      AND EXISTS (SELECT 1 FROM work c WHERE c.parent_id = p.id AND c.kind = 'task')
      AND NOT EXISTS (SELECT 1 FROM work c WHERE c.parent_id = p.id AND c.kind = 'task' AND c.state NOT IN ('done','abandoned'))`)).toEqual([]);
  });

  it('4. a live row with no goal takes its description or title, recorded on its trail; finished rows keep theirs', () => {
    expect(work('t-blocked-bare').goal).toBe('Fix the printer queue');
    expect(work('t-blocked-unvalidated').goal).toBe('Book the venue');
    expect(work('p-empty').goal).toBe('Plan the move');
    expect(entriesOf('p-empty', 'upgrade_mapped').map((e) => JSON.parse(String(e.payload)).action_taken)).toEqual(['goal from description']);
    expect(work('t-done-measured').goal).toBeNull();
  });

  it('5. history is appended only: every old event is still there by id, and the counter never goes back', () => {
    const now = all('SELECT * FROM work_events ORDER BY id');
    expect(now.slice(0, before.events.length)).toEqual(before.events);
    const added = now.slice(before.events.length);
    expect(added.every((e) => e.actor === 'migration-901')).toBe(true);
    const live = Object.entries(ids).filter(([c]) => !c.startsWith('history') && c !== 'not_board').flatMap(([, r]) => r);
    const changed = Object.values(ids).flat().filter((id) => old(id).state !== work(id).state);
    const hints = ids.rehandin.length + ids.rehandin_recurring.length;
    expect(added).toHaveLength(changed.length + live.length + hints + 2);
    expect(added.filter((e) => e.kind === 'transition')).toHaveLength(changed.length);
    expect((one("SELECT seq FROM sqlite_sequence WHERE name = 'work_events'") as { seq: number }).seq).toBeGreaterThanOrEqual(before.seq);
    for (const id of ['t-done-validated', 't-failed', 'p-done']) unchanged(id);
  });

  it('6. nothing is woken: the wake columns are as they were but for the recurring stop, and nothing was sent', () => {
    const wake = ['wakes', 'ttl_at', 'next_attempt_at', 'next_run_at', 'is_paused', 'schedule_status'];
    for (const r of before.work) {
      if (r.id === 't-recurring-stop') continue;
      // A later step hands an old missed-runs pause back to the scheduler, which decides it on its next pass.
      const handedBack = r.id === 't-missed-runs' ? { is_paused: 0, schedule_status: 'waiting' } : {};
      for (const c of wake) expect([r.id, c, work(String(r.id))[c]]).toEqual([r.id, c, c in handedBack ? handedBack[c as keyof typeof handedBack] : r[c]]);
    }
    expect((one('SELECT COUNT(*) AS n FROM deliveries') as { n: number }).n).toBe(before.deliveries);
    expect((one('SELECT COUNT(*) AS n FROM messages') as { n: number }).n).toBe(before.messages);
  });

  it('7. the old two-key trigger is gone, the decisions table is intact, and the dead columns are dropped', () => {
    expect(one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'two_key_completion'")).toEqual({ n: 0 });
    expect(all('SELECT * FROM adjudications ORDER BY id')).toEqual(before.adjudications);
    expect(one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'adjudications_event_seq'")).toEqual({ n: 1 });
    const cols = (all('PRAGMA table_info(work)') as Array<{ name: string }>).map((c) => c.name);
    for (const gone of ['completion_summary', 'last_smell_flag', 'status_before_pause', 'effort_calls', 'effort_reviewed_calls',
      'last_activity_turn', 'last_activity_at', 'last_activity_outcome', 'last_answered_turn', 'last_answered_at', 'last_delivery_summary']) {
      expect(cols).not.toContain(gone);
    }
    expect((all('PRAGMA table_info(turn_artifacts)') as Array<{ name: string }>).map((c) => c.name)).not.toContain('delivery_id');
  });

  it('8. board work reaches done or failed only on an upheld decision for that outcome', () => {
    for (const to of ['done', 'failed']) {
      const id = to === 'done' ? 't-claimed-fresh' : 't-open';
      const move = (): unknown => doneDb().prepare(`UPDATE work SET state = ?, closed_at = 1, result_delivery_id = ? WHERE id = ?`)
        .run(to, work('t-done-validated').result_delivery_id, id);
      expect(move).toThrow(/only on an upheld decision/);
      doneDb().prepare("INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at) VALUES (?, ?, 'rejected', 'pm', 1)").run(id, to);
      expect(move).toThrow(/only on an upheld decision/);
      doneDb().prepare("INSERT INTO adjudications (work_id, claim_state, verdict, by_agent, created_at) VALUES (?, ?, 'upheld', 'pm', 1)").run(id, to);
      expect(move).not.toThrow();
    }
    expect(() => doneDb().prepare("UPDATE work SET state = 'open', closed_at = NULL WHERE id = 't-done-engine'").run()).not.toThrow();
  });

  it('9. a second boot does not run it again: its subject column is gone, so the runner records it and changes nothing', () => {
    const snapshot = (): unknown => [all('SELECT * FROM work ORDER BY id'), all('SELECT * FROM work_events ORDER BY id')];
    const was = snapshot();
    doneDb().prepare('DELETE FROM _migrations WHERE name = ?').run(FILE);
    runMigrations();
    expect(snapshot()).toEqual(was);
    expect(one('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?', FILE)).toEqual({ n: 1 });
  });

  it('10. the report counts each class as seeded, and the retired switches are gone', () => {
    const report = JSON.parse(String(one("SELECT value FROM config WHERE key = 'task_done_upgrade_last'").value));
    const seeded = Object.fromEntries(Object.entries(ids).filter(([c]) => c !== 'not_board').map(([c, r]) => [c, r.length]));
    expect(report.classes).toEqual(seeded);
    expect(report.orphan_events).toBe(2);
    expect(all("SELECT key FROM config WHERE key IN ('pm_agent_enabled','trainer_agent_enabled','imaginer_enabled')")).toEqual([]);
    expect(one("SELECT value FROM config WHERE key = 'healer_mode'").value).toBe('monitor');
  });

  it('10b. the decision model\'s shadow log, its unread records and the old summary-writer wait records are gone', () => {
    expect(one("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'decision_shadow'")).toEqual({ n: 0 });
    expect(all("SELECT key FROM config WHERE key IN ('decision_switch.memory_shape.filler', 'decision_mode.inbound_routing.deliverable', 'decide_pace.m-decision', 'token_density.m-decision')")).toEqual([]);
    expect(all("SELECT scope FROM healer_state WHERE scope LIKE 'summary%' ORDER BY scope")).toEqual([]);
    expect(all('PRAGMA table_info(summary_checks)').map((c) => c.name)).toEqual(['id', 'agent_id', 'writer_model_id', 'outcome', 'stated_current', 'created_at']);
  });

  it('11. a fresh install applies the whole chain on an empty database', () => {
    freshDoneDb();
    runMigrations();
    expect(one('SELECT COUNT(*) AS n FROM _migrations WHERE name = ?', FILE)).toEqual({ n: 1 });
    expect(JSON.parse(String(one("SELECT value FROM config WHERE key = 'task_done_upgrade_last'").value)).classes).toEqual({});
    expect(one("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name = 'board_done_needs_decision'")).toEqual({ n: 1 });
  });

  it('12. every migrated board task reads with a status the board has a column for', () => {
    const wire = { on_deck: 1, in_progress: 1, handed_in: 1, sent_back: 1, complete: 1, fallen: 1, cancelled: 1 } satisfies Record<Task['status'], 1>;
    const tasks = all("SELECT id FROM work WHERE kind = 'task' AND root_kind IN ('legacy','tracker','engine_scaffold')") as Array<{ id: string }>;
    for (const { id } of tasks) expect(Object.keys(wire), id).toContain(getTask(id)!.status);
  });
});
