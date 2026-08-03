// ════════════════════════════════════════════════════════════════════════════
// THE TOOL REGISTRY (PHASE-5 T1 Step 2)
//
// One map, keyed by tool name, holding what the platform KNOWS about a tool
// rather than what a switch statement happens to do with it: its definition,
// its category, its declared effects, and its declared secret fields. It is the
// surface T2's dispatcher authorizes against and the surface T7's exit gate
// reports effect coverage FROM — never from historical usage (research 19 §3.3).
//
// ── THE `handler` FIELD, ADDED AT T4 WITH SOMETHING REAL IN IT ──
// T1 shipped this map WITHOUT `handler` and said why: at that HEAD every
// handler WAS the 267-case switch inside `executeTool`, so the field would have
// been a placeholder wearing T4's name. T4 moves handler bodies into
// `agent/tools/cat/*.ts` and the field now points at them.
//
// It is `null` for two honest reasons, and they are different: a tool whose
// category has not moved out of the switch yet, and a WORK VERB, whose handlers
// are keyed per OPERATION (`work_update:status`, …) and therefore cannot be
// reached by tool name at all. `agent/tools/handlers.ts` is the dispatch-key
// authority; this field is the by-name view of it, so nothing has to guess
// which surface owns a tool.
//
// ── THE EMISSION ORDER IS A TEST, NOT A COMMENT (OR7 / roadmap #10) ──
// The cache-prefix rider names the hazard precisely: a Map filled across
// dynamically-imported modules iterates in insertion order, a nondeterministic
// tools array invalidates Anthropic's cache breakpoint (which sits on the last
// always-loaded tool) and makes the prefix golden fail intermittently. So this
// module declares its order EXPLICITLY — `TOOL_FAMILY_ORDER` below — and
// `registry-order.test.ts` asserts three things: the emission is deterministic
// across builds, it equals the declared family order computed independently,
// and it is BYTE-IDENTICAL to what `getAllToolDefinitions()` emits today. That
// last clause is the one that protects the golden: it means the registry
// cannot reorder the wire, at T1 or at any later cutover, without failing.
// ════════════════════════════════════════════════════════════════════════════

import { getAllToolDefinitions } from './definitions.js';
import { TOOL_CATEGORIES } from '../../tools/categories.js';
import { declaredSecretFields } from './effect-conformance.js';
import type { ToolDefinition, ToolEffect } from './types.js';
import type { ToolHandler } from './handler.js';
import { handlerFor } from './handlers.js';

/**
 * WHERE THE ORDER COMES FROM, stated once so there is exactly one authority.
 *
 * `getAllToolDefinitions()` (agent/tools.ts) is a hand-written concatenation of
 * fifteen named family arrays in source order — an EXPLICIT, DECLARED order,
 * not a traversal of whatever a Map happened to be filled with. The registry
 * preserves it rather than inventing a second ordering authority, because two
 * lists that both claim to say "the order" is the drift this overhaul exists to
 * delete. What the registry adds is the ENFORCEMENT the rider asks for: the
 * order is deterministic, duplicate-free and byte-identical to that source, held
 * by `registry-order.test.ts` rather than by this paragraph.
 */
export const TOOL_EMISSION_ORDER_SOURCE = 'agent/tools.ts getAllToolDefinitions()';

export interface ToolRegistryEntry {
  /** The definition itself, by reference — never a copy, so this cannot drift. */
  def: ToolDefinition;
  /**
   * The prompt-index category this tool is listed under (`tools/categories.ts`,
   * the plain-data grouping the doc generator and the V5 visibility test both
   * trust). `null` for a tool no category names — which is a real state and not
   * an error: the `user_*` twins are generated at module load and categories
   * lists only base tools.
   */
  category: string | null;
  /** What this tool does to the world. The declaration, by reference. */
  effects: readonly ToolEffect[];
  /** Fields of this tool's own schema that carry credential material. */
  secretFields: readonly string[];
  /**
   * The relocated body that serves this tool, or `null` while the switch in
   * `agent/tools.ts` still owns it (or when the tool is a work verb dispatched
   * per operation — see the header). Never both: `handler-table.test.ts`
   * asserts the handler table and the surviving case labels are disjoint.
   */
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

/**
 * THE REGISTRY. Built lazily on first read and memoized — deliberately not at
 * module load, so this module can be imported from anywhere without caring
 * whether `agent/tools.ts` has finished initializing its own imports.
 */
export function getToolRegistry(): ReadonlyMap<string, ToolRegistryEntry> {
  if (cache) return cache;
  const byCategory = categoryIndex();
  const map = new Map<string, ToolRegistryEntry>();
  for (const def of getAllToolDefinitions()) {
    // First declaration wins and a duplicate is a defect, not a merge: two
    // definitions under one name means the executor's routing is ambiguous.
    // `registry-order.test.ts` asserts the name set has no duplicates, so this
    // branch is a belt on a tested brace rather than a silent de-dup.
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

/** Test seam: forget the memoized registry. */
export function resetToolRegistry(): void {
  cache = null;
}

/**
 * EVERY DEFINITION, IN THE DECLARED EMISSION ORDER. This is the array a
 * provider payload is built from once T4 cuts the executor over; today it is
 * asserted byte-identical to `getAllToolDefinitions()` so the cutover is a
 * no-op on the wire.
 */
export function registryToolDefinitions(): ToolDefinition[] {
  return [...getToolRegistry().values()].map((e) => e.def);
}

/** What this tool does to the world, or `undefined` if the name is not a tool. */
export function effectsFor(name: string): readonly ToolEffect[] | undefined {
  return getToolRegistry().get(name)?.effects;
}

/**
 * THE DECLARED SECRET FIELDS OF EVERY TOOL, derived. This is what makes
 * `credentials/secret-fields.ts` a reader instead of a hand-maintained
 * enumeration that rots in silence (PHASE-4 exit §8 item 2): a new tool with a
 * `fields: { x: { secret: true } }` declaration is covered the moment it is
 * declared, and a tool that loses the declaration loses the redaction visibly.
 */
export function declaredSecretFieldsByTool(): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (const [name, entry] of getToolRegistry()) {
    if (entry.secretFields.length > 0) out.set(name, entry.secretFields);
  }
  return out;
}

/**
 * EFFECT COVERAGE, reported from the registry. T7's exit gate consumes this;
 * it is here rather than in the gate so the number the gate prints and the
 * number the conformance walk asserts come from one place.
 */
export function effectCoverage(): {
  total: number;
  declared: number;
  effectful: number;
  byKind: Record<string, number>;
} {
  const entries = [...getToolRegistry().values()];
  const byKind: Record<string, number> = {};
  for (const e of entries) for (const eff of e.effects) byKind[eff.kind] = (byKind[eff.kind] ?? 0) + 1;
  return {
    total: entries.length,
    declared: entries.filter((e) => Array.isArray(e.effects)).length,
    effectful: entries.filter((e) => e.effects.length > 0).length,
    byKind,
  };
}
