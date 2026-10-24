// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect C1 — THE DISPATCHER: `what` → one view, with that view's own arguments.
//
// Each view is a plain function with its own tests (Parts A and B); this module only routes.
// Three rules it carries:
//   • `sql` is AWAITED: the query runs in a child process inside this call, under its capability
//     and the agent's stop (`sql-child.ts`).
//   • the code views get the CALLING agent's id, which puts every GitHub call under that agent's
//     stop button (`source-remote.ts`).
//   • a number the model sent as text ("12") is a number; anything else is left out, so the view
//     answers as if the argument was not given.
// ════════════════════════════════════════════════════════════════════════════════════════

import { coerceNumberArg } from '../agent/tools/pagination.js';
import { INSPECT_VIEWS } from './definition.js';
import { timeline, type TimelineArgs } from './timeline.js';
import { conversation } from './conversation.js';
import { logs, type Level } from './logs.js';
import { state } from './state.js';
import { schema } from './schema.js';
import { sql } from './sql.js';
import { codeSearch, codeRead } from './code.js';

type Args = Record<string, unknown>;

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
const count = (v: unknown): number | undefined => coerceNumberArg(v) ?? undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const span = (args: Args) => ({ since: text(args.since), until: text(args.until), around: text(args.around) });

/** The answer of the view `args.what` names, or the eight views when it names none. */
export async function dojoInspect(args: Args, agentId: string): Promise<string> {
  switch (args.what) {
    case 'timeline':
      return timeline({
        agent: text(args.agent), task_id: text(args.task_id), project_id: text(args.project_id), turn: count(args.turn), conversation: text(args.conversation),
        ...span(args), include: Array.isArray(args.include) ? (args.include.filter((s) => typeof s === 'string') as TimelineArgs['include']) : undefined,
      });
    case 'conversation':
      return conversation({ agent: text(args.agent) ?? '', ...span(args), pattern: text(args.pattern), include_engine: bool(args.include_engine) });
    case 'logs':
      return logs({ ...span(args), level: text(args.level) as Level | undefined, component: text(args.component), agent: text(args.agent), pattern: text(args.pattern), tail: count(args.tail) });
    case 'state':
      return state();
    case 'schema':
      return schema({ table: text(args.table) });
    case 'sql':
      return await sql({ query: typeof args.query === 'string' ? args.query : '' });
    case 'code_search':
      return codeSearch({ pattern: typeof args.pattern === 'string' ? args.pattern : '', path: text(args.path) }, agentId);
    case 'code_read':
      return codeRead({ path: typeof args.path === 'string' ? args.path : '', from: count(args.from), to: count(args.to) }, agentId);
    default:
      return `what must be one of: ${INSPECT_VIEWS.join(', ')}. Call load_tool_docs("dojo_inspect") for each view's arguments.`;
  }
}
