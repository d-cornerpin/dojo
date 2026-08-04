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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  partitionToolsForApiCall,
  filterToolsForApiCall,
  markToolsLoaded,
  clearSessionLoadedTools,
  resetRehydrationForTests,
  DEFAULT_ALWAYS_LOADED_TOOLS,
} from '../../tools/tool-docs.js';
import type { ToolDefinition } from '../../agent/tools/types.js';
import { engineText, engineFileContaining, engineFileWithBoth } from '../../agent/v2/__tests__/engine-sources.js';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(SRC, rel), 'utf8');

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
    // And the ORDER of the load does not change the array — the tail follows registry
    // order, not the order the session happened to fetch them in.
    clearSessionLoadedTools(AGENT);
    markToolsLoaded(AGENT, ['zzz_session_only', 'aaa_session_only']);
    expect(JSON.stringify(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS).tools)).toBe(a);
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

  it('the transport puts cache_control at the declared breakpoint, not at the array end', () => {
    // Read rather than execute: `callModel`'s Anthropic branch needs a live provider. The
    // clause that matters is a one-line expression and it is pinned by its own text.
    const model = read('agent/model.ts');
    expect(model).toContain('toolCacheBreakpoint');
    expect(model).toMatch(/i === \(toolCacheBreakpoint >= 0 \? toolCacheBreakpoint : arr\.length - 1\)/);
    expect(model).toContain('partitionToolsForApiCall');
  });
});

describe('S3 — assembly is PURE (reads only)', () => {
  it('memory/assembler.ts contains no write statement and no session mutation', () => {
    const src = read('memory/assembler.ts');
    // Strip comments: the tombstones deliberately NAME the statements that used to be here.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    for (const verb of ['UPDATE ', 'INSERT ', 'DELETE FROM', 'markToolsLoaded']) {
      expect(code.includes(verb), `assembler.ts still contains \`${verb}\``).toBe(false);
    }
  });

  it('the one-shot markers are cleared by the TURN, not the assembly', () => {
    // PHASE-6 GUARD-AUDIT: the clear call sits inside the turn body (the `assemble`
    // tranche) and moves with it. The requirement is "the TURN clears them", not "loop.ts
    // contains this call", so the corpus is the engine — driver plus step packages.
    expect(engineText()).toContain('clearConsumedOneShotFlags(agentId, ctx.consumedOneShotFlags)');
    expect(read('agent/runtime.ts')).toContain('export function clearConsumedOneShotFlags');
    // The assembler REPORTS rather than clears.
    expect(read('memory/assembler.ts')).toContain('consumedOneShotFlags');
  });

  it('the restart rehydration moved to the tools module and runs once per agent', () => {
    const td = read('tools/tool-docs.ts');
    expect(td).toContain('export function rehydrateSessionToolsFromHistory');
    expect(td).toContain('rehydratedAgents');
    // PHASE-6 GUARD-AUDIT: the call site is inside the turn body (`preflight`) and moves.
    expect(engineText()).toContain('rehydrateSessionToolsFromHistory(agentId)');
  });

  it('a session reset stays reset — it does not re-import the history it was told to forget', () => {
    resetRehydrationForTests(AGENT);
    clearSessionLoadedTools(AGENT); // this is what reset_session calls
    // clearSessionLoadedTools marks the agent rehydrated, so a later rehydrate is a no-op.
    const td = read('tools/tool-docs.ts');
    expect(td).toMatch(/clearSessionLoadedTools[\s\S]{0,400}rehydratedAgents\.add\(agentId\)/);
  });
});

describe('RULING P3-R1 — a registered entry with no injection site is impossible', () => {
  it('every registered message entry has a live injection site in the loop', async () => {
    const { getMessageEntries } = await import('../../prompt/registry/registry.js');
    await import('../../prompt/registry/entries.js');
    // PHASE-6 GUARD-AUDIT: the ten `injectRegistryMessage` call sites are spread across the
    // `assemble` and `callLLM` tranches — they move in TWO different cuts. Read against
    // `loop.ts` alone this clause would have reported every migrated entry as an orphan
    // (loud, but a false accusation), and once BOTH tranches had gone it would have
    // reported them all. The corpus is the engine.
    const injected = new Set(
      [...engineText().matchAll(/injectRegistryMessage\('([^']+)'/g)].map((m) => m[1]),
    );
    const registered = getMessageEntries().map((e) => e.id);
    expect(registered.length).toBeGreaterThan(0);
    const orphans = registered.filter((id) => !injected.has(id));
    expect(
      orphans,
      `registered message entries with NO injection site: ${orphans.join(', ')} — either ` +
      'wire the injection or STRIP the entry with a `requirement preserved:` line.',
    ).toEqual([]);
  });

  it('msg.peer-status is injected, and between turn-context and current-time', () => {
    // ⚠ PHASE-6 GUARD-AUDIT 2026-08-04 — THE ORDER TRAP, AND THIS CLAUSE WAS SITTING IN IT.
    //
    // `at()` was `loop.indexOf(...)`, which returns -1 when a site is absent. Only
    // `msg.peer-status` had a `toBeGreaterThan(-1)` guard, so if `msg.turn-context` moved
    // into a step package while `peer-status` stayed, the comparison became `-1 < 4003` —
    // TRUE, and the near-tail order contract silently stopped being checked.
    //
    // Widening to a concatenated corpus would NOT fix it: comparing indices across a join
    // measures the order the FILES were joined in, not the order the engine executes. So
    // all three sites are pinned to ONE engine file first. A tranche that splits them
    // fails LOUDLY here, which is correct — once they are in different modules, position
    // in a file no longer sequences them and the contract needs re-stating, not re-reading.
    const needle = (id: string) => `injectRegistryMessage('${id}'`;
    const home = engineFileWithBoth(needle('msg.turn-context'), needle('msg.current-time'));
    const peer = engineFileContaining(needle('msg.peer-status'));
    expect(peer, 'msg.peer-status has no injection site anywhere in the engine').not.toBeNull();
    expect(
      peer!.rel,
      `the near-tail trio is split: turn-context/current-time are in ${home.rel} but ` +
      `peer-status is in ${peer!.rel}. Their ORDER can no longer be read off file positions.`,
    ).toBe(home.rel);
    const at = (id: string) => home.text.indexOf(needle(id));
    expect(at('msg.peer-status')).toBeGreaterThan(-1);
    // The near-tail order 1850 → 1875 → 1900 is a preserved contract (Global Constraints).
    expect(at('msg.turn-context')).toBeLessThan(at('msg.peer-status'));
    expect(at('msg.peer-status')).toBeLessThan(at('msg.current-time'));
  });

  it('msg.tracker-notif is STRIPPED, not left registered — with its requirement named', () => {
    const entries = read('prompt/registry/entries.ts');
    expect(entries).not.toContain("id: 'msg.tracker-notif'");
    expect(entries).toContain('requirement preserved:');
    expect(entries).toContain('injectTaskAssignmentNotification');
    // The slot number is retired, not reused.
    expect(read('prompt/registry/types.ts')).not.toMatch(/^\s*TrackerNotif = /m);
  });
});
