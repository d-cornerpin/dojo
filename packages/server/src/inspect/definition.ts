// Leaf module, types only: definitions.ts spreads it and must not pull in the views' import graph.
// The sql child reaches the process door, which reaches the registry.
// No maxResultTokens: a view returns its whole answer and the tool layer keeps a long one whole
// (head and tail plus the tool_result_read call); a cap here would cut a timeline or a query result.

import type { ToolDefinition } from '../agent/tools/types.js';

export const INSPECT_VIEWS = ['timeline', 'conversation', 'logs', 'state', 'schema', 'sql', 'code_search', 'code_read'] as const;

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });

export const dojoInspectDefinition: ToolDefinition = {
  name: 'dojo_inspect',
  description: "Look at anything that happened in your own Dojo, read-only. what=timeline (the story of an agent, task, project, turn or time window, every record merged in order), conversation (any agent's messages), logs (the platform log), state (the configuration and health page), schema (every table and column), sql (a read-only query), code_search / code_read (the platform's own source and docs). Use this before any shell command about the Dojo; call load_tool_docs('dojo_inspect') for every argument.",
  // The sql view runs each query in a child process (sql-child.ts) so the agent's stop ends a runaway query; the
  // process door matches the capability's program exactly: `process.execPath`, absolute. One call site spawns it.
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
      table: str('schema: one table\'s columns (omit for every table).'),
      query: str('sql: one SELECT, WITH or EXPLAIN statement.'),
      path: str('code_read: a file path in the repo (e.g. packages/server/src/index.ts); code_search: a path prefix.'),
      from: num('code_read: first line (from 1).'),
      to: num('code_read: last line.'),
    },
    required: ['what'],
  },
  concurrency: 'safe',
};
