// ════════════════════════════════════════════════════════════════════════════════════════
// HARNESS-LEARNINGS HL5 — SNAPSHOTS, NOT ANNOTATIONS (the Bob endgame, fourth attempt).
//
// EVERY CLAUSE BELOW FAILS AT THIS TASK'S BASE COMMIT `e83d81c`, and they fail for one
// reason: the recall lane serves obligations ONE HIT AT A TIME. T17 taught it to resolve a
// hit against the spine before showing it (`work/obligation-memory.ts` §2) — closed lines are
// dropped, unresolvable ones get a marker, live ones render verbatim — and T20/T28/T28b
// taught the summary annotator to mark a stored line where it sits. All four are ANNOTATION,
// and the record says annotation loses: the floor model parroted "still parked, waiting on
// Bob's address" 2/2 after T28 appended markers (W11) and 2/2 after T28b front-loaded them
// (W12), while its own OPEN WORK block was empty and its own `work_update(list)` had just
// answered "No active tasks".
//
// dsh's answer is not a better marker. It is RE-PUBLICATION: the whole current set, with an
// explicit statement that earlier versions no longer apply, and an explicit "none" sentence
// when the set empties (`deepseek-harness-findings.md` P2.2/P2.3, quoting their
// `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.` and
// `Current runtime context: none. Earlier runtime-context snapshots no longer apply.`).
//
// So the lane stops answering "is THIS line still owed?" and starts answering "what is owed,
// all of it, right now?" — one complete snapshot of the live commitment rows, with the
// superseding sentence and the empty-set statement. The per-hit rendering it replaces is
// WITHDRAWN while the snapshot renders, because two answers to one question is the parallel
// memory T17 exists to prevent, restated.
//
// WHY THE GATE IS THE SPINE AND NOT THE RETRIEVAL, measured rather than assumed: T17 already
// DROPS a closed obligation hit (`recall-lane.ts`, `verdict.kind === 'closed'` → `continue`).
// On the body this class was measured on — BehaviorBot, 136 commitment rows, every one
// terminal — a retrieval-gated snapshot would therefore never fire on the exact case it
// exists for. The gate is "does this agent's spine hold a commitment row at all", which is
// deterministic, is one indexed lookup, and makes the empty-set statement reachable.
//
// WHAT DOES NOT MOVE: zero prefix bytes. `MessageSlot.RecalledMemory = 1870` is past
// `volatileFrom` and the loop appends it (`pre-call-injections.ts`). Stored summaries are
// byte-untouched — history stays history, T20's law — and the T28 annotations stay exactly
// where they are, as the historical record they became.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    getDbPath: () => p.join(os.tmpdir(), 'dojo-hl5-snapshot-test', 'dojo.db'),
  };
});

import { runMigrations } from '../../db/migrations.js';
import {
  RECALL_LANE_ID, renderRecallLane, recallLaneWorstCaseTokens, truncateRecallLane,
  SNAPSHOT_HEAD, SNAPSHOT_TAIL, SNAPSHOT_EMPTY_BODY, UNRESOLVED_OBLIGATION_MARK,
  snapshotBoardLine,
  type RecallLaneContext, type RecallLanePayload,
} from '../recall-lane.js';
import { POST_BUDGET_LANES, laneLimit, type LaneRender } from '../lanes.js';
import { MessageSlot } from '../../prompt/registry/types.js';
import { getMessageEntries, getSystemEntries } from '../../prompt/registry/registry.js';
import '../../prompt/registry/entries.js';
import {
  liveCommitments, hasCommitmentHistory, openBoardCounts,
} from '../../work/obligation-memory.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const AGENT = 'hl5-agent';
const OTHER = 'hl5-other';
const CONV = 'hl5-conv';

let seq = 0;

