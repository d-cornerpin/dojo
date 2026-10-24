// ════════════════════════════════════════════════════════════════════════════════════════
// v3.5 inspect C2 — THE SHELL SENDS DOJO QUESTIONS TO dojo_inspect.
//
// The owner, 2026-10-20: the main agent "reaches for exec shell scripts to try to look at
// history of what happens in its own dojo … It shouldn't have to rely on greps and scripts."
// Measured on the dev box: hundreds of shell calls running `sqlite3 ~/.dojo/data/dojo.db …`,
// re-deriving the schema with `pragma table_info` each time, and `tail`/`grep` on the platform
// log. dojo_inspect answers every one of those questions, read-only, with credentials refused and
// secrets blanked; the shell does neither.
//
// SO: for an agent that HOLDS dojo_inspect, a command line that reads the live database file
// (`dojo.db` and its -wal/-shm/-journal siblings) or the platform log (`dojo.log`, `dojo.log.1`)
// is refused with the one dojo_inspect call that fits it: a schema look → `schema`, a query →
// `sql`, a log read → `logs`. It is asked AFTER the broker allowed the command, so it only ever
// refuses a command that would otherwise have run; it never permits anything.
//
// WHAT IT LEAVES ALONE, each on purpose and each pinned by a test:
//   • other files under ~/.dojo/logs — dojo_inspect does not read them, so a refusal would only
//     remove a capability;
//   • a WRITE or a maintenance pragma on the database — not a question, and dojo_inspect cannot
//     do it (owner decision owed: no broker refuses a shell write of the live database today);
//   • an agent that does not hold dojo_inspect — pointing it at a tool it cannot call is a dead
//     end (owner decision owed: whether such an agent should read the database through the shell).
// ════════════════════════════════════════════════════════════════════════════════════════

import { holdsDojoInspect } from '../../inspect/grant.js';
import { deny, type Verdict } from './types.js';

/** The live database file by its basename, as a whole path segment (not `dojo.db.bak`). */
const DOJO_DB = /(?:^|[\s'"=/:])dojo\.db(?:-wal|-shm|-journal)?(?![\w.-])/i;
/** The platform log and its one rotated backup, as a whole path segment. */
const DOJO_LOG = /(?:^|[\s'"=/:])dojo\.log(?:\.1)?(?![\w.-])/i;
/** A statement or dot-command that changes the database, or a pragma that is not a schema look. */
const NOT_A_QUESTION = new RegExp([
  String.raw`\binsert\s+(?:or\s+\w+\s+)?into\b`, String.raw`\bupdate\s+[\w."\x60\[\]]+\s+set\b`, String.raw`\bdelete\s+from\b`,
  String.raw`\breplace\s+into\b`, String.raw`\b(?:drop|alter|create)\s+(?:unique\s+)?(?:table|index|view|trigger)\b`,
  String.raw`\bvacuum\b`, String.raw`\breindex\b`, String.raw`\.(?:import|restore)\b`,
  String.raw`\bpragma\s+(?!(?:table_x?info|index_list|index_x?info|foreign_key_list)\b)\w+`,
].join('|'), 'i');
const SCHEMA_LOOK = /\.(?:schema|tables|indexes|indices)\b|pragma[\s_]+table_x?info|\bsqlite_(?:master|schema)\b/i;

const VIEW_CALL = {
  sql: 'dojo_inspect(what="sql", query="…")',
  schema: 'dojo_inspect(what="schema", table="…")',
  logs: 'dojo_inspect(what="logs", pattern="…")',
} as const;

/** The dojo_inspect view that answers this command line, or null when the redirect leaves it alone. */
export function dojoQuestionView(line: string): keyof typeof VIEW_CALL | null {
  if (DOJO_DB.test(line)) {
    if (NOT_A_QUESTION.test(line)) return null;
    return SCHEMA_LOOK.test(line) ? 'schema' : 'sql';
  }
  return DOJO_LOG.test(line) ? 'logs' : null;
}

/** The refusal for a holder's Dojo question, or null. Asked after the broker allowed the line. */
export function redirectDojoQuestion(agentId: string, line: string): Verdict | null {
  const view = dojoQuestionView(line);
  if (!view || !holdsDojoInspect(agentId)) return null;
  return deny(
    'ladder-parity',
    `dojo-inspect-redirect:${view}`,
    `the Dojo's ${view === 'logs' ? 'log' : 'database'} is read through dojo_inspect, not the shell`,
    `Refused: the Dojo's database and logs are read through dojo_inspect, not the shell. For this question: ${VIEW_CALL[view]}. Call load_tool_docs("dojo_inspect") for the arguments.`,
  );
}
