// ════════════════════════════════════════════════════════════════════════════
// THE ALWAYS-LOADED DECLARATION, VALIDATED (W1 — `.superpowers/sdd/
// BACKLOG-CAMPAIGN/caps-design.md` §1; finding from the two-phase-loader audit).
//
// `spawn_agent.always_loaded_tools` is the one tool-array widening path that lands
// AHEAD of the cache breakpoint (the breakpoint sits on the last always-loaded
// tool — `tools/tool-docs.ts`'s `cacheBreakpointIndex`), and it arrived with no
// cap, no name check, and a swallowed write. Three defects, all closed here:
//
//  1. NO CAP. A parent could declare an arbitrarily wide array and it REPLACES the
//     role default rather than extending it (`getAgentAlwaysLoadedTools` returns
//     the stored array outright, unioning only the D13 A2A floor). The number is
//     therefore not a taste: a spawned child must not be born with a wider
//     always-loaded head than the most privileged, most-audited agent on the box.
//     `ALWAYS_LOADED_MAX` is DERIVED from that agent's own array, never a literal,
//     so a review that shrinks the primary shrinks the cap with it.
//
//  2. AN UNKNOWN NAME WAS WRITTEN, READ BACK, AND SILENTLY DROPPED. Membership is
//     settled in ONE place — `partitionToolsForApiCall`'s `byName` filter — so a
//     typo survived the write, survived the read, and vanished at the array. The
//     parent got a successful spawn and the child never had the tool. A typo was
//     indistinguishable from success. Now it is refused, WITH THE NAMES LISTED.
//
//  2b. THE WRITE WAS SWALLOWED. The UPDATE sat in a bare `try { } catch { }` whose
//     stated reason was "column may not exist on very old databases" — and the
//     column ships in migration 022, so the catch could only ever hide a real
//     fault while presenting the spawn as successful. It is gone: a declaration
//     that cannot be written is a failed spawn, not a quiet one.
//
//  3. THE ARRAY WAS A BARE CAST. `args.always_loaded_tools as string[]` accepted
//     whatever arrived. The sibling defect on the same shape is on the backlog —
//     a scalar `'none'` string-spread into `["n","o","n","e"]` by a create route —
//     which is why clause 1 refuses a non-array by naming the type it received,
//     and why this validator is EXPORTED rather than inlined at one call site.
//
// ── WHY IT REFUSES THE WHOLE ARRAY RATHER THAN PRUNING IT ──
// A half-honoured declaration is the shape that produced the `'none'` corruption:
// the caller believes it declared one thing and the box stored another. A refusal
// the caller can read and fix is the only outcome that keeps a declaration honest.
//
// ── WHAT IT DELIBERATELY DOES NOT CHECK ──
// GRANTS. A name this agent may not use is legitimately filtered later by `byName`,
// and the D13 `send_to_agent` union stays exactly where it is. Validating grants
// here would refuse a declaration that the platform is designed to narrow quietly,
// and would duplicate a decision that already has one owner.
// ════════════════════════════════════════════════════════════════════════════

import { PRIMARY_AGENT_ALWAYS_LOADED } from '../tools/tool-docs.js';
import { resolveToolAlias } from '../tools/aliases.js';

/**
 * Just enough of a registry to answer "is this a tool?" — `toolDefinitionsByName()`
 * satisfies it, and so does a bare `Set`.
 *
 * ── WHY IT IS A PARAMETER AND NOT AN IMPORT, MEASURED ──
 * Importing the registry here statically pulls `agent/tools/definitions.ts` (2.9K
 * lines) and, through its concurrency registration, the whole `agent/v2` subtree
 * into `spawner.ts`'s import graph — a module that had never carried the tool
 * registry. That is not a theory: the first cut of this file did it, and EIGHT
 * existing suites stopped loading, because the graph now reached modules their
 * partial `vi.mock`s do not export. Tests made the blast radius visible; the
 * blast radius was the real problem. So the name check is the HANDLER's to run —
 * it stands inside the dispatcher graph, where the registry is already loaded —
 * and the spawner floor enforces shape, elements and the CAP, which need nothing
 * but this module's own two imports.
 */
