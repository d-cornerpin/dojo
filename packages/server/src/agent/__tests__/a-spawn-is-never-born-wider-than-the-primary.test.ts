// ════════════════════════════════════════════════════════════════════════════════════════
// W1 — `spawn_agent.always_loaded_tools` IS CAPPED, NAME-CHECKED, AND NO LONGER SWALLOWS.
// (`.superpowers/sdd/BACKLOG-CAMPAIGN/caps-design.md` §1; the two-phase-loader audit's W1.)
//
// ── WHAT WAS WRONG, AND WHY A TEST FILE IS THE RIGHT PLACE TO SAY IT ────────────────────
// The declaration was a bare cast written straight to the database. Three consequences, and
// the second one is the one that cost silence rather than bytes:
//
//   1. UNBOUNDED. The stored array REPLACES the role default (`getAgentAlwaysLoadedTools`
//      returns it outright, unioning only the D13 A2A floor), and it is the one widening
//      path that lands AHEAD of the cache breakpoint — so a wide declaration is wide on
//      every call, forever, in the part of the payload the prefix cache is built on.
//   2. A TYPO WAS INDISTINGUISHABLE FROM SUCCESS. An unknown name was written, read back,
//      and dropped at `partitionToolsForApiCall`'s `byName` filter — the single membership
//      decider. The parent got "Agent spawned successfully"; the child never had the tool.
//   3. THE WRITE WAS SWALLOWED by a `catch {}` whose stated reason ("column may not exist on
//      very old databases") is discharged by migration 022 — so it could only ever hide a
//      real fault behind a successful-looking spawn.
//
// ── THE MUTATION PROOF, BOTH DIRECTIONS ─────────────────────────────────────────────────
// Every clause below is written so that REMOVING the guard turns it RED (the cap clause
// fails at MAX+1, the name clause fails on an invented name, the shape clause fails on the
// scalar). The other half matters just as much and is the reason for §5: the live corpus
// measured ZERO agents with a non-NULL `always_loaded_tools` and ONE `spawn_agent` call in
// the entire message history, so nothing that has ever happened on this box is refused. §5
// pins that: a corpus-shaped declaration still lands in the database byte-for-byte as it
// did before the guard existed.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import {
  validateAlwaysLoadedTools, alwaysLoadedMax, alwaysLoadedCapRefusal,
} from '../always-loaded-tools.js';
import { PRIMARY_AGENT_ALWAYS_LOADED, SUB_AGENT_ALWAYS_LOADED } from '../../tools/tool-docs.js';
import { toolDefinitionsByName } from '../tools/definitions.js';

/** The registry the handler hands in. The real one, so "exists" means what it means at runtime. */
const KNOWN = toolDefinitionsByName();

/** A declaration of exactly `n` real tool names, drawn from the registry in its own order. */
function realNames(n: number): string[] {
  const out: string[] = [];
  for (const name of KNOWN.keys()) {
    if (out.length >= n) break;
    out.push(name);
  }
  if (out.length < n) throw new Error(`fixture needs ${n} registry names, found ${out.length}`);
  return out;
}

describe('§1 THE CAP IS THE PRIMARY\'S OWN SIZE, DERIVED', () => {
  it('is exactly the primary agent\'s always-loaded length — not a literal that can drift from it', () => {
    // The number's whole argument is that it is the ceiling the platform already set for
    // itself. A literal would let a review that shrinks the primary leave the cap behind.
    expect(alwaysLoadedMax()).toBe(PRIMARY_AGENT_ALWAYS_LOADED.length);
    // And the ceiling is genuinely above every OTHER role's set, so no legitimate
    // specialist spawn is refused by it (the design rejected the sub-agent's 11 for
    // exactly this reason).
    expect(alwaysLoadedMax()).toBeGreaterThan(SUB_AGENT_ALWAYS_LOADED.length);
  });

  it('accepts a declaration at exactly the cap', () => {
    const at = realNames(alwaysLoadedMax());
    const v = validateAlwaysLoadedTools(at, KNOWN);
    expect(v.ok, v.ok ? '' : v.error).toBe(true);
    if (v.ok) expect(v.names).toHaveLength(alwaysLoadedMax());
  });

  it('refuses one past the cap, and the refusal names the number, the ceiling and the remedy', () => {
    const over = realNames(alwaysLoadedMax() + 1);
    const v = validateAlwaysLoadedTools(over, KNOWN);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    // The sentence a model has to act on: how many it sent, what the bound is, what to do
    // instead. Interpolated from the derived constant, never hardcoded.
    expect(v.error).toContain(`has ${alwaysLoadedMax() + 1} entries`);
    expect(v.error).toContain(`the cap is ${alwaysLoadedMax()}`);
    expect(v.error).toContain('load_tool_docs');
    expect(v.error).toBe(alwaysLoadedCapRefusal(alwaysLoadedMax() + 1));
  });

  it('counts the DE-DUPLICATED array against the cap, so the same tool twice is one entry', () => {
    const at = realNames(alwaysLoadedMax());
    const withDupes = [...at, at[0], at[1]];
    const v = validateAlwaysLoadedTools(withDupes, KNOWN);
    expect(v.ok, 'duplicates must not spend cap room they do not occupy in the stored array').toBe(true);
    if (v.ok) expect(v.names).toEqual(at);
  });
});

