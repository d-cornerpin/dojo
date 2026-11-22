// Reminders the owner asked for by iMessage, fired by the real tick and worked in turns rooted wherever the lived
// round rooted them: a run's own turn, another task's engine event, another run, or none. Built on the missed-runs
// box; the importing file mocks `gateway/ws.js` and `agent/v2/loop.js` before importing this.
import { expect, vi } from 'vitest';
import * as box from './missed-runs-box.js';

const { openTurnContext, endTurnContext } = await import('../../../agent/turn-context.js');
const { recordDelivery } = await import('../../../agent/v2/deliveries.js');
const { installJudgment } = await import('../../../agent/decision-hooks.js');
const runner = await import('../../runner.js');
/** The reaper's close of delivered runs, with the schedule moves it starts settled. */
export async function closeRunsThatDelivered(): Promise<void> { await runner.closeRunsThatDelivered(); await vi.dynamicImportSettled(); }
export const { db, call, at, MAIN, openBox, closeBox, checkScheduledTasks } = box;

export const OWNER_PHONE = '+15550000001';
export type Root = { kind: 'occurrence' | 'engine' | 'ask'; id: string } | null;
let n = 0;
const sqlNow = (): string => new Date().toISOString().replace('T', ' ').slice(0, 19);

/** The owner's iMessage to the main agent; returns its id. */
export function ownerTexts(content: string): string {
  const id = `im-${++n}`;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, channel, sender_id, authorized, inbound_meta, sent_at, created_at)
    VALUES (?, ?, 'owner', 'user', ?, 'imessage', ?, 1, ?, ?, ?)`)
    .run(id, MAIN, content, OWNER_PHONE, JSON.stringify({ channel: 'imessage', sender: OWNER_PHONE, relation: 'owner', authorized: true }), Date.now(), Date.now());
  return id;
}

/** One turn of the main agent rooted on `root`; `work` runs inside it. Returns the turn's number. `endRecorded` false:
 *  the turn stops running without its end on record, as a throw past its end would leave it. */
export async function turn(root: Root, work: () => Promise<void> | void = () => {}, endRecorded = true): Promise<number> {
  const t = ++n;
  db().prepare('INSERT INTO turns (agent_id, turn_number, started_at, answered, root_kind, root_id) VALUES (?, ?, ?, 0, ?, ?)')
    .run(MAIN, t, sqlNow(), root?.kind ?? null, root?.id ?? null);
  Object.assign(openTurnContext(MAIN), { turnNumber: t, root: root && { ...root, sourceMessageId: root.kind === 'ask' ? root.id : null } });
  try { await work(); } finally { endTurnContext(MAIN); }
  if (endRecorded) db().prepare("UPDATE turns SET ended_at = ?, exit_reason = 'answered' WHERE agent_id = ? AND turn_number = ?").run(sqlNow(), MAIN, t);
  await vi.dynamicImportSettled();
  return t;
}

/** A line the main agent writes in the open turn, by iMessage to the owner or on the dashboard; returns the delivery. */
export function line(text: string, channel: 'imessage' | 'dashboard'): string {
  const msg = `line-${++n}`;
  db().prepare("INSERT INTO messages (id, agent_id, lane, role, content, authorized, created_at) VALUES (?, ?, 'owner', 'assistant', ?, 1, ?)")
    .run(msg, MAIN, text, Date.now());
  const d = recordDelivery({ agentId: MAIN, tool: 'auto-route', channel, recipientId: channel === 'imessage' ? OWNER_PHONE : null, messageId: msg, outcome: 'delivered' });
  expect(d.kind).toBe('applied');
  const id = (d as { value: { deliveryId: string } }).value.deliveryId;
  db().prepare('UPDATE deliveries SET created_at = ? WHERE id = ?').run(sqlNow(), id);   // the database's clock is the test's
  return id;
}

/** A reminder the owner texted for, opened in its request's turn, which settled on the confirmation. */
export async function reminder(title: string, firstIso: string, everyMinutes?: number, runs?: number): Promise<string> {
  const ask = ownerTexts(`Remind me: ${title}`);
  let task = '';
  await turn({ kind: 'ask', id: ask }, async () => {
    const made = await call('work_open', { kind: 'task', title, goal: `remind the owner: ${title}`, scheduled_start: firstIso, allow_duplicate: true,
      ...(everyMinutes ? { repeat_interval: everyMinutes, repeat_unit: 'minutes' } : {}), ...(runs ? { repeat_end_type: 'after_count', repeat_end_value: String(runs) } : {}) });
    expect(made.isError, made.content).toBeFalsy();
    task = /task_id=([\w-]+)/.exec(made.content)![1]!;
    db().prepare("UPDATE work SET task_kind = 'reminder', source_message_id = ? WHERE id = ?").run(ask, task);
    const confirmation = line(`Set: ${title}.`, 'imessage');
    db().prepare(`INSERT OR REPLACE INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, result_delivery_id, opened_at, updated_at, closed_at)
      VALUES (?, 'ask', ?, 'owner', 'ask', ?, 'done', 'ask', 1, 0, 'ask', ?, ?, ?, ?)`).run(`ask:${ask}`, MAIN, ask, confirmation, Date.now(), Date.now(), Date.now());
  });
  return task;
}

export const openRun = (task: string): string =>
  (db().prepare("SELECT id FROM work WHERE kind = 'occurrence' AND parent_id = ? ORDER BY sequence DESC LIMIT 1").get(task) as { id: string }).id;
export const runState = (task: string): { state: string; result_delivery_id: string | null } =>
  db().prepare("SELECT state, result_delivery_id FROM work WHERE kind = 'occurrence' AND parent_id = ? ORDER BY sequence DESC LIMIT 1").get(task) as { state: string; result_delivery_id: string | null };
export const ghosts = (): number => (db().prepare("SELECT COUNT(*) AS n FROM work_events WHERE kind = 'floor_ghosted'").get() as { n: number }).n;
export const handIn = (task: string, ref: string) =>
  call('work_update', { action: 'hand_in', task_id: task, outcome: 'finished', proof: [{ kind: 'delivery', ref }], note: 'reminder sent' });

/** An engine hint about another task of the agent's (step two of something), as a root for a turn about it. */
export async function otherTasksHint(tag: string): Promise<Root> {
  const made = await call('work_open', { kind: 'task', title: `Step two ${tag}`, goal: 'the second step', allow_duplicate: true });
  const other = /task_id=([\w-]+)/.exec(made.content)![1]!;
  db().prepare(`INSERT INTO messages (id, agent_id, lane, role, content, task_id, origin_intent, authorized, created_at)
    VALUES (?, ?, 'events', 'user', '[Engine hint: step two is waiting]', ?, 'engine_hint', 0, ?)`).run(`hint-${tag}`, MAIN, other, Date.now());
  return { kind: 'engine', id: `hint-${tag}` };
}

/** The small local model's answer to "does this message give the person what the task owes": yes, no, or none. */
export const freeCheckSays = (yes: boolean | null): void => installJudgment(async () => (yes === null ? null : { asked: yes }));
/** Who decided the task's newest hand-in, or null while it waits for its decider. */
export const decidedBy = (task: string): string | null => (db().prepare(
  "SELECT actor FROM work_events WHERE work_id = ? AND kind = 'decided' AND id > (SELECT MAX(id) FROM work_events WHERE work_id = ? AND kind = 'handed_in')",
).get(task, task) as { actor: string } | undefined)?.actor ?? null;

