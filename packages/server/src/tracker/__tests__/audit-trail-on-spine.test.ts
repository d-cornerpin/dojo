// PHASE-2 T10G (RULING 10) — the tracker's audit trail, read off the spine.
//
// `task_log` was the tracker's audit trail: the one history the owner reads (the Activity
// panel at `dashboard/src/pages/Tracker.tsx:293`, the PM's ledger line, the agent context
// block). It is the last of the four side tables migration `138` re-pointed, and it dies
// here — but NOT as a copy. RULING 10 ruled the shape, and every clause below exists because
// a measurement said the naive copy would have been wrong:
//
//   * 40 of its 51 row-MOVING `transition` entries have a spine `transition` event on the
//     same work within 3 s (stable across a 1 s → 60 s window). Copying them would record
//     one fact twice — the thing this phase exists to stop. They get a TOMBSTONE MAPPING.
//   * 59 of its 110 `transition` entries do not move a row at all. Every one is
//     `from_entity='pm'` and every one is a PM validation (`valid=true`). They are
//     ADJUDICATIONS wearing a transition label — and they are ALREADY in `adjudications`:
//     the two work sets are IDENTICAL (51 works each, zero on either side the other lacks)
//     and 51 of the 59 sit within 3 s of their adjudication row. The product wrote them
//     live. So RULING 10's "record them as what they ARE" is already discharged; inserting
//     would be the double-recording the same ruling forbids.
//   * 11 moving entries have NO spine twin at any window and 8 of their works have no spine
//     `transition` event at all. Those are history nothing else holds (#15: a removal may
//     never rest on an absence) and they are CARRIED.
//
// WHY THE AUDIT TRAIL IS ONE `work_events` KIND AND NOT TWELVE. The trail's entry kinds
// overlap the spine's own event kinds by NAME (`transition`, `poke`, `user_verdict_*`) and
// several of those names are read by LIVE PREDICATES (`lastEntryInto` inside
// `validatedExpr`, `awaitingUserVerdictExpr`, the poke ladder). Writing the trail under
// those names would have injected audit rows into predicates that decide whether the PM's
// key is turned — a behaviour change smuggled in as a storage change, which is exactly the
// call T8T RESUMED-2 refused for a denial's adjudication. So the trail is `kind='audit'`
// with its own `entry_kind` in the payload: one new kind, no collision, and the mechanism
// events stay the mechanism's.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-audit-trail-test', 'dojo.db'),
  };
});

vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import {
  writeTaskLog, listTaskLog, getRecentObservations, getRecentTransitions, formatEntryLine,
} from '../task-log.js';
import { transition } from '../../work/store.js';
import { upholdClaim } from '../../work/tracker-store.js';

const AGENT = 'kevin';
const T = 1_700_000_000_000;
const SRC = path.join(__dirname, '..', '..');

function seedWork(id: string, over: Record<string, unknown> = {}): void {
  const row: Record<string, unknown> = {
    id, kind: 'task', parent_id: null, agent_id: AGENT, assignee_agent: null,
    requester: 'owner', requester_id: 'owner', conversation_id: null,
    root_kind: 'tracker', root_id: '', state: 'open', claimed_by_turn: null,
    result_delivery_id: null, intent: 'do-it', wakes: 1, closes_thread: 0,
    hop_count: 0, superseded_by: null, title: 'a thing', goal: null, priority: 'normal',
    notes: null, remaining_children: null, compile_pending: 0, ttl_at: null,
    reply_conversation_id: null, attempts: 0, next_attempt_at: null, schedule_json: null,
    tz: null, anchor_local: null, next_run_at: null, sequence: null,
    opened_at: T, closed_at: null, updated_at: T, provenance: 'live', ...over,
  };
  const cols = Object.keys(row);
  mockDb.current!.prepare(
    `INSERT INTO work (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`,
  ).run(row);
}

beforeEach(() => {
  mockDb.current?.close();
  mockDb.current = new Database(':memory:');
  mockDb.current.pragma('foreign_keys = ON');
  runMigrations();
  mockDb.current.prepare(
    `INSERT INTO agents (id, name, status, config, created_by) VALUES (?, ?, 'idle', '{}', 'system')`,
  ).run(AGENT, 'Kevin');
});

const events = (kind?: string): Array<{ kind: string; payload: string | null; actor: string; created_at: number }> =>
  mockDb.current!.prepare(
    `SELECT kind, payload, actor, created_at FROM work_events${kind ? ' WHERE kind = ?' : ''} ORDER BY id`,
  ).all(...(kind ? [kind] : [])) as Array<{ kind: string; payload: string | null; actor: string; created_at: number }>;

