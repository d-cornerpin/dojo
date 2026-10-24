// Shared fixture for the dojo_inspect view tests: a migrated scratch database seeded with ONE
// task's whole life, as the real tables hold it. Every agent is named by role; every secret is a
// synthetic string. A test file mocks `db/connection.js` to hand this database out (see
// timeline.test.ts) and then calls `seedTaskStory`.

import type Database from 'better-sqlite3';

export const T0 = Date.UTC(2026, 9, 19, 9, 0, 0);
export const at = (min: number, sec = 0): number => T0 + min * 60_000 + sec * 1000;
/** SQLite's UTC datetime text, the form `datetime('now')` writes. */
export const sqlTime = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

export const TASK = 'task0000-1111-2222-3333-444455556666';
export const PROJECT = 'proj0000-1111-2222-3333-444455556666';
export const SECOND_TASK = 'task9999-1111-2222-3333-444455556666';
export const BEARER = 'abcdefghijklmnopqrstuvwxyz0123456789WXYZ';

export function seedTaskStory(db: Database.Database): void {
  const agent = db.prepare("INSERT INTO agents (id, name, classification) VALUES (?, ?, 'apprentice')");
  agent.run('agent-primary', 'primary');
  agent.run('agent-worker', 'worker');
  agent.run('agent-pm', 'pm');
  db.prepare("INSERT INTO conversations (id, agent_id, channel) VALUES ('conv-owner', 'agent-primary', 'dashboard')").run();

  const work = db.prepare(`INSERT INTO work (id, kind, parent_id, agent_id, assignee_agent, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, opened_at, updated_at)
    VALUES (?, ?, ?, 'agent-primary', ?, 'owner', 'ask', 'root-ask', ?, 'DO', 1, 0, ?, ?, ?)`);
  work.run(PROJECT, 'project', null, null, 'open', 'a project', at(0), at(0));
  work.run(TASK, 'task', PROJECT, 'agent-worker', 'claimed', 'label the inbox', at(0), at(6));
  work.run(SECOND_TASK, 'task', PROJECT, 'agent-pm', 'open', 'a second piece', at(1), at(1));

  const ev = db.prepare('INSERT INTO work_events (work_id, kind, payload, actor, created_at) VALUES (?, ?, ?, ?, ?)');
  ev.run(TASK, 'opened', JSON.stringify({ message_id: 'msg-open' }), 'owner', at(0));
  ev.run(TASK, 'transition', JSON.stringify({ from: 'open', to: 'claimed', reason: 'turn pickup' }), 'agent-worker', at(1));
  ev.run(TASK, 'claim_turn', JSON.stringify({ turn_number: 5 }), 'agent-worker', at(1));
  ev.run(TASK, 'poke', JSON.stringify({ reason: 'no progress for a while' }), 'agent-pm', at(4));
  ev.run(TASK, 'transition', JSON.stringify({ from: 'claimed', to: 'done', reason: 'delivered via dashboard' }), 'agent-worker', at(6));
  ev.run(SECOND_TASK, 'opened', JSON.stringify({}), 'agent-pm', at(1, 30));

  const turn = db.prepare('INSERT INTO turns (agent_id, turn_number, kind, started_at, ended_at, exit_reason, answered, effectful_calls) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  turn.run('agent-worker', 4, 'conv', sqlTime(at(-10)), sqlTime(at(-9)), 'answered', 1, 0);
  turn.run('agent-worker', 5, 'conv', sqlTime(at(1)), sqlTime(at(6)), 'answered', 1, 3);
  turn.run('agent-primary', 9, 'conv', sqlTime(at(20)), sqlTime(at(21)), 'answered', 1, 0);

  const audit = db.prepare('INSERT INTO audit_log (id, agent_id, action_type, target, result, detail, created_at, turn_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  audit.run('aud-1', 'agent-worker', 'tool_call', 'gmail_search', 'success', 'from:billing', sqlTime(at(2)), 5);
  audit.run('aud-2', 'agent-worker', 'tool_call', 'gmail_label', 'error', 'the provider refused', sqlTime(at(3)), 5);
  audit.run('aud-3', 'agent-worker', 'tool_call', 'gmail_label', 'success', 'label 12 messages', sqlTime(at(3, 30)), 5);
  audit.run('aud-4', 'agent-pm', 'tool_call', 'work_update', 'success', `poke ${TASK}`, sqlTime(at(4)), 2);
  audit.run('aud-5', 'agent-worker', 'file_read', 'an unrelated earlier turn', 'success', null, sqlTime(at(-10)), 4);

  db.prepare(`INSERT INTO tool_receipts (id, agent_id, tool, tier, verified, basis, provider_id, task_id, created_at, updated_at, turn_number)
    VALUES ('rcpt-1', 'agent-worker', 'gmail_label', 1, 1, 'provider-id', 'prov-77', ?, ?, ?, 5)`).run(TASK, sqlTime(at(3, 30)), sqlTime(at(3, 30)));
  db.prepare(`INSERT INTO deliveries (id, agent_id, turn_number, tool, channel, recipient_display, root_kind, root_id, outcome, created_at, updated_at)
    VALUES ('dlv-1', 'agent-worker', 5, 'send_message', 'dashboard', 'the owner', 'task', ?, 'delivered', ?, ?)`).run(TASK, sqlTime(at(5)), sqlTime(at(5)));

  db.prepare(`INSERT INTO messages (id, agent_id, lane, role, content, turn_number, source_agent_id, a2a_thread_id, a2a_intent, created_at, sent_at)
    VALUES ('msg-w-1', 'agent-worker', 'a2a', 'user', ?, 5, 'agent-pm', 'thread-1234567', 'ASSIGN', ?, ?)`).run(`[A2A:ASSIGN] please ${TASK}`, at(1), at(1));
  const msg = db.prepare(`INSERT INTO messages (id, agent_id, conversation_id, lane, role, content, channel, turn_number, a2a_thread_id, a2a_intent, created_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  msg.run('msg-w-2', 'agent-worker', null, 'owner', 'assistant', JSON.stringify([{ type: 'tool_use', id: 'call-1', name: 'gmail_label', input: { n: 12 } }]), null, 5, null, null, at(3), at(3));
  msg.run('msg-w-3', 'agent-worker', null, 'owner', 'tool', JSON.stringify([{ type: 'tool_result', tool_use_id: 'call-1', content: 'labelled 12', is_error: false }]), null, 5, null, null, at(3, 31), at(3, 31));
  msg.run('msg-w-4', 'agent-worker', null, 'owner', 'assistant', `Done. The upstream header was Authorization: Bearer ${BEARER}`, 'dashboard', 5, null, null, at(5), at(5));
  msg.run('msg-w-5', 'agent-worker', null, 'events', 'system', '[Engine hint: an engine notice]', null, 5, null, null, at(5, 30), at(5, 30));
  msg.run('msg-p-1', 'agent-primary', 'conv-owner', 'owner', 'user', 'how did the inbox labelling go?', 'dashboard', 9, null, null, at(20), at(20));
  msg.run('msg-p-2', 'agent-primary', 'conv-owner', 'owner', 'assistant', 'It went fine.', 'dashboard', 9, null, null, at(20, 30), at(20, 30));
}