describe('§2 THE SHAPE — the clause that would have caught the `\'none\'` corruption', () => {
  it('refuses a scalar string, naming the type it received rather than string-spreading it', () => {
    // The sibling defect on the backlog: a create route spread the scalar `'none'` into
    // `["n","o","n","e"]` and stored it. A bare cast cannot see that; this clause can.
    const v = validateAlwaysLoadedTools('none', KNOWN);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error).toContain('must be an array');
      expect(v.error).toContain('string');
      expect(v.error).toContain('"none"');
    }
  });

  it.each([
    ['a number', 5],
    ['an object', { tools: ['exec'] }],
    ['a boolean', true],
  ])('refuses %s', (_label, value) => {
    expect(validateAlwaysLoadedTools(value, KNOWN).ok).toBe(false);
  });

  it('treats an absent declaration as the ordinary case, not an error — the role default applies', () => {
    for (const absent of [undefined, null]) {
      const v = validateAlwaysLoadedTools(absent, KNOWN);
      expect(v.ok).toBe(true);
      if (v.ok) expect(v.names).toEqual([]);
    }
  });

  it('refuses a non-string or blank element BY INDEX, so a 12-name array need not be bisected', () => {
    const v = validateAlwaysLoadedTools(['exec', 42, 'file_read'], KNOWN);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain('always_loaded_tools[1]');
    const blank = validateAlwaysLoadedTools(['exec', '   '], KNOWN);
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.error).toContain('always_loaded_tools[1]');
  });
});

describe('§3 A TYPO IS NO LONGER INDISTINGUISHABLE FROM SUCCESS', () => {
  it('refuses unknown names AND LISTS THEM — the whole point of the clause', () => {
    const v = validateAlwaysLoadedTools(['exec', 'not_a_real_tool', 'also_invented'], KNOWN);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      expect(v.error).toContain('do not exist');
      expect(v.error).toContain('not_a_real_tool');
      expect(v.error).toContain('also_invented');
      // The good name is not blamed, and the array is refused WHOLE rather than pruned:
      // a half-honoured declaration is the shape that produced the `'none'` corruption.
      expect(v.error).not.toContain('exec,');
    }
  });

  it('refuses the whole array rather than silently pruning it', () => {
    const v = validateAlwaysLoadedTools(['exec', 'not_a_real_tool'], KNOWN);
    expect(v.ok).toBe(false);
    expect('names' in v).toBe(false);
  });

  it('checks names against the REGISTRY, never against the doc files (W2 §2.5\'s false negative, one field over)', () => {
    // A registry name whose generated manual may or may not exist on this install is still
    // a real tool. The clause resolves against the definitions map the validation boundary
    // itself uses, so a missing `.md` can never read as "this tool does not exist".
    const anyRealName = realNames(1)[0];
    expect(validateAlwaysLoadedTools([anyRealName], KNOWN).ok).toBe(true);
  });

  it('skips the name clause when no registry is handed in — the spawner floor\'s documented scope', () => {
    // The floor enforces shape/elements/cap without importing the registry (which would
    // pull the definitions module and the whole v2 subtree into the spawn path — measured:
    // eight suites stopped loading). The handler, which already stands in the dispatcher
    // graph, is where existence is judged.
    expect(validateAlwaysLoadedTools(['not_a_real_tool']).ok).toBe(true);
    // ...but the CAP is still a floor for every caller, registry or no registry.
    expect(validateAlwaysLoadedTools(realNames(alwaysLoadedMax() + 1)).ok).toBe(false);
  });
});

describe('§4 ALIASES RESOLVE BEFORE ANYTHING IS STORED', () => {
  it('canonicalises a renamed name, then de-duplicates against its new spelling', () => {
    // The stored array is what the API head is built from, and the head is built by name.
    // Storing both spellings of one tool would emit the same schema twice; storing the OLD
    // spelling would store a name the membership filter cannot match.
    const v = validateAlwaysLoadedTools(['work_open', 'work_open'], KNOWN);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.names).toEqual(['work_open']);
  });
});

describe('§5 THE UNCHANGED-BEHAVIOUR SIDE — the corpus is never refused', () => {
  // MEASURED before this guard shipped: 0 of 146 agents carried a non-NULL
  // `always_loaded_tools`, 0 assistant rows ever mentioned the argument, and there was
  // exactly 1 `spawn_agent` call in the entire message history. So the corpus admits no
  // declaration this cap could refuse — which is the argument for shipping it now, and the
  // property this section pins: at or under the bound, the validator is a pass-through.
  it.each([
    ['one name', ['exec']],
    ['the corpus-shaped three', ['exec', 'file_read', 'file_write']],
    ['a specialist eleven (the sub-agent set\'s size)', SUB_AGENT_ALWAYS_LOADED.slice(0, 11)],
  ])('%s passes through unchanged, in declaration order', (_label, names) => {
    const v = validateAlwaysLoadedTools(names, KNOWN);
    expect(v.ok, v.ok ? '' : v.error).toBe(true);
    // Byte-identical to what the unvalidated cast would have handed the UPDATE: the same
    // names, in the same order. Canonicalisation is identity for a name that is already
    // canonical, and de-duplication is identity for an array with no duplicates.
    if (v.ok) expect(v.names).toEqual([...names]);
  });

  it('hands the spawner an EMPTY array for an absent declaration, so no UPDATE is issued at all', () => {
    // The pre-guard write was `if (alwaysLoadedTools && alwaysLoadedTools.length > 0)`.
    // `names: []` preserves exactly that: a spawn with no declaration still writes nothing,
    // and the agent still resolves its role default through `getDefaultForAgent`.
    const v = validateAlwaysLoadedTools(undefined, KNOWN);
    expect(v.ok && v.names.length === 0).toBe(true);
  });
});