export interface KnownTools { has(name: string): boolean }

/**
 * The cap, DERIVED from the primary agent's own always-loaded size. Never a
 * literal: the number's whole argument is that it is the ceiling the platform
 * already set for itself, and a copy would let the two drift.
 *
 * A FUNCTION, not a module-level `const`, and the reason is measured rather than
 * stylistic: eight existing suites `vi.mock` `tools/tool-docs.js` PARTIALLY, and a
 * `const` read at module init made `spawner.ts`'s whole import graph fail to load
 * under every one of them ("No PRIMARY_AGENT_ALWAYS_LOADED export is defined on
 * the mock"). Reading it at CALL time also means the number cannot be captured
 * before the list it is derived from is final.
 */
export function alwaysLoadedMax(): number {
  return PRIMARY_AGENT_ALWAYS_LOADED.length;
}

export type AlwaysLoadedVerdict =
  | { ok: true; names: string[] }
  | { ok: false; error: string };

/**
 * The name a declared tool resolves to TODAY — the same alias door
 * `load_tool_docs` applies before it loads anything, and the same one
 * `tools/tool-docs.ts` replays with. A tombstoned name keeps itself so clause 5
 * refuses it by name instead of quietly resolving it to nothing.
 */
function canonical(name: string): string {
  const resolved = resolveToolAlias(name, {});
  return resolved.tombstone ? name : resolved.name;
}

/**
 * Validate a parent's `always_loaded_tools` declaration.
 *
 * `undefined` / `null` is the ORDINARY case — no declaration, so the role default
 * applies — and answers `{ ok: true, names: [] }`. Callers write the column only
 * when `names` is non-empty, which is exactly the behaviour the unvalidated path
 * had.
 */
export function validateAlwaysLoadedTools(names: unknown, known?: KnownTools): AlwaysLoadedVerdict {
  if (names === undefined || names === null) return { ok: true, names: [] };

  // 1. SHAPE. Named by the type it received, because the caller that gets this
  //    wrong is passing a scalar it believed was an array.
  if (!Array.isArray(names)) {
    return {
      ok: false,
      error: `always_loaded_tools must be an array of tool names; received ${typeof names}`
        + `${typeof names === 'string' ? ` (${JSON.stringify(names)})` : ''}. `
        + 'Pass `["tool_a", "tool_b"]`, or omit the field to take this agent\'s role default.',
    };
  }

  // 2. ELEMENTS. The index is named: a caller with a 12-name array and one hole
  //    should not have to bisect it.
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

  // 3. CANONICALISE, THEN DE-DUPLICATE. Two spellings of one tool are one entry
  //    against the cap, and the stored array is what the API head is built from —
  //    a duplicate there would emit the same schema twice.
  const canonicalNames: string[] = [];
  for (const raw of names as string[]) {
    const name = canonical(raw.trim());
    if (!canonicalNames.includes(name)) canonicalNames.push(name);
  }

  // 4. THE CAP.
  if (canonicalNames.length > alwaysLoadedMax()) {
    return { ok: false, error: alwaysLoadedCapRefusal(canonicalNames.length) };
  }

  // 5. EVERY NAME IS A REAL TOOL — against the REGISTRY the caller hands in, never
  //    against the doc files. A real tool whose generated manual is missing must
  //    not read as unknown (the same false negative W2 splits apart in
  //    `executeLoadToolDocs`). A caller with no registry in scope skips this
  //    clause rather than guessing: see `KnownTools` for why that is the seam.
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

/**
 * The cap refusal, in one place so the handler's message and the spawner's throw
 * cannot drift. The number is interpolated from the derived constant.
 */
export function alwaysLoadedCapRefusal(received: number): string {
  return `always_loaded_tools has ${received} entries; the cap is ${alwaysLoadedMax()} `
    + '(the primary agent\'s own always-loaded size). Pass the tools this agent needs one call '
    + 'away and let it load_tool_docs for the rest.';
}
