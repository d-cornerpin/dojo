// A small board for the hand-in and decision tests: the PM, the main agent and two workers, a task the
// owner asked for, a worker's message to the owner (a real proof item), and the real entry points.
//
//   vi.mock('../../../db/connection.js', async () => (await import('./helpers/done-db.js')).connectionMock());
//   vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
import { runMigrations } from '../../../../db/migrations.js';
import { clearPlatformConfigCache } from '../../../../config/platform.js';
import { executeTool } from '../../../../agent/tools/index.js';
import { toolResultOf } from '../../../../agent/tool-outcome.js';
import { FXID } from '../../../../../../../deploy/checks/fixture-vocabulary.mjs';
import { freshDoneDb, doneDb } from './done-db.js';
import { appendWorkEvent } from '../../../store.js';
import { openTurnContext, endTurnContext } from '../../../../agent/turn-context.js';

export const PM = FXID.n1;
export const MAIN = FXID.n2;
export const WORKER = FXID.n3;
export const OTHER = FXID.n4;
export const TASK = 'task-decide-0001';

const sqlTime = (ms: number): string => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
let n = 0;

/** A fresh board. The task is worked by `worker` and was asked for by the owner. */
export function freshBoard(worker = WORKER): void {
  freshDoneDb();
  runMigrations();
  for (const [k, v] of [['pm_agent_id', PM], ['primary_agent_id', MAIN]]) {
    doneDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(k, v);
  }
  clearPlatformConfigCache();
  for (const a of [PM, MAIN, WORKER, OTHER]) {
    doneDb().prepare("INSERT OR IGNORE INTO agents (id, name, status, classification) VALUES (?, ?, 'idle', 'sensei')").run(a, a);
  }
  const at = Date.now() - 60_000;
  doneDb().prepare(
    `INSERT INTO work (id, kind, agent_id, requester, root_kind, root_id, state, intent, wakes, closes_thread, title, goal, opened_at, updated_at)
     VALUES (?, 'task', ?, 'owner', 'tracker', ?, 'claimed', 'task', 1, 0, 'Write the report', 'The owner has the report', ?, ?)`,
  ).run(TASK, worker, TASK, at, at);
}

/** The worker's own message to the owner, delivered: a proof item. Returns the delivery id. */
export function deliveredToOwner(agent = WORKER, text = 'The report has 12 sections; the totals are on page 3.'): string {
  const id = `dlv-${++n}`;
  const at = Math.floor(Date.now() / 1000) * 1000;
  doneDb().prepare(
    `INSERT INTO messages (id, agent_id, lane, role, content, authorized, sent_at, created_at)
     VALUES (?, ?, 'owner', 'assistant', ?, 1, ?, ?)`,
  ).run(`msg-${id}`, agent, text, at, at);
  doneDb().prepare(
    `INSERT INTO deliveries (id, agent_id, tool, channel, recipient_id, message_id, outcome, created_at, updated_at)
     VALUES (?, ?, 'auto-route', 'dashboard', NULL, ?, 'delivered', ?, ?)`,
  ).run(id, agent, `msg-${id}`, sqlTime(at), sqlTime(at));
  return id;
}

/** A tool call through the real executor, as `agent`. */
export async function call(agent: string, name: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const r = toolResultOf(await executeTool(agent, { id: `c-${++n}`, name, arguments: args } as never));
  return { content: String(r.content), isError: !!r.isError };
}

/** The worker hands the task in, finished, with its message to the owner as proof. */
export async function handedIn(worker = WORKER): Promise<string> {
  const d = deliveredToOwner(worker);
  const r = await call(worker, 'work_update', { action: 'hand_in', task_id: TASK, outcome: 'finished', proof: [{ kind: 'delivery', ref: d }], note: 'Report sent to the owner' });
  if (r.isError) throw new Error(`hand-in refused: ${r.content}`);
  return d;
}

export const stateOf = (id = TASK): string => (doneDb().prepare('SELECT state FROM work WHERE id = ?').get(id) as { state: string }).state;
export const eventCount = (kind: string, id = TASK): number =>
  (doneDb().prepare('SELECT COUNT(*) AS c FROM work_events WHERE work_id = ? AND kind = ?').get(id, kind) as { c: number }).c;

const OWNER_ROW = { agent: MAIN, lane: 'owner', role: 'user', channel: 'dashboard', source_agent_id: null as string | null,
  inbound_meta: JSON.stringify({ channel: 'dashboard', accountKind: 'agent', authorized: true, relation: 'owner' }) as string | null, at: 1000 };
export type OwnerRow = Partial<typeof OWNER_ROW>;

/** A message from the owner to `over.agent` (the main agent by default), `over.at` ms from now. Returns its id. */
export function ownerSays(content: string, over: OwnerRow = {}): string {
  const r = { ...OWNER_ROW, ...over };
  const at = Date.now() + r.at;
  const id = `m-${++n}`;
  doneDb().prepare(
    `INSERT INTO messages (id, agent_id, conversation_id, lane, role, content, channel, source_agent_id, authorized, inbound_meta, sent_at, created_at)
     VALUES (?, ?, 'conv-owner', ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(id, r.agent, r.lane, r.role, content, r.channel, r.source_agent_id, r.inbound_meta, at, at);
  return id;
}

/** The owner is asked about the task's newest hand-in: his card. */
export const ownerAsked = (id = TASK): void => { appendWorkEvent(id, 'validation_escalated', 'scheduler', { thread_id: null }); };

/** `agent` relays `verdict` with `quote`, in a turn answering the message `answering`. */
export async function relayAnswering(answering: string, quote: string, verdict = 'approve', agent = MAIN): Promise<{ content: string; isError: boolean }> {
  openTurnContext(agent).root = { kind: 'ask', id: answering, sourceMessageId: answering };
  try {
    return await call(agent, 'work_validate', { action: 'decide', task_id: TASK, verdict, reason: 'The owner decided', user_quote: quote });
  } finally {
    endTurnContext(agent);
  }
}