// ════════════════════════════════════════════════════════════════════════════════
// 1 — THE TRAIL SURVIVES THE TABLE: what was written is what is read back
// ════════════════════════════════════════════════════════════════════════════════

describe('the audit trail round-trips through the spine', () => {
  it('an observation is written and read back with every field intact', () => {
    seedWork('w1');
    const id = writeTaskLog({
      taskId: 'w1', fromEntity: 'agent:kevin', entryKind: 'observation',
      reason: 'why it matters', actionTaken: 'notes attached to status=blocked',
      note: 'Both fanout agents are terminated — no codewords on disk.',
    });
    expect(id).not.toBeNull();

    const [e] = listTaskLog('w1');
    expect(e).toBeDefined();
    expect(e.taskId).toBe('w1');
    expect(e.fromEntity).toBe('agent:kevin');
    expect(e.entryKind).toBe('observation');
    expect(e.reason).toBe('why it matters');
    expect(e.actionTaken).toBe('notes attached to status=blocked');
    expect(e.note).toBe('Both fanout agents are terminated — no codewords on disk.');
  });

  it('the entry lands as ONE work_events row of kind=audit, not as twelve new kinds', () => {
    seedWork('w1');
    writeTaskLog({ taskId: 'w1', fromEntity: 'pm', entryKind: 'smell_flag', reason: 'poke-dodge' });
    const rows = events();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('audit');
    expect(JSON.parse(rows[0].payload!).entry_kind).toBe('smell_flag');
    expect(rows[0].actor).toBe('pm');
  });

  it('a kind a LIVE PREDICATE reads is never minted by the audit trail', () => {
    // The hazard this test exists for: `user_verdict_request` shares a name with the event
    // `awaitingUserVerdictExpr` reads, and `poke` with the ladder's. An audit write must not
    // be able to answer a predicate.
    seedWork('w1');
    writeTaskLog({ taskId: 'w1', fromEntity: 'engine', entryKind: 'user_verdict_request' });
    writeTaskLog({ taskId: 'w1', fromEntity: 'engine', entryKind: 'poke' });
    const kinds = events().map((r) => r.kind);
    expect(kinds).toEqual(['audit', 'audit']);
    expect(kinds).not.toContain('user_verdict_requested');
    expect(kinds).not.toContain('poke');
  });

  it('the kind filter still filters', () => {
    seedWork('w1');
    writeTaskLog({ taskId: 'w1', fromEntity: 'pm', entryKind: 'observation', note: 'obs' });
    writeTaskLog({ taskId: 'w1', fromEntity: 'pm', entryKind: 'directive', note: 'do this' });
    expect(listTaskLog('w1', { kinds: ['directive'] }).map((e) => e.note)).toEqual(['do this']);
    expect(listTaskLog('w1', { kinds: ['observation'] }).map((e) => e.note)).toEqual(['obs']);
  });

  it('the limit is honoured and the order is newest-first', () => {
    seedWork('w1');
    for (let i = 0; i < 5; i++) {
      writeTaskLog({ taskId: 'w1', fromEntity: 'pm', entryKind: 'observation', note: `n${i}` });
    }
    const got = listTaskLog('w1', { limit: 3 });
    expect(got).toHaveLength(3);
    expect(got.map((e) => e.note)).toEqual(['n4', 'n3', 'n2']);
  });

  it('entries for OTHER work are never returned', () => {
    seedWork('w1'); seedWork('w2');
    writeTaskLog({ taskId: 'w1', fromEntity: 'pm', entryKind: 'observation', note: 'mine' });
    writeTaskLog({ taskId: 'w2', fromEntity: 'pm', entryKind: 'observation', note: 'theirs' });
    expect(listTaskLog('w1').map((e) => e.note)).toEqual(['mine']);
  });

  it('a write against a work id that does not exist does not throw (the trail is best-effort)', () => {
    expect(() => writeTaskLog({ taskId: 'nope', fromEntity: 'pm', entryKind: 'observation' })).not.toThrow();
    expect(writeTaskLog({ taskId: 'nope', fromEntity: 'pm', entryKind: 'observation' })).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 2 — RULING 10: THE TRANSITION IS NOT RECORDED TWICE
// ════════════════════════════════════════════════════════════════════════════════

describe('a state change is recorded ONCE, by the spine', () => {
  it('writeTaskLog(transition) mints NO audit row — the spine already wrote the event', () => {
    seedWork('w1');
    const before = events().length;
    const id = writeTaskLog({
      taskId: 'w1', fromEntity: 'agent:kevin', entryKind: 'transition',
      fromStatus: 'in_progress', toStatus: 'blocked', reason: 'waiting on the owner',
    });
    expect(id).toBeNull();
    expect(events().length).toBe(before);
    expect(events('audit')).toHaveLength(0);
  });

  it('the history still SHOWS the transition — sourced from the spine event', () => {
    seedWork('w1', { state: 'open' });
    const r = transition('w1', { to: 'claimed', by: 'agent', actorId: AGENT, reason: 'picked it up' });
    expect(r.kind).toBe('applied');

    const hist = listTaskLog('w1');
    const t = hist.find((e) => e.entryKind === 'transition');
    expect(t, 'the spine transition must appear in the trail').toBeDefined();
    expect(t!.reason).toBe('picked it up');
  });

  it('the transition renders in TRACKER vocabulary, not spine vocabulary (RULING 10)', () => {
    // The one owner-visible decision in this absorption. The spine event says
    // `open -> claimed`; the history the owner has always read says `active -> in_progress`.
    // T2's own CASE mapping (`STATE_TO_STATUS_SQL`) is the translator, so this is a re-point
    // and not an invention.
    seedWork('w1', { state: 'open' });
    transition('w1', { to: 'claimed', by: 'agent', actorId: AGENT, reason: 'picked it up' });
    const t = listTaskLog('w1').find((e) => e.entryKind === 'transition')!;
    expect(t.fromStatus).toBe('active');
    expect(t.toStatus).toBe('in_progress');
    expect(formatEntryLine(t)).toContain('active → in_progress');
    expect(formatEntryLine(t)).not.toContain('claimed');
  });

  it('a PM blessing appears once, from the verdict the product already writes', () => {
    // ⚠ THE FIXTURE LIED TWICE BEFORE IT BUILT, and both are the class T10F wrote down.
    // First it seeded `state='done'` with `closed_at` NULL — the paired-nullability CHECK
    // refused it. Then `done` was refused again for carrying no `result_delivery_id`, which is
    // the spine's central promise expressed as a CHECK ("work is done because something was
    // delivered"). Both surfaced as crashes rather than silent passes only because the seed
    // runs before the clause; a fixture must be able to BUILD before its assertion means
    // anything. So the delivery is real here, exactly as the constraint demands.
    mockDb.current!.prepare(
      `INSERT INTO deliveries (id, agent_id, tool, channel, outcome)
       VALUES ('d1', ?, 'send_message', 'chat', 'delivered')`,
    ).run(AGENT);
    seedWork('w1', { state: 'done', closed_at: T, result_delivery_id: 'd1' });
    upholdClaim('w1', 'done', 'pm', 'kelly', 'PM blessed the complete');

    // ONE line, and it names itself a verdict rather than a transition with equal endpoints —
    // RULING 10's "record them as what they ARE", applied to the live writer as well as to
    // the migrated rows.
    const hist = listTaskLog('w1');
    const blessings = hist.filter((e) => e.note === 'PM blessed the complete');
    expect(blessings.length, 'the blessing must not appear twice').toBe(1);
    expect(blessings[0].entryKind).toBe('claim_upheld');
    expect(formatEntryLine(blessings[0])).toContain('PM blessed the complete');
    // It reaches the PM's own ledger set, which is where it used to arrive.
    expect(getRecentTransitions('w1').some((e) => e.entryKind === 'claim_upheld')).toBe(true);
    // And the adjudication itself is untouched — the verdict record is not the trail.
    const adj = mockDb.current!.prepare(
      "SELECT count(*) AS c FROM adjudications WHERE work_id = 'w1' AND verdict = 'upheld'",
    ).get() as { c: number };
    expect(adj.c).toBe(1);
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 3 — THE RENDERED LINE AND THE READER SETS ARE UNCHANGED
// ════════════════════════════════════════════════════════════════════════════════

describe('what the owner reads is unchanged', () => {
  it('the instant renders in the same text shape the panel has always shown', () => {
    seedWork('w1');
    writeTaskLog({ taskId: 'w1', fromEntity: 'pm', entryKind: 'observation', note: 'x' });
    const [e] = listTaskLog('w1');
    // `task_log.created_at` was `datetime('now')` TEXT printed verbatim; `work_events`
    // stores epoch ms. The projection converts, so the panel's line does not change shape.
    expect(e.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('formatEntryLine keeps its parts and order', () => {
    seedWork('w1');
    writeTaskLog({
      taskId: 'w1', fromEntity: 'agent:kevin', entryKind: 'observation',
      actionTaken: 'notes attached', reason: 'because', note: 'the prose',
    });
    const line = formatEntryLine(listTaskLog('w1')[0]);
    expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[agent:kevin\] \[observation\]/);
    expect(line).toContain('notes attached');
    expect(line).toContain('reason: because');
    expect(line).toContain('the prose');
  });

  it('getRecentObservations returns the prose kinds and NOT transitions', () => {
    seedWork('w1', { state: 'open' });
    writeTaskLog({ taskId: 'w1', fromEntity: 'pm', entryKind: 'observation', note: 'obs' });
    writeTaskLog({ taskId: 'w1', fromEntity: 'pm', entryKind: 'directive', note: 'dir' });
    transition('w1', { to: 'claimed', by: 'agent', actorId: AGENT, reason: 'moved' });
    const kinds = getRecentObservations('w1').map((e) => e.entryKind);
    expect(kinds).toEqual(expect.arrayContaining(['observation', 'directive']));
    expect(kinds).not.toContain('transition');
  });

  it('getRecentTransitions returns the moving kinds and NOT plain observations', () => {
    seedWork('w1', { state: 'open' });
    writeTaskLog({ taskId: 'w1', fromEntity: 'pm', entryKind: 'observation', note: 'obs' });
    writeTaskLog({ taskId: 'w1', fromEntity: 'engine', entryKind: 'auto_sweep', reason: 'swept' });
    transition('w1', { to: 'claimed', by: 'agent', actorId: AGENT, reason: 'moved' });
    const kinds = getRecentTransitions('w1').map((e) => e.entryKind);
    expect(kinds).toContain('transition');
    expect(kinds).toContain('auto_sweep');
    expect(kinds).not.toContain('observation');
  });
});

// ════════════════════════════════════════════════════════════════════════════════
// 4 — THE TABLE IS GONE, AND THE PROOF IS SCHEMA-SHAPED
// ════════════════════════════════════════════════════════════════════════════════
//
// T10F's finding, applied on the way in rather than discovered again: a SOURCE SCAN cannot
// notice that its subject left the schema. Two clauses PINNED §12 predicted would break when
// `deliverable_shown` was dropped stayed GREEN, because both scanned source. So the load-
// bearing clause here reads the MIGRATION CHAIN, and the source scan sits beside it to catch
// a writer landing in the same commit as a re-add.

describe('task_log is gone from the schema, not merely unreferenced', () => {
  const migrationsDir = path.join(SRC, 'db', 'migrations');
  const chain = (): string =>
    fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
      .map((f) => fs.readFileSync(path.join(migrationsDir, f), 'utf8')).join('\n');

  it('the live schema built from the chain carries no task_log table', () => {
    const hit = mockDb.current!.prepare(
      "SELECT name FROM sqlite_master WHERE name = 'task_log'",
    ).get();
    expect(hit, 'runMigrations() must not leave a task_log table behind').toBeUndefined();
  });

  it('the chain DROPs it, and nothing after the LAST drop brings it back', () => {
    // ⚠ THIS CLAUSE'S FIRST DRAFT PASSED BEFORE THE WORK WAS DONE, and the reason is the
    // finding to keep. Migration `138` REBUILDS this table to re-point its FK, and a SQLite
    // table rebuild is `CREATE task_log_new` → `DROP TABLE task_log` → `ALTER TABLE
    // task_log_new RENAME TO task_log`. So (a) there was already a `DROP TABLE task_log` in
    // the chain, and (b) the thing that brought it back was a RENAME, which a scan looking
    // only for `CREATE TABLE` cannot see. The assertion was fixed, not the fault: it now
    // takes the LAST drop and refuses BOTH resurrection verbs after it.
    const text = chain();
    const dropRe = /DROP\s+TABLE\s+(IF\s+EXISTS\s+)?["'`]?task_log["'`]?\s*;/gi;
    const drops = [...text.matchAll(dropRe)];
    expect(drops.length, 'the chain must contain a DROP TABLE task_log').toBeGreaterThan(0);
    // The tail INCLUDES the drop's own file remainder — T10F's second planted fault escaped a
    // scan that started at the next file, so a re-add on the next LINE passed.
    const tail = text.slice(drops[drops.length - 1].index);
    expect(tail).not.toMatch(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["'`]?task_log\b/i);
    expect(tail).not.toMatch(/RENAME\s+TO\s+["'`]?task_log\b/i);
  });

  it('no production source carries a statement against task_log', () => {
    const walk = (dir: string, acc: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name === '__tests__' || e.name === 'migrations') continue;
          walk(fp, acc);
        } else if (e.name.endsWith('.ts')) acc.push(fp);
      }
      return acc;
    };
    const stripComments = (s: string): string => s
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
    const RE = /(?:FROM|INTO|UPDATE|JOIN|TABLE)\s+["'`]?task_log\b|DELETE\s+FROM\s+["'`]?task_log\b/i;
    const offenders = walk(SRC)
      .filter((f) => RE.test(stripComments(fs.readFileSync(f, 'utf8'))))
      .map((f) => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
