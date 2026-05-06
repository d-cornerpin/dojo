// Shared bulletproofing helpers for tool implementations.
//
// The point of this file: most tool defects are patterns, not unique bugs.
// Centralising the patterns here lets the audit fix one helper and have it
// apply across many tools, instead of fixing the same shape of bug 80 times.
//
// Conventions:
//  - Helpers return either a friendly string error OR null/ok-object on success.
//  - Errors are written for the calling agent (model) to read. They tell the
//    caller what went wrong AND what to do next, in plain language.
//  - Never expose raw SQLite errors. Translate via `friendlyDbError`.
import { getDb } from '../db/connection.js';

// ── checkRequired ─────────────────────────────────────────────────────────
//
// Validates that required fields are present, of the right type, and (by
// default) non-empty. Returns a single friendly error string on the first
// failure, or null on success.
//
// Use at the top of every tool handler. Without this, undefined fields blow
// up deep inside the implementation with cryptic messages like "Cannot read
// properties of undefined (reading 'toLowerCase')".

export type FieldSpec = {
  name: string;          // user-visible field name (snake_case for agent-facing tools)
  value: unknown;        // the actual value extracted from args
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  allowEmpty?: boolean;  // default: false. Strings: trim+empty check. Arrays: length check.
};

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

// ── pickArg ───────────────────────────────────────────────────────────────
//
// Returns the first non-undefined value from an args bag, checking each key
// in order. Used to handle snake/camel and well-known aliases without
// scattering ?? chains across every tool.
//
// Example:
//   const taskId = pickArg<string>(args, 'task_id', 'taskId');
//   const pattern = pickArg<string>(args, 'pattern', 'query');

export function pickArg<T>(args: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    if (args[k] !== undefined) return args[k] as T;
  }
  return undefined;
}

// ── friendlyDbError ───────────────────────────────────────────────────────
//
// Translates SQLite error messages into agent-readable form. Raw errors like
// `FOREIGN KEY constraint failed: agents.name` are useless to a model — it
// can't act on them. This produces actionable strings.
//
// Use in catch blocks: `return friendlyDbError(err, 'tracker_create_task');`

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
  // Unknown DB error — surface the raw message but still prefix it for context.
  return `${prefix}${msg}`;
}

// ── resolveAgentRef ───────────────────────────────────────────────────────
//
// Accepts either an agent UUID, a sensei id ("kevin", "dreamer", …), or an
// agent name (case-insensitive). Returns the canonical id or a friendly error.
//
// This is the cross-tool version of the resolver previously inlined into
// trackerCreateTask + trackerReassignTask. Any tool that takes an agent
// reference should use this.

export type ResolveResult = { ok: true; id: string } | { ok: false; error: string };

export function resolveAgentRef(value: string | undefined | null, context?: string): ResolveResult {
  if (!value) return { ok: false, error: `Error: agent ID or name is required${context ? ` for ${context}` : ''}.` };
  if (typeof value !== 'string') return { ok: false, error: `Error: agent reference must be a string (got ${typeof value}).` };
  // UUID — trust it. If the UUID is stale/deleted, the FK will catch it and
  // friendlyDbError will translate.
  if (value.match(/^[0-9a-f]{8}-[0-9a-f]{4}-/)) return { ok: true, id: value };
  // Sensei id (lowercase plain string) OR name (case-insensitive).
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

// ── resolveGroupRef ───────────────────────────────────────────────────────
//
// Same shape as resolveAgentRef, for agent_groups.

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

// ── isTerminalAgentStatus ────────────────────────────────────────────────
//
// True when an agent is in a state from which it can't transition further
// (terminated). Used by tools that should be no-ops on dead agents instead
// of failing or resurrecting them.

export function isTerminalAgentStatus(status: string | null | undefined): boolean {
  return status === 'terminated';
}

// ── isTerminalTaskStatus ─────────────────────────────────────────────────

export function isTerminalTaskStatus(status: string | null | undefined): boolean {
  return status === 'complete' || status === 'fallen';
}

// ── validateAgainstSchema ────────────────────────────────────────────────
//
// Generic validator driven by a tool's existing `input_schema`. Use this for
// large tool batches (Google Slides ~36, Microsoft 365 ~30, Office ~4) where
// hand-coding per-tool checkRequired() arrays would be tedious and prone to
// drift from the schema.
//
// Behaviour:
//  - Walks `schema.required` and verifies each named field is present in args.
//  - Verifies type when schema.properties[<field>].type is set.
//  - Returns null on success, a single user-readable error string on failure.
//
// Side note: this DOESN'T validate beyond required + type. Min/max, enums,
// nested object schemas, etc. are still the per-tool implementation's job —
// but missing-required + wrong-type covers ~90% of the cryptic-crash bugs
// we've seen this session.

type SimpleSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, { type?: string }>;
};

export function validateAgainstSchema(
  toolName: string,
  schema: SimpleSchema | undefined,
  args: Record<string, unknown>,
): string | null {
  if (!schema || !Array.isArray(schema.required) || schema.required.length === 0) return null;
  for (const field of schema.required) {
    const value = args[field];
    if (value === undefined || value === null) {
      return `Error: \`${field}\` is required for ${toolName}.`;
    }
    const expectedType = schema.properties?.[field]?.type;
    if (!expectedType) continue;
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (expectedType !== actualType) {
      return `Error: \`${field}\` must be a ${expectedType} for ${toolName} (got ${actualType}).`;
    }
    // Refuse empty strings and arrays for required fields. If a tool truly
    // wants to accept empty values it should mark the field optional.
    if (expectedType === 'string' && !(value as string).trim()) {
      return `Error: \`${field}\` cannot be empty for ${toolName}.`;
    }
    if (expectedType === 'array' && (value as unknown[]).length === 0) {
      return `Error: \`${field}\` cannot be empty for ${toolName} (pass at least one item).`;
    }
  }
  return null;
}

// ── compactListTrailer ───────────────────────────────────────────────────
//
// Standard footer line appended to compact list-tool responses. Tells the
// agent how to escape into full detail — either by drilling into one item via
// the per-item expand tool, or by re-calling the list tool with verbose=true.
//
// The compress-by-default-expand-on-request pattern keeps the per-turn
// context budget tight while leaving the full data one tool call away.

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
  return `\n\n${opts.count} result${opts.count === 1 ? '' : 's'} shown (compact). For full detail on one: ${opts.expandTool}(${idArg}). For all details on every result: re-call ${opts.listTool} with verbose=true.`;
}

// ── atomicWrite ──────────────────────────────────────────────────────────
//
// Wraps a series of DB writes in a transaction so partial failures roll back.
// Use for tools that touch >1 table — a failure mid-write must NOT leave the
// system in a half-applied state. `complete_task` is the canonical example
// (terminate agent + update task + notify parent — all or nothing).

export function atomicWrite<T>(fn: () => T): T {
  const db = getDb();
  return db.transaction(fn)();
}
