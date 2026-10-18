// ════════════════════════════════════════════════════════════════════════════════════════
// t206 (v3.4 D3, owner decision 11: lower DAILY cost) — THE PM'S TAIL GROWS AND FOLDS.
//
// Measured on the dev box (`scripts/cost-measure.mjs --agent <the PM>`, 7 days, 220 receipted
// calls): the PM's tail lane is 65% of its tokens, 96% of its missed tokens and 89% of its
// input cost. The tail was "the newest 40 rows" (`lane.pm-tail`'s row cap): every new row
// pushed the oldest one off the front, so the first message of the conversation moved on
// every call and the provider re-read the whole tail. The prefix broke at the tail's head on
// 49% of turn starts and 70% of the calls inside a turn; a call that broke there missed about
// 33.7K tokens, one that did not about 3.4K.
//
// THE RULE THIS FILE HOLDS (the cache-stability test the lane brief asks for): two consecutive
// PM assemblies with no fold between them share a byte-identical prefix up to the new rows.
// The tail's front moves only at a fold (a summary written over the rows leaving the view),
// once, and then holds still again — the main agent's grow-then-fold tail (`tail-horizon.ts`).
//
// Fictional rows only. The prefix arithmetic is `prefix-instrument.ts`'s (t94), unchanged.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));

import { assembleContext, measureView } from '../assembler.js';
import { createLeafSummary } from '../dag.js';
import { runMigrations } from '../../db/migrations.js';
import { diffTurns, type TurnSnapshot } from './prefix-instrument.js';
import { pruneOldPMMessages } from '../../tracker/pm-agent.js';

const PM = 'pm';                 // config/platform.ts: `pm_agent_id` defaults to 'pm'
const MODEL = 't206-pm-model';

let seq = 0;
let turn = 0;
const db = (): Database.Database => mockDb.current!;

