// ════════════════════════════════════════════════════════════════════════════
// THE ARGUMENT SHAPE — SIZES AND TYPES, NEVER A VALUE (DOJO-REPORT T3)
//
// `audit_log` normalises `action_type` to a six-value CHECK set and stores
// neither the tool NAME nor the ARGUMENTS, so the only record of what the agent
// actually called is the assistant message's own `tool_use` blocks. Those blocks
// contain the user's content — a file path, a search query, a message body — so
// nothing in this file may ever emit one.
//
//  1. WHAT IT EMITS IS THE SHAPE: for each top-level argument, its KEY (checked
//     against that tool's own declared schema), the JSON TYPE of its value, and
//     the BYTE SIZE of its value. `JSON.stringify(value).length` is a
//     measurement of the value, not the value — a triager learns "a 40 KB string
//     went into `content`" and learns nothing about what was in it.
//
//  2. AN UNDECLARED KEY BECOMES `<undeclared-arg>`, because the key is the ONE
//     field here whose text the MODEL chose. A tool's declared property names are
//     platform-authored; anything else is a string the model minted, and a minted
//     string is the door a prompt injection walks a filename through. T1's builder
//     re-checks the key against the SAME schema and renders `UNRECOGNISED` — two
//     independent checks, in two modules that do not trust each other.
//
//  3. THE EXTRACTOR FAILS CLOSED ON AN UNRECOGNISED SHAPE. It handles the two
//     live forms of `StoredMessage.content` — a JSON string that parses to an
//     array of content blocks, and an array already parsed — and CONTRIBUTES
//     NOTHING for any other. A guess about where a tool name lives is a guess
//     about which string is safe to emit, so it never guesses.
// ════════════════════════════════════════════════════════════════════════════

import { registryToolDefinitions } from '../agent/tools/registry.js';

/** The sentinel a key the tool never declared becomes. Never the key itself. */
export const UNDECLARED_ARG = '<undeclared-arg>';

export interface ArgShapeEntry { key: string; type: string; bytes: number }

/** The JSON type of a value, in the vocabulary `tool.arg_shape.type` declares.
 *  `undefined`/`function`/`symbol` are not JSON types and are passed through AS
 *  THEMSELVES, so T1's coercer renders `UNRECOGNISED`; mapping them onto `null`
 *  here would fabricate a member of a domain that never had one. */
function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
}

/** Bytes of the serialized value. `undefined` serializes to nothing, which is 0 bytes. */
function byteSize(v: unknown): number {
  try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; }
}

/**
 * THE SHAPE OF ONE CALL'S ARGUMENTS. `toolName` is resolved against the LIVE registry
 * rather than a frozen copy, exactly as `enumMembers` does, so a renamed property stops
 * being a declared key the moment the tool stops declaring it.
 */
export function shapeOfArgs(toolName: string, args: unknown): {
  argShape: ArgShapeEntry[]; argsTotalBytes: number;
} {
  const argsTotalBytes = byteSize(args);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { argShape: [], argsTotalBytes };
  }
  const def = registryToolDefinitions().find(d => d.name === toolName);
  // No definition ⇒ no declared property names ⇒ every key is undeclared. The
  // unresolvable branch narrows what may be emitted; it never widens it.
  const declared = new Set(def ? Object.keys(def.input_schema.properties) : []);
  const argShape = Object.entries(args as Record<string, unknown>).map(([key, value]) => ({
    key: declared.has(key) ? key : UNDECLARED_ARG,
    type: jsonTypeOf(value),
    bytes: byteSize(value),
  }));
  return { argShape, argsTotalBytes };
}

/** One `tool_use` block's facts. `args` is handed to `shapeOfArgs` and nowhere else. `id` is
 *  the provider's own call id and the ONE honest way to pair a call with its OUTCOME:
 *  `audit_log.call_id` records exactly this string (`agent/tools/util.ts` binds it on every
 *  row). Pairing by POSITION would attribute one tool's refusal to a different tool. */
export interface TailToolCall { name: string; args: unknown; id: string | null }

/** The two live content forms, and nothing else. An unparseable row contributes nothing. */
function blocksOf(content: unknown): readonly unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** EVERY TOOL CALL IN THE TAIL, OLDEST FIRST. Assistant rows only — a `tool_use` block is
 *  something the MODEL emitted, and reading one off a user or tool-result row would be
 *  reading a shape from a place the platform never authored it. */
export function toolCallsFromTail(
  rows: readonly { role: string; content: unknown }[],
): TailToolCall[] {
  const out: TailToolCall[] = [];
  for (const row of rows) {
    if (row.role !== 'assistant') continue;
    for (const block of blocksOf(row.content)) {
      if (block === null || typeof block !== 'object') continue;
      const b = block as { type?: unknown; name?: unknown; input?: unknown; id?: unknown };
      if (b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      out.push({ name: b.name, args: b.input, id: typeof b.id === 'string' ? b.id : null });
    }
  }
  return out;
}
