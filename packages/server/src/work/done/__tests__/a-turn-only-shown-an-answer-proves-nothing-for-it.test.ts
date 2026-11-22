// A turn about the owner's next question is shown the helper's answer to his earlier request, and answers only the
// new question. That line is not the earlier request's proof: a turn only shown a request's answer did not act for it.
// The same line from a turn that took the earlier request up is.
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {} }));

import { runMigrations } from '../../../db/migrations.js';
import { freshDoneDb, doneDb, seedTask } from './helpers/done-db.js';
import { proofFor } from '../proof.js';
import { turnRow } from '../../../agent/v2/__tests__/helpers/live-turn.js';

const AGENT = 'agent-main';
const CARD = 'task-camping';

/** Turn `n` rooted on the owner's message `root`, with one line to him; `shown` marks the camping answer shown in it. */
function turnWithLine(n: number, root: string, shown: boolean): string {
  turnRow(AGENT, n, { kind: 'ask', id: root });
  if (shown) doneDb().prepare("INSERT INTO work_events (work_id, kind, actor, payload, created_at) VALUES ('ask:m-camping', 'audit', 'engine', ?, ?)")
    .run(JSON.stringify({ marker: 'pieces_shown', turn: n }), Date.now());
  doneDb().prepare("INSERT INTO messages (id, agent_id, lane, role, content, authorized, created_at) VALUES (?, ?, 'owner', 'assistant', 'Tomorrow is sunny, 21 degrees.', 1, ?)")
    .run(`m-line-${n}`, AGENT, Date.now());
  doneDb().prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, message_id, outcome, created_at, updated_at)
    VALUES (?, ?, ?, 'auto-route', 'dashboard', ?, 'delivered', datetime('now'), datetime('now'))`).run(`d-${n}`, AGENT, n, `m-line-${n}`);
  return `d-${n}`;
}

beforeEach(() => {
  freshDoneDb();
  runMigrations();
  doneDb().prepare("INSERT INTO agents (id, name) VALUES (?, 'Main')").run(AGENT);
  for (const [id, at] of [['m-camping', Date.now() - 120_000], ['m-weather', Date.now() - 30_000]] as const) {
    doneDb().prepare("INSERT INTO messages (id, agent_id, lane, role, content, channel, authorized, created_at) VALUES (?, ?, 'owner', 'user', 'a question', 'dashboard', 1, ?)").run(id, AGENT, at);
    doneDb().prepare(`INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
      VALUES (?, 'ask', ?, 'owner', 'ask', ?, 'blocked', 'ask', 1, 0, 'ask', ?, ?)`).run(`ask:${id}`, AGENT, id, at, at);
  }
  seedTask(CARD, AGENT);
  doneDb().prepare("UPDATE work SET requester = 'agent', requester_id = ?, source_message_id = 'm-camping', opened_at = ? WHERE id = ?").run(AGENT, Date.now() - 100_000, CARD);
});

describe('a turn only shown an answer proves nothing for it', () => {
  it('the line of a turn on the next question, shown the camping answer, is not the camping card\'s proof', () => {
    turnWithLine(5, 'm-weather', true);
    expect(proofFor(CARD).filter((i) => i.kind === 'delivery')).toEqual([]);
  });

  it('the line of a turn that took the camping request up is', () => {
    const d = turnWithLine(6, 'm-camping', false);
    expect(proofFor(CARD).map((i) => i.ref)).toContain(d);
  });
});
