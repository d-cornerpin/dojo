// Shared bulletproofing helpers for tool implementations.
// Most tool defects are patterns: fix one helper, fix many tools.
// Helpers return a friendly string error or null/ok on success; errors are
// written for the calling agent to read, and raw DB errors go via `friendlyDbError`.
import { getDb } from '../db/connection.js';
import { editDistance } from '../tools/name-help.js';

export type FieldSpec = {
  name: string;          // user-visible field name (snake_case for agent-facing tools)
  value: unknown;        // the actual value extracted from args
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  allowEmpty?: boolean;  // default: false. Strings: trim+empty check. Arrays: length check.
};

/** work_schedule reaches the pause op when `action` is missing too; pausing is the one guess that changes the task, so ask instead. */
export function pauseActionMissing(args: Record<string, unknown>): string | null {
  const a = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  return a === 'pause' ? null : 'Error: work_schedule needs action: "pause" or "resume". Nothing was changed.';
}

export function checkRequired(fields: FieldSpec[]): string | null {
  for (const f of fields) {
    if (f.value === undefined || f.value === null) {
      return `Error: \`${f.name}\` is required.`;
    }
    const actualType: string = Array.isArray(f.value) ? 'array' : typeof f.value;
    if (actualType !== f.type) {
      return `Error: \`${f.name}\` must be a ${f.type} (got ${actualType}).`;
    }
    if (!f.allowEmpty) {
      if (f.type === 'string' && !(f.value as string).trim()) {
        return `Error: \`${f.name}\` cannot be empty.`;
      }
      if (f.type === 'array' && (f.value as unknown[]).length === 0) {
        return `Error: \`${f.name}\` cannot be empty (pass at least one item).`;
      }
    }
  }
  return null;
}

export function friendlyDbError(err: unknown, context?: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const prefix = context ? `${context}: ` : '';

  if (msg.includes('FOREIGN KEY constraint failed')) {
    // FK errors mean the referenced row doesn't exist. We don't always know
    // which FK it was without parsing the message, but we can say so clearly.
    const m = msg.match(/FOREIGN KEY constraint failed: ([^\s]+)/);
    const which = m ? ` (${m[1]})` : '';
    return `${prefix}A record this depends on doesn't exist${which}. Check that any referenced agent / project / task / group is valid and not terminated.`;
  }
  if (msg.includes('NOT NULL constraint failed')) {
    const m = msg.match(/NOT NULL constraint failed: ([^\s]+)/);
    return m
      ? `${prefix}Required field missing: \`${m[1]}\`.`
      : `${prefix}A required field is missing.`;
  }
  if (msg.includes('UNIQUE constraint failed')) {
    const m = msg.match(/UNIQUE constraint failed: ([^\s]+)/);
    return m
      ? `${prefix}A record already exists with that ${m[1]}.`
      : `${prefix}A record with that key already exists.`;
  }
  if (msg.includes('CHECK constraint failed')) {
    return `${prefix}Value is outside the allowed range or set. Check the field documentation for valid values.`;
  }
  if (msg.includes('database is locked')) {
    return `${prefix}Database busy — another operation is in progress. Retry in a moment.`;
  }
  // Unknown DB error: surface the raw message, still prefixed for context.
  return `${prefix}${msg}`;
}

export type ResolveResult = { ok: true; id: string } | { ok: false; error: string };

