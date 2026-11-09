// ════════════════════════════════════════════════════════════════════════════════════════
// PHASE-3 T3 — S1 (the tools array is a declared prefix lane), S3 (assembly is PURE), and
// the structural guard RULING P3-R1 asks for: a registered message entry with no injection
// site must be IMPOSSIBLE, not merely noticed by a golden.
//
// Every clause fails at T3's base commit `8f36cdb`:
//   • `partitionToolsForApiCall` does not exist; `filterToolsForApiCall` returned
//     `allPermittedTools.filter(...)` in REGISTRY order, so a session-loaded tool could land
//     ahead of an always-loaded one and the cache breakpoint (`model.ts:2375`,
//     `i === arr.length - 1`) moved with it — measured cost, §T0-E: every mid-session
//     `load_tool_docs` re-billed the ~24.7K-token cached prefix, ~13× the whole prefix
//     growth the owner accepted on 2026-07-30.
//   • `memory/assembler.ts` ran `markToolsLoaded` and two `UPDATE agents SET config`
//     statements from its own READ path (`:1262-1281`, `:1468`, `:1497` pre-repin).
//   • two registry entries were registered and injected by nobody (`msg.peer-status`,
//     `msg.tracker-notif` — T1's golden found them by looking, which is not a gate).
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import {
  partitionToolsForApiCall,
  filterToolsForApiCall,
  markToolsLoaded,
  clearSessionLoadedTools,
  resetRehydrationForTests,
  DEFAULT_ALWAYS_LOADED_TOOLS,
} from '../../tools/tool-docs.js';
import type { ToolDefinition } from '../../agent/tools/types.js';
import '../../prompt/registry/entries.js';

const AGENT = 'p3t3-prefix-lane';

function tool(name: string): ToolDefinition {
  return { name, description: `doc for ${name}`, input_schema: { type: 'object', properties: {} } } as ToolDefinition;
}

// Deliberately NOT in always-loaded order — this is the registry order the old filter used.
const PERMITTED = [
  'zzz_session_only',
  'convert_time',
  'aaa_session_only',
  'load_tool_docs',
  'channel_inspect',
  'complete_task',
  'get_current_time',
].map(tool);

const ALWAYS = DEFAULT_ALWAYS_LOADED_TOOLS;