function seedModel(): void {
  db().prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 't206pm', 'T206 PM', 128000, 4096, '["tools"]')`,
  ).run(MODEL);
  db().prepare(
    "INSERT INTO agents (id, name, status, model_id, config) VALUES (?, 'PM', 'idle', ?, '{}')",
  ).run(PM, MODEL);
}

function row(role: string, content: string, lane = 'owner', tier = 'user-visible'): string {
  seq += 1;
  const id = `t206-${seq}`;
  const kind = role === 'assistant' ? (content.startsWith('[{') ? 'tool-turn' : 'agent-text')
    : role === 'tool' ? 'tool-turn' : role === 'system' ? 'engine-note' : 'user-text';
  db().prepare(
    `INSERT INTO messages (id, agent_id, role, lane, sender_id, content, display_kind, display_tier,
                           turn_number, provenance, authorized, created_at)
     VALUES (?, ?, ?, ?, 'owner', ?, ?, ?, ?, 'live', 1, ?)`,
  ).run(id, PM, role, lane, content, kind, tier, turn, 1785000000000 + seq * 1000);
  return id;
}

/** One PM review cycle, the shape the dev box records: a situation report on the events lane,
 *  the PM's reply, and the turn-closed note that renders to nothing. */
function reviewTurn(): void {
  turn += 1;
  row('user', `Tracker review ${turn} -- 3 active tasks: the report task is on deck, the inbox task is in progress, the filing task is waiting on validation.`, 'events', 'agent-only');
  row('assistant', `Reviewed cycle ${turn}; nothing needs a ruling.`);
  row('system', '[Agent ended turn without replying — conversation closed]');
}

/** A tool call inside the SAME turn: what the loop persists between two calls of one turn. */
function toolRoundInSameTurn(n: number): void {
  const callId = `call_t206_${turn}_${n}`;
  row('assistant', JSON.stringify([{ type: 'tool_use', id: callId, name: 'work_list', input: { scope: 'active' } }]));
  row('tool', JSON.stringify([{ type: 'tool_result', tool_use_id: callId, content: `3 active tasks (round ${n}).` }]));
}

async function snap(note: string): Promise<TurnSnapshot> {
  const ctx = await assembleContext(PM, MODEL);
  return { turn, note, messages: JSON.parse(JSON.stringify(ctx.messages)), entryIds: ctx.messageEntryIds };
}

const allText = (s: TurnSnapshot): string => JSON.stringify(s.messages);

beforeEach(() => {
  seq = 0;
  turn = 0;
  mockDb.current = new Database(':memory:');
  runMigrations();
  seedModel();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('t206 §1 — the PM tail grows between folds instead of sliding', () => {
  it('1a — a new review cycle APPENDS: the previous assembly is a byte prefix of the next', async () => {
    row('user', 'Why is the filing task still waiting?');
    row('assistant', 'It is waiting on validation; I will rule on it at the next review.');
    for (let i = 0; i < 30; i += 1) reviewTurn();   // 94 rows: well past the old 40-row window

    const before = await snap('30 cycles');
    reviewTurn();
    const after = await snap('one more cycle');

    const d = diffTurns(before, after);
    expect(d.droppedFromFront, 'the oldest rows fell off the front: the tail is still a sliding window').toBe(0);
    expect(d.appendOnly, `the prefix moved at message ${d.firstMovedIndex} (${d.firstMovedLane})`).toBe(true);
    // Nothing the PM was shown is lost: the owner's question is still in view.
    expect(allText(after)).toContain('Why is the filing task still waiting?');
  });

  it('1b — a later call INSIDE a turn appends too (the call after a tool result)', async () => {
    for (let i = 0; i < 30; i += 1) reviewTurn();
    const first = await snap('turn start');
    toolRoundInSameTurn(1);
    const second = await snap('after one tool round');
    toolRoundInSameTurn(2);
    const third = await snap('after two tool rounds');

    for (const d of [diffTurns(first, second), diffTurns(second, third)]) {
      expect(d.droppedFromFront).toBe(0);
      expect(d.appendOnly, `the prefix moved at message ${d.firstMovedIndex} (${d.firstMovedLane})`).toBe(true);
    }
  });

  it('1c — a FOLD moves the front once, past the folded rows, and the tail then holds still again', async () => {
    for (let i = 0; i < 30; i += 1) reviewTurn();
    const folded = (db().prepare('SELECT id, content FROM messages WHERE agent_id = ? ORDER BY seq ASC LIMIT 45')
      .all(PM) as Array<{ id: string; content: string }>);
    createLeafSummary(PM, 'The first fifteen review cycles, condensed.', 120, folded.map((r) => r.id),
      '2026-07-25 00:00:00', '2026-07-25 01:00:00');

    const atFold = await snap('the fold');
    // The folded rows left the view: the front is the boundary, not "the newest N".
    expect(allText(atFold)).not.toContain('Tracker review 1 --');
    expect(allText(atFold)).not.toContain('Tracker review 15 --');
    expect(allText(atFold)).toContain('Tracker review 16 --');

    reviewTurn();
    const next = await snap('after the fold');
    const d = diffTurns(atFold, next);
    expect(d.droppedFromFront).toBe(0);
    expect(d.appendOnly, `the prefix moved at message ${d.firstMovedIndex} (${d.firstMovedLane})`).toBe(true);
  });

  it('1d — the 60-second pruner never deletes a row the view still shows', async () => {
    // More than the pruner's own floor of rows, with the older half folded: the pruner may clear
    // the folded engine reports, and must leave every row past the boundary where it is.
    for (let i = 0; i < 40; i += 1) reviewTurn();
    const folded = (db().prepare('SELECT id FROM messages WHERE agent_id = ? ORDER BY seq ASC LIMIT 30')
      .all(PM) as Array<{ id: string }>);
    createLeafSummary(PM, 'The first ten review cycles, condensed.', 80, folded.map((r) => r.id),
      '2026-07-25 00:00:00', '2026-07-25 00:30:00');

    const before = await snap('before the sweep');
    pruneOldPMMessages(PM);
    reviewTurn();
    const after = await snap('after the sweep and one more cycle');

    const d = diffTurns(before, after);
    expect(d.droppedFromFront, 'the pruner deleted rows inside the view').toBe(0);
    expect(d.appendOnly, `the prefix moved at message ${d.firstMovedIndex} (${d.firstMovedLane})`).toBe(true);
    // CONTROL: the sweep still clears the folded engine reports it exists to clear.
    const foldedReportsLeft = (db().prepare(
      "SELECT COUNT(*) AS c FROM messages WHERE agent_id = ? AND lane = 'events' AND content LIKE 'Tracker review 1 --%'",
    ).get(PM) as { c: number }).c;
    expect(foldedReportsLeft, 'the pruner no longer clears folded engine reports').toBe(0);
  });

  it('1e — the gauge (t194 measureView) measures the grown tail the assembly sends', async () => {
    for (let i = 0; i < 30; i += 1) reviewTurn();
    const view = await measureView(PM, MODEL);
    const rows = (db().prepare('SELECT COUNT(*) AS c FROM messages WHERE agent_id = ?').get(PM) as { c: number }).c;
    expect(view.tailKeptRows, 'the gauge still measures a 40-row window the assembly no longer sends').toBe(rows);
  });
});
