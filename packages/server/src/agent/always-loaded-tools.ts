// Validates a spawn's `always_loaded_tools`: this array lands AHEAD of the prompt cache
// breakpoint, REPLACES the role default, and builds the API head, so it is capped and checked here.

import { PRIMARY_AGENT_ALWAYS_LOADED } from '../tools/tool-docs.js';
import { resolveToolAlias } from '../tools/aliases.js';

// A registry parameter, not an import: importing it drags the tool graph into spawner's imports.
export interface KnownTools { has(name: string): boolean }

// The cap, DERIVED from the primary's always-loaded size: a literal would let the two drift.
// A function, not a const: a const at module init breaks every suite that partially mocks tool-docs.
export function alwaysLoadedMax(): number {
  return PRIMARY_AGENT_ALWAYS_LOADED.length;
}

export type AlwaysLoadedVerdict =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

// The same alias door load_tool_docs uses; a tombstone resolves to itself, not to nothing.
function canonical(name: string): string {
  const resolved = resolveToolAlias(name, {});
  return resolved.tombstone ? name : resolved.name;
}

// undefined/null = no declaration: ok with an empty list, so the role default applies.
export function validateAlwaysLoadedTools(names: unknown, known?: KnownTools): AlwaysLoadedVerdict {
  if (names === undefined || names === null) return { ok: true, names: [] };

  if (!Array.isArray(names)) {
    return {
      ok: false,
      error: `always_loaded_tools must be an array of tool names; received ${typeof names}`
        + `${typeof names === 'string' ? ` (${JSON.stringify(names)})` : ''}. `
        + 'Pass `["tool_a", "tool_b"]`, or omit the field to take this agent\'s role default.',
    };
  }

  for (let i = 0; i < names.length; i++) {
    const raw = names[i];
    if (typeof raw !== 'string' || raw.trim() === '') {
      return {
        ok: false,
        error: `always_loaded_tools[${i}] is not a tool name (${JSON.stringify(raw)}). `
          + 'Every entry must be a non-empty tool name string.',
      };
    }
  }

  const canonicalNames: string[] = [];
  for (const raw of names as string[]) {
    const name = canonical(raw.trim());
    if (!canonicalNames.includes(name)) canonicalNames.push(name);
  }

  if (canonicalNames.length > alwaysLoadedMax()) {
    return { ok: false, error: alwaysLoadedCapRefusal(canonicalNames.length) };
  }

  // NAMES checked against the caller's registry, never the doc files: a real tool with a missing
  // manual is not unknown. No registry in scope skips this check rather than guessing.
  // Grants are not checked here: a name the agent may not use is narrowed later by `byName`.
  const unknown = known ? canonicalNames.filter((n) => !known.has(n)) : [];
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `always_loaded_tools names tools that do not exist: ${unknown.join(', ')}. `
        + 'Check the tool index.',
    };
  }

  return { ok: true, names: canonicalNames };
}

export function alwaysLoadedCapRefusal(received: number): string {
  return `always_loaded_tools has ${received} entries; the cap is ${alwaysLoadedMax()} `
    + '(the primary agent\'s own always-loaded size). Pass the tools this agent needs one call '
    + 'away and let it load_tool_docs for the rest.';
}