describe('S1 — the tools array is a declared prefix lane', () => {
  beforeEach(() => {
    clearSessionLoadedTools(AGENT);
    resetRehydrationForTests(AGENT);
  });

  it('emits the always-loaded head FIRST, in the order the set DECLARES it', () => {
    const p = partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS);
    expect(p.alwaysLoaded.map((t) => t.name)).toEqual([
      'load_tool_docs', 'complete_task', 'get_current_time', 'convert_time', 'channel_inspect',
    ]);
    // Registry order would have put convert_time second and load_tool_docs fourth.
    expect(p.tools.slice(0, 5).map((t) => t.name)).toEqual(p.alwaysLoaded.map((t) => t.name));
  });

  it('puts the cache breakpoint on the LAST always-loaded tool', () => {
    const p = partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS);
    expect(p.cacheBreakpointIndex).toBe(p.alwaysLoaded.length - 1);
    expect(p.tools[p.cacheBreakpointIndex].name).toBe('channel_inspect');
  });

  it('THE MEASUREMENT S1 EXISTS FOR: loading a tool mid-session leaves the prefix BYTE-IDENTICAL', () => {
    const before = partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS);
    const prefixBefore = JSON.stringify(before.tools.slice(0, before.cacheBreakpointIndex + 1));

    markToolsLoaded(AGENT, ['zzz_session_only']);
    const after = partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS);
    const prefixAfter = JSON.stringify(after.tools.slice(0, after.cacheBreakpointIndex + 1));

    expect(prefixAfter).toBe(prefixBefore);
    expect(after.cacheBreakpointIndex).toBe(before.cacheBreakpointIndex);
    // …and the new tool really did arrive, BEHIND the breakpoint.
    expect(after.tools.map((t) => t.name)).toContain('zzz_session_only');
    expect(after.tools.findIndex((t) => t.name === 'zzz_session_only'))
      .toBeGreaterThan(after.cacheBreakpointIndex);

    // THE OLD BEHAVIOUR, stated for the record so the change is visible and not asserted.
    // `filterToolsForApiCall` used to be `allPermittedTools.filter(...)` — REGISTRY order —
    // and this fixture shows the worst case §T0-E named: `zzz_session_only` sits FIRST in
    // registry order, so loading it mid-session inserted a tool at INDEX 0. The cached
    // prefix was then invalid from its first byte, wherever the breakpoint sat.
    const legacyOrder = (extra?: string) => PERMITTED.filter(
      (t) => ALWAYS.includes(t.name) || t.name === 'load_tool_docs' || t.name === extra,
    );
    const legacyBefore = legacyOrder();
    const legacyAfter = legacyOrder('zzz_session_only');
    expect(JSON.stringify(legacyAfter)).not.toBe(JSON.stringify(legacyBefore));
    expect(legacyAfter[0].name).toBe('zzz_session_only');
    expect(legacyBefore[0].name).not.toBe('zzz_session_only');
    // Under S1 the same tool lands last, behind the breakpoint. That is the whole fix.
    expect(after.tools[0].name).toBe(before.tools[0].name);
  });

  it('is deterministic: two partitions of the same state are byte-identical', () => {
    markToolsLoaded(AGENT, ['aaa_session_only', 'zzz_session_only']);
    const a = JSON.stringify(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS).tools);
    const b = JSON.stringify(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS).tools);
    expect(a).toBe(b);

    // ── T72b claim 3: THE SECOND HALF OF THIS CLAUSE WAS OVERTURNED, ON PURPOSE ────────
    // It used to read: "the ORDER of the load does not change the array — the tail follows
    // registry order, not the order the session happened to fetch them in", and it asserted
    // that loading [zzz, aaa] produced the same bytes as loading [aaa, zzz].
    //
    // THE REQUIREMENT S1 RECORDED IS PRESERVED and is asserted above: determinism — the
    // same session state renders byte-identical tools, never a function of Set iteration
    // over a set the session mutated. That is what S1 needed and it still holds.
    //
    // WHAT CHANGED: registry order made the tail deterministic but NOT append-only. A
    // second load whose tool sits earlier in the registry INSERTED ahead of the first and
    // moved it, re-billing everything behind it on a strictly-prefix server. Load order is
    // equally deterministic (a Set preserves insertion order) and is additionally
    // append-only, so it is strictly stronger. The property now lives in
    // `the-tools-lane-is-append-only.test.ts`; here we pin the consequence — the tail is
    // the load sequence, so a DIFFERENT load sequence is allowed to differ.
    clearSessionLoadedTools(AGENT);
    markToolsLoaded(AGENT, ['zzz_session_only', 'aaa_session_only']);
    const reversed = partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS);
    expect(reversed.sessionExtras.map((t) => t.name)).toEqual(['zzz_session_only', 'aaa_session_only']);
    // Membership is identical either way; only the tail's order follows the session.
    expect(reversed.tools.map((t) => t.name).sort())
      .toEqual((JSON.parse(a) as Array<{ name: string }>).map((t) => t.name).sort());
    // And the CACHED HEAD is byte-identical regardless of load sequence — the thing that
    // actually has to hold still.
    expect(JSON.stringify(reversed.tools.slice(0, reversed.cacheBreakpointIndex + 1)))
      .toBe(JSON.stringify((JSON.parse(a) as unknown[]).slice(0, reversed.cacheBreakpointIndex + 1)));
  });

  it('a tool that is BOTH always-loaded and session-loaded stays in the head, once', () => {
    // `load_tool_docs` marks everything it hands back, including preloaded tools.
    markToolsLoaded(AGENT, ['convert_time']);
    const p = partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS);
    expect(p.tools.filter((t) => t.name === 'convert_time')).toHaveLength(1);
    expect(p.alwaysLoaded.map((t) => t.name)).toContain('convert_time');
    expect(p.sessionExtras.map((t) => t.name)).not.toContain('convert_time');
  });

  it('MEMBERSHIP is unchanged by S1 — only the order moved (no tool added, none removed)', () => {
    markToolsLoaded(AGENT, ['zzz_session_only']);
    const now = filterToolsForApiCall(AGENT, PERMITTED, ALWAYS).map((t) => t.name).sort();
    const alwaysSet = new Set([...ALWAYS, 'load_tool_docs']);
    const legacy = PERMITTED
      .filter((t) => alwaysSet.has(t.name) || t.name === 'zzz_session_only')
      .map((t) => t.name).sort();
    expect(now).toEqual(legacy);
  });

  it('falls back to the end of the array when there is no always-loaded head to cache', () => {
    const p = partitionToolsForApiCall(AGENT, [tool('only_a_session_tool')], []);
    expect(p.alwaysLoaded).toHaveLength(0);
    expect(p.cacheBreakpointIndex).toBe(-1);
  });
});
