// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect B1 — THE TIMELINE OF ANYTHING.
//
// Everything that happened to an agent, a task, a project, a turn, a conversation or a time
// window, merged from every record into one ordered story (`records.ts` reads the sources).
//
// SCOPE RULES (the plan's):
//   task_id     the task's own events, plus everything its assignee did in the turns that
//               claimed it, plus every row anywhere that names it (the PM's pokes and checks).
//   project_id  every descendant task's timeline, interleaved, plus the project's own events.
//   turn        that agent's turn row and the calls, deliveries and messages of that turn.
//   conversation, agent  every record of it in the window.
// No time and no narrower scope means the latest turn (the agent's, or anyone's): the result
// says so and how to ask for more. Nothing is cut; a long result is kept whole by the tool layer.
// ════════════════════════════════════════════════════════════════════════════════════════

import type Database from 'better-sqlite3';
import { getReadOnlyDb } from '../db/connection.js';
import { readRecords, SOURCES, type Rec, type RecordScope, type Source } from './records.js';
import { agentLabel, agentNames, latestTurnWindow, resolveAgent, resolveWindow, short, utc, type Window } from './scope.js';

export interface TimelineArgs {
  agent?: string; task_id?: string; project_id?: string; turn?: number; conversation?: string;
  since?: string; until?: string; around?: string;
  include?: Source[];
}

interface Resolved { scope: Omit<RecordScope, 'from' | 'to'>; title: string; agents: string[]; narrow: boolean }

function claimedTurns(db: Database.Database, workId: string): number[] {
  const rows = db.prepare(
    "SELECT DISTINCT json_extract(payload, '$.turn_number') AS t FROM work_events WHERE work_id = ? AND kind = 'claim_turn' AND json_valid(payload)",
  ).all(workId) as Array<{ t: number | null }>;
  return rows.map((r) => r.t).filter((t): t is number => typeof t === 'number');
}

function workTree(db: Database.Database, rootId: string): Array<{ id: string; owner: string }> {
  return db.prepare(`
    WITH RECURSIVE tree(id) AS (SELECT id FROM work WHERE id = ? UNION SELECT w.id FROM work w JOIN tree t ON w.parent_id = t.id)
    SELECT w.id, coalesce(w.assignee_agent, w.agent_id) AS owner FROM work w JOIN tree USING (id)`).all(rootId) as Array<{ id: string; owner: string }>;
}

function resolve(db: Database.Database, a: TimelineArgs, names: Map<string, string>): Resolved | string {
  const root = a.task_id ?? a.project_id;
  if (root) {
    const tree = workTree(db, root);
    if (tree.length === 0) return `No task or project with id ${root}. Find ids with sql, e.g. select id, kind, title, state from work order by opened_at desc.`;
    const turnsOf = tree.map((w) => ({ agent: w.owner, turns: claimedTurns(db, w.id) }));
    const kind = a.project_id ? 'project' : 'task';
    const owners = [...new Set(tree.map((w) => w.owner))];
    return { scope: { ids: tree.map((w) => w.id), turnsOf }, title: `${kind} ${short(root)} (${owners.map((o) => agentLabel(names, o)).join(', ')})`, agents: owners, narrow: true };
  }
  const agent = a.agent ? resolveAgent(db, a.agent) : null;
  if (a.turn !== undefined) {
    if (!agent) return 'A turn number belongs to one agent: give agent as well as turn.';
    return { scope: { turnsOf: [{ agent: agent.id, turns: [a.turn] }] }, title: `turn ${a.turn} of ${agent.label}`, agents: [agent.id], narrow: true };
  }
  if (a.conversation) return { scope: { conversation: a.conversation }, title: `conversation ${short(a.conversation)}`, agents: agent ? [agent.id] : [], narrow: false };
  if (agent) return { scope: { agents: [agent.id] }, title: `agent ${agent.label}`, agents: [agent.id], narrow: false };
  return { scope: {}, title: 'the whole platform', agents: [], narrow: false };
}

/** The ordered story of whatever the arguments name. */
export function timeline(a: TimelineArgs, db: Database.Database = getReadOnlyDb()): string {
  const names = agentNames(db);
  const r = resolve(db, a, names);
  if (typeof r === 'string') return r;
  let w: Window = resolveWindow(db, a, r.agents[0] ?? null);
  if (!r.narrow && w.from === null && w.to === null && !a.around) w = latestTurnWindow(db, r.agents[0] ?? null) ?? w;
  const scope: RecordScope = { ...r.scope, from: w.from, to: w.to };
  const wanted = SOURCES.filter((s) => !a.include?.length || a.include.includes(s));
  const recs: Rec[] = readRecords(db, scope, wanted, names, r.agents);
  const order = new Map<string, number>(SOURCES.map((s, i) => [s, i]));
  recs.sort((x, y) => x.at - y.at || (order.get(x.source) ?? 0) - (order.get(y.source) ?? 0));
  const counts = wanted.map((s) => `${s} ${recs.filter((x) => x.source === s).length}`).join(' · ');
  const head = `Timeline of ${r.title}, ${w.note}: ${recs.length} record${recs.length === 1 ? '' : 's'} (${counts}).`;
  if (recs.length === 0) return `${head}\nNothing was recorded in that scope and window.`;
  const body = recs.map((x) => `[${utc(x.at)}] ${x.text}`).join('\n');
  return `${head}\n\n${body}\n\nEach line names its table and id; follow any of them up with sql (for example select * from audit_log where id = …).`;
}
