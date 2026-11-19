// THE TOOL REGISTRY: one map keyed by tool name holding what the platform KNOWS about a tool, its
// definition, category, effects and secret fields; coverage is reported from here, never from usage.

import { getAllToolDefinitions } from './definitions.js';
import { TOOL_CATEGORIES } from '../../tools/categories.js';
import type { ToolDefinition, ToolEffect } from './types.js';
import type { ToolHandler } from './handler.js';
import { handlerFor } from './handlers.js';

/** Every field this definition declares as carrying credential material. */
export function declaredSecretFields(def: Pick<ToolDefinition, 'fields'>): string[] {
  if (!def.fields) return [];
  return Object.entries(def.fields)
    .filter(([, decl]) => decl?.secret === true)
    .map(([path]) => path);
}

export interface ToolRegistryEntry {
  /** The definition itself, by reference; never a copy, so this entry cannot drift. */
  def: ToolDefinition;
  /** Prompt-index category; `null` is a real state: the `user_*` twins are generated, not listed. */
  category: string | null;
  effects: readonly ToolEffect[];
  secretFields: readonly string[];
  /** The relocated body, or `null` while the switch owns it or for a work verb keyed per operation;
   * handlers.ts is the dispatch-key authority; handler-table.test.ts keeps table and switch disjoint. */
  handler: ToolHandler | null;
}

let cache: ReadonlyMap<string, ToolRegistryEntry> | null = null;

function categoryIndex(): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const cat of TOOL_CATEGORIES) {
    for (const name of cat.tools) if (!index.has(name)) index.set(name, cat.label);
  }
  return index;
}

/** Lazy + memoized, deliberately NOT built at module load: definitions.ts may still be initializing. */
export function getToolRegistry(): ReadonlyMap<string, ToolRegistryEntry> {
  if (cache) return cache;
  const byCategory = categoryIndex();
  const map = new Map<string, ToolRegistryEntry>();
  for (const def of getAllToolDefinitions()) {
    // First wins; two definitions under one name means ambiguous routing. The test asserts none.
    if (map.has(def.name)) continue;
    map.set(def.name, {
      def,
      category: byCategory.get(def.name) ?? byCategory.get(def.name.replace(/^user_/, '')) ?? null,
      effects: def.effects,
      secretFields: declaredSecretFields(def),
      handler: handlerFor(def.name) ?? null,
    });
  }
  cache = map;
  return cache;
}

export function resetToolRegistry(): void {
  cache = null;
}

export function registryToolDefinitions(): ToolDefinition[] {
  return [...getToolRegistry().values()].map((e) => e.def);
}

export function effectsFor(name: string): readonly ToolEffect[] | undefined {
  return getToolRegistry().get(name)?.effects;
}

/** Derived from declarations, so a new secret field is covered the moment it is declared. */
export function declaredSecretFieldsByTool(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [name, entry] of getToolRegistry()) {
    if (entry.secretFields.length > 0) out.set(name, entry.secretFields);
  }
  return out;
}