export function resolveAgentRef(value: string | undefined | null, context?: string): ResolveResult {
  if (!value) return { ok: false, error: `Error: agent ID or name is required${context ? ` for ${context}` : ''}.` };
  if (typeof value !== 'string') return { ok: false, error: `Error: agent reference must be a string (got ${typeof value}).` };
  // UUID-shaped: looked up by id in any status, so an ended agent still resolves (kill_agent says it is ended).
  if (value.match(/^[0-9a-f]{8}-[0-9a-f]{4}-/)) {
    const known = getDb().prepare('SELECT id FROM agents WHERE id = ?').get(value) as { id: string } | undefined;
    if (known) return { ok: true, id: known.id };
    return { ok: false, error: `Agent "${value}" doesn't exist. Use list_agents to see the agents there are.` };
  }
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM agents
       WHERE (id = ? OR name = ? COLLATE NOCASE)
         AND status != 'terminated'
       ORDER BY created_at DESC LIMIT 1`
  ).get(value, value) as { id: string } | undefined;
  if (row) return { ok: true, id: row.id };
  return {
    ok: false,
    error: `Agent "${value}" doesn't exist or is terminated. Spawn one with spawn_agent, or pass an existing agent's UUID directly.`,
  };
}

/** Display name for an agent id; rows sometimes hold a display name, so a non-UUID is usable. */
export function resolveAgentDisplayName(idOrName: string | null | undefined): string | null {
  if (!idOrName) return null;
  try {
    const row = getDb().prepare('SELECT name FROM agents WHERE id = ?').get(idOrName) as { name?: string } | undefined;
    if (row?.name) return row.name;
  } catch { /* best effort */ }
  return /^[0-9a-f-]{32,}$/i.test(idOrName) ? null : idOrName;
}

export interface LiveAgentByName { id: string; name: string; status: string; created_at: string }

/** Live agents named `name`, any case, newest first; rowid breaks ties so tool and transport pick alike. */
export function liveAgentsNamed(name: string): LiveAgentByName[] {
  return getDb().prepare(
    `SELECT id, name, status, created_at FROM agents
       WHERE name = ? COLLATE NOCASE AND status != 'terminated'
       ORDER BY created_at DESC, rowid DESC`,
  ).all(name) as LiveAgentByName[];
}

/**
 * The live agent the create/rename doors must refuse: a live agent whose name differs
 * from `name` only by capital letters, which the case-insensitive lookup cannot tell
 * apart. Null for a byte-identical duplicate, for `selfId` (renaming "Helper" to
 * "helper" is fine), and for terminated agents (never found by name). */
export function caseVariantClash(name: string, selfId?: string): LiveAgentByName | null {
  const wanted = name.trim();
  for (const row of liveAgentsNamed(wanted)) {
    if (row.id === selfId) continue;
    if (row.name !== wanted) return row;
  }
  return null;
}

/** The plain door error naming the clashing agent, in the style the doors already use. */
export function caseVariantClashMessage(existingName: string): string {
  return `An agent named "${existingName}" already exists; names are matched without regard to capital letters.`;
}

/** When a name matches two live agents (differing only by case), the sender is told who got it. */
export function sameNameNote(ref: string, named: ReadonlyArray<{ id: string; name: string }>): string {
  if (named.length < 2) return '';
  return ` NOTE: ${named.length} live agents are named "${ref}" (differing only by capital letters): ${named.map((a) => `"${a.name}" (${a.id})`).join(', ')}. The message went to the newest, "${named[0].name}" (${named[0].id}); pass an agent id to reach a different one.`;
}

export function liveAgentNamesNear(requested: string): string[] {
  const names = (getDb().prepare(
    `SELECT name FROM agents WHERE status != 'terminated' AND name IS NOT NULL ORDER BY name COLLATE NOCASE`,
  ).all() as Array<{ name: string }>).map((r) => r.name);
  const want = requested.trim().toLowerCase();
  const close = want === '' ? [] : names.filter((n) => {
    const have = n.toLowerCase();
    return have.includes(want) || want.includes(have) || editDistance(want, have) <= 2;
  });
  return [...new Set(close.length > 0 ? close : names)];
}

export function resolveGroupRef(value: string | undefined | null, context?: string): ResolveResult {
  if (!value) return { ok: false, error: `Error: group ID or name is required${context ? ` for ${context}` : ''}.` };
  if (typeof value !== 'string') return { ok: false, error: `Error: group reference must be a string (got ${typeof value}).` };
  if (value.match(/^[0-9a-f]{8}-[0-9a-f]{4}-/)) return { ok: true, id: value };
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM agent_groups
       WHERE id = ? OR name = ? COLLATE NOCASE
       LIMIT 1`
  ).get(value, value) as { id: string } | undefined;
  if (row) return { ok: true, id: row.id };
  return {
    ok: false,
    error: `Group "${value}" doesn't exist. Use list_groups to see existing groups, or create_agent_group to make a new one.`,
  };
}

export function isTerminalTaskStatus(status: string | null | undefined): boolean {
  // A cancelled task can no longer be worked, so it reads terminal like the other two.
  return status === 'complete' || status === 'fallen' || status === 'cancelled';
}


/**
 * How a compact list says how many results it holds: a count and the FORM they are in.
 * What the agent can see of a long result is decided later, where the result is admitted
 * (`memory/tool-result-view.ts` excerpts and labels); a tool may not claim "shown". */
export function compactCountNote(count: number, noun = 'result'): string {
  return `${count} ${noun}${count === 1 ? '' : 's'} in compact form`;
}

export function compactListTrailer(opts: {
  count: number;
  expandTool: string;          // e.g. 'get_agent_profile'
  expandArg: string;           // e.g. 'agent_id'
  listTool: string;            // e.g. 'list_agents'
  verbose: boolean;            // current call's verbose flag
}): string {
  if (opts.verbose) return '';
  if (opts.count === 0) return '';
  const idArg = `${opts.expandArg}=<id>`;
  return `\n\n${compactCountNote(opts.count)}. For full detail on one: ${opts.expandTool}(${idArg}). For all details on every result: re-call ${opts.listTool} with verbose=true.`;
}

// atomicWrite STRIPPED: `db/unit.ts withUnit` is the same requirement finished: sync-only
// (this accepted `async` and could hand the connection away mid-transaction), nesting-aware,
// `afterCommit` lets the broadcast wait for the commit, and it had zero callers on the record.
// The `git grep` evidence is in deploy/code-history/c5-027-server-src-agent.md.
