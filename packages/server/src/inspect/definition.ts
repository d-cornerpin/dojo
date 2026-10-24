// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect C1 — THE ONE DEFINITION ON THE WIRE: dojo_inspect.
//
// One schema for eight views (the house style that collapsed 17 tracker tools into two verbs:
// tool definitions are about a third of every prompt's tokens). The long form, every view and
// every argument with examples, lives in `tools/docs/dojo_inspect.md` behind load_tool_docs.
//
// A LEAF: types only. `definitions.ts` spreads this into the platform's list and must not pull
// the views' import graph (the sql child reaches the process door, which reaches the registry).
//
// NO `maxResultTokens`, deliberately: a view returns its whole answer and the tool layer keeps a
// long one whole and shows its head and tail with the `tool_result_read` call (t200). A cap here
// would cut a timeline or a query result, which is the defect t200 removed.
// ════════════════════════════════════════════════════════════════════════════════════════

import type { ToolDefinition } from '../agent/tools/types.js';

/** The eight views, in the order the description names them. */
export const INSPECT_VIEWS = ['timeline', 'conversation', 'logs', 'state', 'schema', 'sql', 'code_search', 'code_read'] as const;
export type InspectView = (typeof INSPECT_VIEWS)[number];

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

export const dojoInspectDefinition: ToolDefinition = {
  name: 'dojo_inspect',
  description: "Look at anything that happened in your own Dojo, read-only. what=timeline (the story of an agent, task, project, turn or time window, every record merged in order), conversation (any agent's messages), logs (the platform log), state (the configuration and health page), schema (every table and column, with meanings), sql (a read-only query), code_search / code_read (the platform's own source and docs). Use this before any shell command about the Dojo; call load_tool_docs('dojo_inspect') for every argument.",
  // The sql view runs each query in a child process on a read-only connection, through the
  // process door, so the agent's stop ends a runaway query (`inspect/sql-child.ts`). That door
  // matches the program the call's capability names, exactly: `process.execPath`, absolute.
  // `scopes.ts` CARRIED_PROGRAMS carries it with its reason; one call site spawns it.
  effects: [
    { kind: 'proc', from: 'derived:node, running one read-only query of the sql view in its own process', scope: { at: 'program', program: process.execPath } },
  ],
  nonEffects: {
    path: 'code_read / code_search: a path inside the Dojo\'s public GitHub repository at the commit this box runs, read over HTTPS; never a file on this machine',
    query: 'sql: a read-only statement run on a read-only connection (refused unless SQLite compiles it as a read)',
  },
  input_schema: {
    type: 'object',
    properties: {
      what: { type: 'string', enum: [...INSPECT_VIEWS], description: 'Which view.' },
      agent: str('An agent id or name (timeline, conversation, logs). conversation needs it.'),
      task_id: str('timeline: one task, with its events, calls and deliveries.'),
      project_id: str('timeline: a project and every task under it.'),
      turn: num('timeline: one turn number of agent.'),
      conversation: str('timeline: one conversation id.'),
      since: str('Window start: an ISO time or epoch ms (timeline, conversation, logs).'),
      until: str('Window end, same forms as since.'),
      around: str('A message id or a time: the turn it falls in (timeline, conversation, logs).'),
      include: { type: 'array', items: { type: 'string', enum: ['events', 'tools', 'receipts', 'deliveries', 'turns', 'messages', 'logs'] }, description: 'timeline: only these sources (default all).' },
      pattern: str('Text to find (conversation, logs, code_search).'),
      include_engine: { type: 'boolean', description: 'conversation: engine notices and tool rows too (default true).' },
      level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'logs: this level and above.' },
      component: str('logs: one component name.'),
      tail: num('logs: only the last N matching lines.'),
      table: str('schema: one table\'s columns and meanings (omit for every table).'),
      query: str('sql: one SELECT, WITH or EXPLAIN statement.'),
      path: str('code_read: a file path in the repo (e.g. packages/server/src/index.ts); code_search: a path prefix.'),
      from: num('code_read: first line (from 1).'),
      to: num('code_read: last line.'),
    },
    required: ['what'],
  },
  concurrency: 'safe',
};
