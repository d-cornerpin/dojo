// Emits only the shape of a call's arguments (key, JSON type, byte size), never a value (user content).
// An undeclared key becomes `<undeclared-arg>` (the model minted it); the telemetry builder re-checks it.
// The extractor fails closed: an unrecognised content shape contributes nothing.

import { registryToolDefinitions } from '../agent/tools/registry.js';

/** The sentinel a key the tool never declared becomes. Never the key itself. */
export const UNDECLARED_ARG = '<undeclared-arg>';

export interface ArgShapeEntry { key: string; type: string; bytes: number }

/** JSON type name; non-JSON types pass through as themselves so the coercer renders UNRECOGNISED. */
function jsonTypeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v === 'object' ? 'object' : typeof v;
}

function byteSize(v: unknown): number {
  try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; }
}

/** Shape of one call's args; `toolName` is resolved against the live registry, not a frozen copy. */
export function shapeOfArgs(toolName: string, args: unknown): {
  argShape: ArgShapeEntry[]; argsTotalBytes: number;
} {
  const argsTotalBytes = byteSize(args);
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return { argShape: [], argsTotalBytes };
  }
  const def = registryToolDefinitions().find(d => d.name === toolName);
  const declared = new Set(def ? Object.keys(def.input_schema.properties) : []);
  const argShape = Object.entries(args as Record<string, unknown>).map(([key, value]) => ({
    key: declared.has(key) ? key : UNDECLARED_ARG,
    type: jsonTypeOf(value),
    bytes: byteSize(value),
  }));
  return { argShape, argsTotalBytes };
}

/** `id` is the provider call id that pairs a call with its outcome (`audit_log.call_id`), never position. */
export interface TailToolCall { name: string; args: unknown; id: string | null }

/** The two live content forms; an unparseable row contributes nothing. */
function blocksOf(content: unknown): readonly unknown[] {
  if (Array.isArray(content)) return content;
  if (typeof content !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

/** Every tool call in the tail, oldest first. Assistant rows only: `tool_use` blocks are model-emitted. */
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