function seedCommitment(p: {
  id: string; title: string; state: string; agentId?: string; daysAgo?: number;
}): void {
  const db = mockDb.current!;
  const terminal = ['done', 'failed', 'abandoned'].includes(p.state);
  const at = Date.now() - (p.daysAgo ?? 0) * 86_400_000;
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id,
                       state, intent, wakes, closes_thread, title, opened_at, updated_at,
                       closed_at, provenance)
     VALUES (?, 'commitment', ?, 'agent', ?, 'commitment', ?, ?, 'commitment', 0, 0, ?, ?, ?, ?, 'live')`,
  ).run(p.id, p.agentId ?? AGENT, p.agentId ?? AGENT, `turn:${++seq}`, p.state, p.title, at, at,
    terminal ? at : null);
}

/** UX-REPAIR ROUND 11 T44 — a NON-commitment board row: an ask, or one of the tracker's own
 *  two nouns. Same table, same agent scoping, same `closed_at` terminal predicate. */
function seedBoardRow(p: {
  id: string; kind: 'ask' | 'task' | 'project'; state: string;
  rootKind?: string; title?: string; agentId?: string;
}): void {
  const db = mockDb.current!;
  const terminal = ['done', 'failed', 'abandoned'].includes(p.state);
  const at = Date.now();
  const rootKind = p.rootKind ?? (p.kind === 'ask' ? 'ask' : 'tracker');
  db.prepare(
    `INSERT INTO work (id, kind, agent_id, requester, requester_id, root_kind, root_id,
                       state, intent, wakes, closes_thread, title, opened_at, updated_at,
                       closed_at, provenance)
     VALUES (?, ?, ?, 'owner', 'owner', ?, ?, ?, 'action', 1, 0, ?, ?, ?, ?, 'live')`,
  ).run(p.id, p.kind, p.agentId ?? AGENT, rootKind, `turn:${++seq}`, p.state,
    p.title ?? `${p.kind} row`, at, at, terminal ? at : null);
}

/** The board truth read straight from the spine BY THE TEST, so the agreement clause is an
 *  independent query rather than the renderer marking its own homework. */
function spineBoard(agentId: string): {
  asks: number; asksBlocked: number; tracker: number; trackerBlocked: number;
} {
  const db = mockDb.current!;
  const one = (sql: string): number =>
    (db.prepare(sql).get(agentId) as { n: number }).n;
  return {
    asks: one(`SELECT count(*) AS n FROM work
                WHERE agent_id = ? AND kind = 'ask' AND closed_at IS NULL`),
    asksBlocked: one(`SELECT count(*) AS n FROM work
                       WHERE agent_id = ? AND kind = 'ask' AND closed_at IS NULL
                         AND state = 'blocked'`),
    tracker: one(`SELECT count(*) AS n FROM work
                   WHERE agent_id = ? AND kind IN ('task','project') AND closed_at IS NULL
                     AND root_kind IN ('legacy','tracker','engine_scaffold')`),
    trackerBlocked: one(`SELECT count(*) AS n FROM work
                          WHERE agent_id = ? AND kind IN ('task','project')
                            AND closed_at IS NULL AND state = 'blocked'
                            AND root_kind IN ('legacy','tracker','engine_scaffold')`),
  };
}

function ctxWith(over: Partial<RecallLaneContext> = {}): RecallLaneContext {
  return {
    agentId: AGENT,
    includeVault: true,
    excludeIds: new Set<string>(),
    msgHits: [],
    vaultHits: [],
    alreadyAnsweredAskIds: new Set<string>(),
    ...over,
  };
}

// T69b RE-BLESS: the lane emits TWO messages now — HL5's snapshot FIRST, the per-ask
// retrieval SECOND — so this helper joins them instead of reading `messages[0]`. Every clause
// in this file asks what the model was HANDED by the lane, and it is handed both; reading only
// the first would silently start asserting about the snapshot alone. The join is `'\n\n'`,
// which is the separator the two halves had inside the single string until this task, so every
// existing expectation over the concatenated text is byte-unchanged.
//
// WHY THE SPLIT: the two halves have different sources (the work board vs the live ask) and
// the STATE half was second, so every ask re-billed ~1,400 chars of board state. See
// `recall-lane.ts toLaneRender`.
const textOf = (r: LaneRender<RecallLanePayload> | null): string =>
  (r?.messages ?? []).map((m) => m.content as string).join('\n\n');

/** The three live vault entries the round-3 incident measured, verbatim. */
const BOB_VAULT = [
  { id: 'v-roof', type: 'note', content: '[2026-08-01] Commitment: email the roof quote to Bob (promise-bmsbcibqqem) once he sends his address. Waiting on Bob\'s address before proceeding.' },
  { id: 'v-fence', type: 'note', content: '[2026-08-05] Commitment: email the fence estimate to Bob (promise-bmsggcuttdo) once he sends his address. Waiting on Bob\'s address before proceeding.' },
  { id: 'v-boiler', type: 'note', content: '[2026-08-06] Commitment: email the boiler invoice to Bob (promise-bmsh708xse7) once he sends his address. Waiting on Bob\'s address before proceeding.' },
];

beforeEach(() => {
  const db = new Database(':memory:');
  mockDb.current = db;
  runMigrations();
  for (const id of [AGENT, OTHER]) {
    db.prepare(
      `INSERT INTO agents (id, name, status, session_started_at)
       VALUES (?, ?, 'idle', '1970-01-01')`,
    ).run(id, id);
  }
  db.prepare(
    `INSERT INTO conversations (id, agent_id, channel, provider, counterparty_id, created_at)
     VALUES (?, ?, 'dashboard', NULL, 'owner', datetime('now'))`,
  ).run(CONV, AGENT);
  seq = 0;
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §1 — THE SET READER. One owner of "what does the spine say is owed", beside T17's §2
//      resolver and using its predicate, not a second one.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§1 the live-commitment set is read from the spine, by the module that already owns the question', () => {
  it('returns every commitment with no `closed_at`, and nothing else', () => {
    seedCommitment({ id: 'cmt:aaaaaaaaaaaa', title: 'Email the roof quote to Bob', state: 'open' });
    seedCommitment({ id: 'cmt:bbbbbbbbbbbb', title: 'Send the fence estimate', state: 'claimed' });
    seedCommitment({ id: 'cmt:cccccccccccc', title: 'Email the boiler invoice to Bob', state: 'abandoned' });
    seedCommitment({ id: 'cmt:dddddddddddd', title: 'A finished promise', state: 'failed' });
    const live = liveCommitments(AGENT);
    expect(live.map((r) => r.id).sort()).toEqual(['cmt:aaaaaaaaaaaa', 'cmt:bbbbbbbbbbbb']);
  });

  it('is AGENT-SCOPED — another agent\'s open commitment is never in this agent\'s snapshot', () => {
    seedCommitment({ id: 'cmt:eeeeeeeeeeee', title: 'Not yours', state: 'open', agentId: OTHER });
    expect(liveCommitments(AGENT)).toEqual([]);
    expect(hasCommitmentHistory(AGENT)).toBe(false);
  });

  it('the terminal predicate is the SCHEMA\'S, not a second list of state names', () => {
    // `db/migrations/135_work_spine.sql` carries
    //   CHECK ((state IN ('done','failed','abandoned')) = (closed_at IS NOT NULL))
    // so `closed_at IS NULL` IS "still owed". A copy of the three names in the reader would
    // be a second declaration of a fact the database already enforces — the rule
    // `obligation-memory.ts`'s own header states, applied to the set reader too.
    const src = read('work/obligation-memory.ts');
    const afterSnapshot = src.slice(src.indexOf('export function liveCommitments'));
    expect(afterSnapshot).toContain('closed_at IS NULL');
    expect(afterSnapshot).not.toMatch(/'done'\s*,\s*'failed'\s*,\s*'abandoned'/);
  });

  it('history is "has this agent EVER recorded a commitment", so a closed-only board still publishes', () => {
    seedCommitment({ id: 'cmt:ffffffffffff', title: 'Email the roof quote to Bob', state: 'abandoned' });
    expect(liveCommitments(AGENT)).toEqual([]);
    expect(hasCommitmentHistory(AGENT)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §2 — THE SNAPSHOT IS COMPLETE, AND IT SAYS SO. The three parts dsh's own strings carry
//      (P2.3): a complete replacement, an explicit "earlier no longer applies", and a
//      negative instruction naming the failure mode.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§2 the snapshot supersedes', () => {
  it('THE BOB SHAPE: 136 terminal rows, zero live — the lane publishes the EMPTY-SET statement', () => {
    for (let i = 0; i < 6; i++) {
      seedCommitment({
        id: `cmt:${String(i).repeat(12)}`,
        title: `Email the roof quote to Bob (promise-bmsbcibqqem) once he sends his address.`,
        state: 'abandoned', daysAgo: 9,
      });
    }
    const text = textOf(renderRecallLane(ctxWith({ vaultHits: BOB_VAULT })));
    expect(text).toContain(SNAPSHOT_HEAD);
    expect(text).toContain(SNAPSHOT_EMPTY_BODY);
    expect(text).toContain(SNAPSHOT_TAIL);
    // (i) complete replacement · (ii) earlier no longer applies · (iii) the negative
    // instruction that names the failure mode this class keeps producing.
    expect(SNAPSHOT_EMPTY_BODY).toMatch(/supersedes/i);
    expect(SNAPSHOT_EMPTY_BODY).toMatch(/no longer applies/i);
    expect(SNAPSHOT_EMPTY_BODY).toMatch(/do not report it as current/i);
  });

  it('every live row is listed, with the id the model needs and its state', () => {
    seedCommitment({ id: 'cmt:111111111111', title: 'Email the roof quote to Bob', state: 'open', daysAgo: 3 });
    seedCommitment({ id: 'cmt:222222222222', title: 'Send David the venue shortlist', state: 'blocked', daysAgo: 1 });
    seedCommitment({ id: 'cmt:333333333333', title: 'A closed one', state: 'failed', daysAgo: 4 });
    const text = textOf(renderRecallLane(ctxWith()));
    expect(text).toContain('[cmt:111111111111]');
    expect(text).toContain('[cmt:222222222222]');
    expect(text).not.toContain('[cmt:333333333333]');
    expect(text).toContain('Email the roof quote to Bob');
    expect(text).toContain('blocked');
    // The COUNT is stated, because the count is what makes "anything not listed is not owed"
    // checkable when the row cap binds.
    expect(text).toMatch(/holds 2 open commitments/);
  });

  it('NEGATIVE CONTROL: an agent that never recorded a commitment gets no snapshot at all', () => {
    const text = textOf(renderRecallLane(ctxWith({
      vaultHits: [{ id: 'v-1', type: 'preference', content: 'David prefers dark mode.' }],
    })));
    expect(text).not.toContain(SNAPSHOT_HEAD);
    expect(text).toContain('David prefers dark mode.');
  });

  it('the row cap binds and the count sentence stays TRUE — an elision is never silent', () => {
    const cap = laneLimit(RECALL_LANE_ID, 'rows', 'snapshotCommitments');
    for (let i = 0; i < cap + 3; i++) {
      seedCommitment({ id: `cmt:${String(i).padStart(12, 'a')}`, title: `Promise number ${i}`, state: 'open', daysAgo: i });
    }
    const text = textOf(renderRecallLane(ctxWith()));
    expect(text).toMatch(new RegExp(`holds ${cap + 3} open commitments`));
    expect(text).toMatch(/and 3 more open commitments? not listed/);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §3 — SET-RENDERING REPLACES PER-HIT RENDERING. HL5's own intent inventory: T17's
//      requirement "no parallel memory of obligations" is this task's goal, restated.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§3 the per-hit obligation serving is withdrawn while the snapshot serves', () => {
  it('a LIVE obligation vault line is not served BESIDE the snapshot — the snapshot is the serving', () => {
    seedCommitment({
      id: 'cmt:444444444444', state: 'open', daysAgo: 2,
      title: 'Email the roof quote to Bob (promise-bmsbcibqqem) once he sends his address.',
    });
    const text = textOf(renderRecallLane(ctxWith({ vaultHits: [BOB_VAULT[0]] })));
    expect(text).toContain('[cmt:444444444444]');
    // The vault's own sentence — the one the model parroted — is NOT re-served underneath it.
    expect(text).not.toContain('Waiting on Bob\'s address before proceeding.');
  });

  it('an UNRESOLVABLE obligation line is superseded too — the snapshot answers it better than the marker did', () => {
    seedCommitment({ id: 'cmt:555555555555', title: 'Something else entirely', state: 'open' });
    const text = textOf(renderRecallLane(ctxWith({
      vaultHits: [{ id: 'v-x', type: 'note', content: 'Commitment: I will send the deck to Priya tomorrow.' }],
    })));
    expect(text).not.toContain(UNRESOLVED_OBLIGATION_MARK);
    expect(text).not.toContain('I will send the deck to Priya tomorrow.');
    expect(text).toContain(SNAPSHOT_HEAD);
  });

  it('a NON-obligation vault hit is byte-identical to today, snapshot or no snapshot', () => {
    seedCommitment({ id: 'cmt:666666666666', title: 'anything', state: 'abandoned' });
    const text = textOf(renderRecallLane(ctxWith({
      vaultHits: [{ id: 'v-2', type: 'preference', content: 'David takes his coffee black.' }],
    })));
    expect(text).toContain('- [vault:preference] David takes his coffee black.');
  });

  it('WITHOUT a snapshot the T17 path is untouched — the marker still marks, the closed line still drops', () => {
    // No commitment rows at all for this agent, so no snapshot: T17's per-hit rendering is
    // still the whole of the obligation serving and must behave exactly as it did.
    const text = textOf(renderRecallLane(ctxWith({
      vaultHits: [{ id: 'v-y', type: 'note', content: 'Commitment: I will send the deck to Priya tomorrow.' }],
    })));
    expect(text).toContain(UNRESOLVED_OBLIGATION_MARK);
    expect(text).toContain('I will send the deck to Priya tomorrow.');
  });

  it('recalled MESSAGE rows are never withheld — history stays history, and the preamble is what supersedes it', () => {
    // The snapshot re-publishes; it does not edit or hide the record. A recalled conversation
    // row that reads as owed is exactly what the superseding sentence is FOR.
    seedCommitment({ id: 'cmt:777777777777', title: 'anything', state: 'abandoned' });
    const db = mockDb.current!;
    db.prepare(
      `INSERT INTO messages (id, agent_id, conversation_id, role, content, created_at)
       VALUES ('m-old', ?, ?, 'assistant', ?, ?)`,
    ).run(AGENT, CONV, 'Still waiting on Bob\'s address before I can send the roof quote.', Date.now() - 3_600_000);
    const text = textOf(renderRecallLane(ctxWith({ msgHits: [{ sourceId: 'm-old' }] })));
    expect(text).toContain('Still waiting on Bob');
    expect(text).toContain(SNAPSHOT_HEAD);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §4 — THE BUDGET IS STILL DERIVED FROM THE GENERATOR, AND THE TRUTH GOES LAST.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§4 the reserve and the truncation', () => {
  it('the declared reserve IS the generator\'s worst case, snapshot included', () => {
    const declared = POST_BUDGET_LANES.find((l) => l.id === RECALL_LANE_ID);
    expect(declared?.reserveTokens).toBe(recallLaneWorstCaseTokens());
  });

  it('the worst case ACCOUNTS for the snapshot — it is not the pre-HL5 number', () => {
    // The literal the lane declared before this task. If the worst case still equals it, the
    // snapshot was added to the render and NOT to the derivation, which is the drift the
    // "derived from the generator" rule exists to catch.
    expect(recallLaneWorstCaseTokens()).toBeGreaterThan(1407);
  });

  it('no input can exceed the worst case — every cap flooded at once, snapshot included', () => {
    const cap = laneLimit(RECALL_LANE_ID, 'rows', 'snapshotCommitments');
    for (let i = 0; i < cap + 5; i++) {
      seedCommitment({
        id: `cmt:${String(i).padStart(12, 'f')}`, state: 'open', daysAgo: 300,
        title: 'x'.repeat(400),
      });
    }
    const render = renderRecallLane(ctxWith({
      vaultHits: Array.from({ length: 12 }, (_, i) => ({ id: `v${i}`, type: 'note', content: 'y'.repeat(600) })),
    }));
    expect(render).not.toBeNull();
    expect(render!.tokens).toBeLessThanOrEqual(recallLaneWorstCaseTokens());
  });

  it('the snapshot is the LAST thing the truncation gives up — it is the truth the lane exists to carry', () => {
    seedCommitment({ id: 'cmt:888888888888', title: 'A live promise about the deck', state: 'open' });
    const full = renderRecallLane(ctxWith({
      vaultHits: [{ id: 'v-3', type: 'preference', content: 'z'.repeat(280) }],
      msgHits: [],
    }));
    expect(textOf(full)).toContain('[vault:preference]');
    const squeezed = renderRecallLane(ctxWith({
      vaultHits: [{ id: 'v-3', type: 'preference', content: 'z'.repeat(280) }],
    }));
    // Squeeze it below what the vault line costs and the snapshot must survive the vault line.
    const shrunk = truncateRecallLane(squeezed!, 120);
    expect(textOf(shrunk)).toContain(SNAPSHOT_HEAD);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §5 — ZERO PREFIX BYTES. The cache tenet, asserted rather than asserted-about.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§5 the snapshot is tail-side, and nothing else moved', () => {
  it('rides `msg.relevant-memory` at 1870, past the volatile boundary', () => {
    const entry = getMessageEntries().find((e) => e.id === 'msg.relevant-memory');
    expect(entry?.slot).toBe(MessageSlot.RecalledMemory);
    expect(MessageSlot.RecalledMemory).toBeGreaterThan(MessageSlot.TurnContext);
  });

  it('no SYSTEM-side registry entry carries a byte of the snapshot', () => {
    for (const e of getSystemEntries()) {
      const rendered = JSON.stringify(e.reason ?? '');
      expect(rendered).not.toContain('OPEN COMMITMENTS');
    }
  });

  it('the summary annotator is UNTOUCHED — stored summaries stay byte-identical (T20\'s law)', () => {
    // HL5 changes what the lane PUBLISHES, never what compaction WROTE. The T28 markers stay
    // in the stored rows as the historical record they became.
    const src = read('memory/summary-obligations.ts');
    expect(src).toContain('SUMMARY_OBLIGATION_MARK');
    expect(src).not.toContain('OPEN COMMITMENTS');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// §6 — UX-REPAIR ROUND 11 T44: THE SNAPSHOT STATES THE WHOLE BOARD.
//
// THE INCIDENT (round-11 S4, catalog §8.3/§8.4). The catch-up reply said "One thing's still
// on my plate". The live board at answer time held TEN non-terminal rows — six owner `ask`
// rows in state `blocked` and four tracker `task` rows (one blocked, three `on_deck`) — and
// the turn made no board-wide read at all (2× recall_recent_thread, calendar_agenda, and one
// work row fetched by id). The recorder's verdict on that claim is UNBACKED as stated: not a
// model ignoring its instruments, but a count nothing in its context could source.
//
// §1–§5 above are why: the snapshot is COMMITMENTS-only by charter, and the only other
// board surface in the model's context (`engine.open-work`, `work/obligations.ts`) is
// conversation-scoped, capped at 600 chars with a declared drop order, filtered to rows
// inside the ageing horizon, and excludes `claimed` — HL6's own migration argument, one
// noun over. No surface stated the whole board.
//
// So the snapshot's charter — COMPLETE set-rendering of owed state — is extended by ONE
// LINE of COUNTS, not lists. Counts are O(1) bytes, so completeness costs nothing and needs
// no cap, and a count cannot be read as a rival ENUMERATION of the rows `engine.open-work`
// shows: the line names itself the complete count and points at the list door. The predicate
// is §1's predicate — `closed_at IS NULL`, which the schema's own CHECK makes the definition
// of "still owed" — read by the module that already owns "what does the spine say is owed",
// so a board count can never disagree with a commitment verdict.
//
// It is a TRUTH argument, not a wording experiment: a complete count now exists where no
// complete surface did. No behavioural claim is made here.
// ════════════════════════════════════════════════════════════════════════════════════════

describe('§6 the board counts are complete, and they agree with the spine at render time', () => {
  /** The round-11 S4 board, verbatim from catalog §8.3, on an agent with commitment history. */
  const seedS4Board = (): void => {
    seedCommitment({ id: 'cmt:s4s4s4s4s4s4', title: 'A closed promise', state: 'abandoned' });
    for (let i = 0; i < 6; i++) {
      seedBoardRow({ id: `ask:blocked-${i}`, kind: 'ask', state: 'blocked' });
    }
    seedBoardRow({ id: 'trk-blocked', kind: 'task', state: 'blocked', title: 'Reorganize project notes' });
    for (let i = 0; i < 3; i++) {
      seedBoardRow({ id: `trk-ondeck-${i}`, kind: 'task', state: 'on_deck', title: `Reminder ${i}` });
    }
  };

  it('THE S4 SHAPE: the board-wide counts are stated — six asks, four tracker items', () => {
    seedS4Board();
    const text = textOf(renderRecallLane(ctxWith()));
    expect(text).toContain(SNAPSHOT_HEAD);
    expect(text).toMatch(/6 open asks/);
    expect(text).toMatch(/4 open tracker items/);
    // The whole point of the incident: six of them were BLOCKED and the reply said "one".
    expect(text).toMatch(/6 blocked/);
    expect(text).toMatch(/1 is blocked/);
  });

  it('THE AGREEMENT CLAUSE: the rendered line is the count reader\'s, and the count reader is the spine\'s', () => {
    seedS4Board();
    // A second, independent query written in the test — not the reader's own SQL — is what
    // makes this an agreement check rather than the renderer marking its own homework.
    const spine = spineBoard(AGENT);
    expect(openBoardCounts(AGENT)).toEqual(spine);
    expect(textOf(renderRecallLane(ctxWith()))).toContain(snapshotBoardLine(spine));
  });

  it('the agreement holds as the board MOVES — a close, a new ask, a block lifted', () => {
    seedS4Board();
    const db = mockDb.current!;
    const at = Date.now();
    db.prepare(`UPDATE work SET state = 'abandoned', closed_at = ? WHERE id = 'ask:blocked-0'`).run(at);
    db.prepare(`UPDATE work SET state = 'open' WHERE id = 'trk-blocked'`).run();
    seedBoardRow({ id: 'ask:fresh', kind: 'ask', state: 'open' });
    const spine = spineBoard(AGENT);
    expect(spine).toEqual({ asks: 6, asksBlocked: 5, tracker: 4, trackerBlocked: 0 });
    expect(openBoardCounts(AGENT)).toEqual(spine);
    expect(textOf(renderRecallLane(ctxWith()))).toContain(snapshotBoardLine(spine));
  });

  it('the terminal predicate is the SCHEMA\'S — `closed_at IS NULL`, not a state allowlist', () => {
    seedCommitment({ id: 'cmt:predicate01', title: 'history', state: 'abandoned' });
    for (const state of ['open', 'claimed', 'paused', 'blocked', 'on_deck']) {
      seedBoardRow({ id: `ask:${state}`, kind: 'ask', state });
    }
    for (const state of ['done', 'failed', 'abandoned']) {
      // `done` needs a delivery to point at; the two other terminal states do not.
      if (state === 'done') continue;
      seedBoardRow({ id: `ask:${state}`, kind: 'ask', state });
    }
    // Every non-terminal state counts, including `claimed` — the snapshot's completeness
    // claim is the reason `openObligations`' narrower `OWED_STATES` set is NOT reused here.
    expect(openBoardCounts(AGENT).asks).toBe(5);
    const src = read('work/obligation-memory.ts');
    const after = src.slice(src.indexOf('export function openBoardCounts'));
    expect(after).toContain('closed_at IS NULL');
    expect(after).not.toMatch(/'done'\s*,\s*'failed'\s*,\s*'abandoned'/);
  });

  it('is AGENT-SCOPED — another agent\'s open ask is never in this agent\'s counts', () => {
    seedCommitment({ id: 'cmt:scoped00000', title: 'history', state: 'abandoned' });
    seedBoardRow({ id: 'ask:theirs', kind: 'ask', state: 'blocked', agentId: OTHER });
    seedBoardRow({ id: 'trk-theirs', kind: 'task', state: 'blocked', agentId: OTHER });
    expect(openBoardCounts(AGENT)).toEqual({ asks: 0, asksBlocked: 0, tracker: 0, trackerBlocked: 0 });
  });

  it('JOIN PIECES ARE NOT BOARD ROWS — the count agrees with the door it names', () => {
    // `store.ts:openDelegationJoin` opens countdown children as `kind='task'` with
    // `root_kind='a2a_thread'`. `tracker-view.ts` calls them pieces of an ask, not board rows,
    // and `work_update(action="list")` does not show them. A count that included them would
    // send the model to a door that disagrees with it.
    seedCommitment({ id: 'cmt:pieces00000', title: 'history', state: 'abandoned' });
    seedBoardRow({ id: 'piece:1', kind: 'task', state: 'open', rootKind: 'a2a_thread' });
    seedBoardRow({ id: 'board:1', kind: 'task', state: 'open', rootKind: 'tracker' });
    seedBoardRow({ id: 'board:2', kind: 'project', state: 'open', rootKind: 'tracker' });
    seedBoardRow({ id: 'board:3', kind: 'task', state: 'open', rootKind: 'legacy' });
    seedBoardRow({ id: 'board:4', kind: 'task', state: 'open', rootKind: 'engine_scaffold' });
    expect(openBoardCounts(AGENT).tracker).toBe(4);
  });

  it('THE EMPTY BOARD IS SAID OUT LOUD — zero is published, not omitted (dsh P2.3)', () => {
    seedCommitment({ id: 'cmt:emptyboard0', title: 'A closed promise', state: 'abandoned' });
    const text = textOf(renderRecallLane(ctxWith()));
    expect(text).toContain(SNAPSHOT_EMPTY_BODY);
    expect(text).toContain(snapshotBoardLine({ asks: 0, asksBlocked: 0, tracker: 0, trackerBlocked: 0 }));
    expect(text).toMatch(/0 open asks/);
  });

  it('the line rides the OPEN COMMITMENTS block, immediately after the commitments statement', () => {
    seedCommitment({ id: 'cmt:position000', title: 'A live promise', state: 'open' });
    seedBoardRow({ id: 'ask:one', kind: 'ask', state: 'blocked' });
    const text = textOf(renderRecallLane(ctxWith()));
    const line = snapshotBoardLine(spineBoard(AGENT));
    const head = text.indexOf(SNAPSHOT_HEAD);
    const body = text.indexOf('and that is the whole of what is owed');
    const board = text.indexOf(line);
    const rows = text.indexOf('[cmt:position000]');
    const tail = text.indexOf(SNAPSHOT_TAIL);
    expect(head).toBeGreaterThanOrEqual(0);
    expect(board).toBeGreaterThan(body);
    expect(board).toBeLessThan(rows);
    expect(board).toBeLessThan(tail);
  });

  it('THE COLLISION ARGUMENT, enforceable: the line calls itself complete and names the LIST door', () => {
    seedCommitment({ id: 'cmt:collision00', title: 'history', state: 'abandoned' });
    seedBoardRow({ id: 'ask:c1', kind: 'ask', state: 'blocked' });
    const text = textOf(renderRecallLane(ctxWith()));
    // Counts vs partial rows: `engine.open-work` enumerates SOME rows, this states ALL the
    // numbers. The line has to say which it is, or the two surfaces read as rivals.
    expect(text).toMatch(/complete/i);
    expect(text).toContain('work_update(action="list")');
    // And it must not over-claim the door it names: that tool lists the tracker's two nouns
    // and has never listed asks or commitments (HL6 §2's measured finding).
    expect(text).toMatch(/not (?:the )?asks/i);
  });

  it('the counts survive truncation with the preamble — they are the load, the rows are detail', () => {
    seedCommitment({ id: 'cmt:squeeze0000', title: 'A live promise about the deck', state: 'open' });
    seedBoardRow({ id: 'ask:squeeze', kind: 'ask', state: 'blocked' });
    const render = renderRecallLane(ctxWith({
      vaultHits: [{ id: 'v-9', type: 'preference', content: 'z'.repeat(280) }],
    }));
    const shrunk = truncateRecallLane(render!, 120);
    expect(textOf(shrunk)).toContain(snapshotBoardLine(spineBoard(AGENT)));
  });

  it('the reserve still IS the generator\'s worst case, with the board line inside it', () => {
    const declared = POST_BUDGET_LANES.find((l) => l.id === RECALL_LANE_ID);
    expect(declared?.reserveTokens).toBe(recallLaneWorstCaseTokens());
    // The literal the lane declared before T44. Equality would mean the line was added to the
    // render and not to the derivation — the drift the "derived from the generator" rule exists
    // to catch, caught once already at HL5 (§4 above).
    expect(recallLaneWorstCaseTokens()).toBeGreaterThan(1807);
  });

  // ── T44 FOLLOW-UP (orchestrator ruling on W31's hand-up 2, 2026-08-15) ─────────────────
  //
  // W31 shipped the board counts inside the HL5 block and handed up the hole they left: the
  // block renders only when `hasCommitmentHistory` is true, so an agent with open ASKS and no
  // commitment past published no counts at all — the exact S4 gap this task exists to close,
  // re-created one agent over. That gate was W29's RENDER-COST guard, and the cost argument
  // does not reach the counts: they are O(1) bytes, which is the same argument `lanes.ts`
  // makes for why completeness is affordable here at all. So the gate widens to "this agent
  // has a commitment past OR something open on its board", and the commitments half of the
  // block simply says the true thing for such an agent — it holds NO open commitments.
  //
  // WHAT THE GATE STILL SPARES, and it is the whole reason it is not simply deleted: an agent
  // with no history and nothing open publishes nothing. There is no earlier mention for a
  // snapshot to supersede and no board to count, so the block would be noise — the same
  // judgement `hasCommitmentHistory` was written to make, now made on the whole board.
  describe('the gate is the whole board, not the commitment past alone', () => {
    it('THE HOLE: open asks with NO commitment history now publish — at HEAD they published nothing', () => {
      seedBoardRow({ id: 'ask:no-history-1', kind: 'ask', state: 'blocked' });
      seedBoardRow({ id: 'ask:no-history-2', kind: 'ask', state: 'open' });
      expect(hasCommitmentHistory(AGENT)).toBe(false);
      const text = textOf(renderRecallLane(ctxWith()));
      expect(text).toContain(SNAPSHOT_HEAD);
      // The commitments half states the true thing rather than being suppressed.
      expect(text).toContain(SNAPSHOT_EMPTY_BODY);
      expect(text).toContain(snapshotBoardLine(spineBoard(AGENT)));
      expect(text).toMatch(/2 open asks \(1 blocked\)/);
    });

    it('a tracker row alone opens the gate too — the board is the board', () => {
      seedBoardRow({ id: 'trk-no-history', kind: 'task', state: 'blocked' });
      expect(hasCommitmentHistory(AGENT)).toBe(false);
      const text = textOf(renderRecallLane(ctxWith()));
      expect(text).toContain(SNAPSHOT_HEAD);
      expect(text).toMatch(/1 open tracker item/);
    });

    it('NEGATIVE CONTROL: no history and nothing open still renders NOTHING — truly empty agents are spared', () => {
      const text = textOf(renderRecallLane(ctxWith({
        vaultHits: [{ id: 'v-none', type: 'preference', content: 'David prefers dark mode.' }],
      })));
      expect(text).not.toContain(SNAPSHOT_HEAD);
      expect(text).toContain('David prefers dark mode.');
    });

    it('NEGATIVE CONTROL: CLOSED board rows do not open the gate — a terminal row is not an open one', () => {
      seedBoardRow({ id: 'ask:closed', kind: 'ask', state: 'abandoned' });
      seedBoardRow({ id: 'trk-closed', kind: 'task', state: 'failed' });
      expect(openBoardCounts(AGENT)).toEqual({ asks: 0, asksBlocked: 0, tracker: 0, trackerBlocked: 0 });
      expect(textOf(renderRecallLane(ctxWith()))).not.toContain(SNAPSHOT_HEAD);
    });

    it('NEGATIVE CONTROL: a join PIECE does not open the gate — it is not a board row', () => {
      seedBoardRow({ id: 'piece:gate', kind: 'task', state: 'open', rootKind: 'a2a_thread' });
      expect(textOf(renderRecallLane(ctxWith()))).not.toContain(SNAPSHOT_HEAD);
    });

    it('the widened gate is AGENT-SCOPED — another agent\'s open ask opens nothing here', () => {
      seedBoardRow({ id: 'ask:theirs-gate', kind: 'ask', state: 'blocked', agentId: OTHER });
      expect(textOf(renderRecallLane(ctxWith()))).not.toContain(SNAPSHOT_HEAD);
    });

    it('the T17 per-hit path still owns the no-snapshot case, unchanged', () => {
      // The withdrawal clause keys on `snapshot !== null`, so widening the gate moves rows out
      // of T17's hands for agents that now publish. For an agent that still does not publish,
      // every branch must behave exactly as it did before this task and before HL5.
      const text = textOf(renderRecallLane(ctxWith({
        vaultHits: [{ id: 'v-t17', type: 'note', content: 'Commitment: I will send the deck to Priya tomorrow.' }],
      })));
      expect(text).toContain(UNRESOLVED_OBLIGATION_MARK);
      expect(text).toContain('I will send the deck to Priya tomorrow.');
      expect(text).not.toContain(SNAPSHOT_HEAD);
    });

    it('the reserve argument is UNCHANGED — the widened gate renders no new shape', () => {
      // The gate decides WHETHER the block renders, never how large it can be. The worst case
      // is the same worst case, so `lanes.ts`'s derivation still holds and no pin moves for it.
      const declared = POST_BUDGET_LANES.find((l) => l.id === RECALL_LANE_ID);
      expect(declared?.reserveTokens).toBe(recallLaneWorstCaseTokens());
      seedBoardRow({ id: 'ask:reserve', kind: 'ask', state: 'blocked' });
      const render = renderRecallLane(ctxWith({
        vaultHits: Array.from({ length: 12 }, (_, i) => ({ id: `vg${i}`, type: 'note', content: 'y'.repeat(600) })),
      }));
      expect(render!.tokens).toBeLessThanOrEqual(recallLaneWorstCaseTokens());
    });
  });

  it('ZERO PREFIX BYTES: no system-side registry entry carries a byte of the board line', () => {
    const line = snapshotBoardLine({ asks: 1, asksBlocked: 1, tracker: 1, trackerBlocked: 1 });
    const stem = line.slice(0, line.indexOf('1 open ask'));
    expect(stem.length).toBeGreaterThan(10);
    for (const e of getSystemEntries()) {
      expect(JSON.stringify(e.reason ?? '')).not.toContain(stem);
    }
    expect(read('prompt/registry/entries.ts')).not.toContain(stem);
    expect(read('prompt/assembler.ts')).not.toContain(stem);
  });
});
