// ════════════════════════════════════════════════════════════════════════════════════════
// T72b claim 3 — THE TOOLS LANE IS APPEND-ONLY, NOT MERELY DETERMINISTIC.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── THE CLAIM (owner's DS4-server agent) ────────────────────────────────────────────────
// "A ~4,200-token block is INSERTED above the conversation after turn 1, and a block around
//  17-22K in is rewritten irregularly." Prime suspect named: `load_tool_docs` splicing the
//  loaded DOCS into the tools/system region instead of returning them as a tool result.
//
// ── WHAT THE SUSPECT GOT RIGHT, AND WHAT IT GOT WRONG ───────────────────────────────────
// WRONG: the loaded documentation TEXT already rides back as a `tool_result` inside the
// conversation, append-only, exactly as the preferred fix describes
// (`tools/tool-docs.ts:472-506` returns a string; the turn persists it as a `role='tool'`
// row; `lane.fresh-tail` replays it). Nothing splices doc text above the conversation.
//
// RIGHT: the tool SCHEMAS do extend the `tools` array, and on the wire the tools array is
// the FIRST thing the model sees — above the system prompt, above everything. That is not
// avoidable: a provider will not accept a call to a tool that was never declared. PHASE-3
// S1 already bounded the cost by ordering the always-loaded head first and putting
// `cache_control` on its last entry, so a mid-session load appends BEHIND the breakpoint
// and the ~18K-token head survives.
//
// ── THE HOLE S1 LEFT, WHICH IS THIS FILE'S SUBJECT ──────────────────────────────────────
// S1's tail is emitted in REGISTRY order, and `prefix-lane-conformance.test.ts` pins that
// on purpose: "the tail follows registry order, not the order the session happened to
// fetch them in." That buys DETERMINISM (same state -> same bytes) and it is genuinely
// what S1 needed. It does NOT buy APPEND-ONLY across two loads, and those are different
// properties:
//
//     load `work_update` on turn 3   -> tail = [work_update]
//     load `calendar_create` on turn 7 -> tail = [calendar_create, work_update]
//
// because `calendar_create` happens to sit earlier in the registry. The second load did not
// append — it INSERTED, and every byte of the first tool's ~13K-char schema moved. A
// provider's prefix cache breaks at the first differing token and never recovers, so on the
// owner's strictly-prefix local server that shifts the rest of the tools array, the entire
// system prompt, and the entire conversation behind it. That is the "block around 17-22K
// rewritten irregularly": the tools array is ~18.2K tokens, and its tail is exactly where
// 17-22K lands.
//
// The message region has obeyed append-only since T67b, enforced by
// `the-prefix-holds-still.test.ts`. This is the same sentence, one region over, for the
// lane that sits ABOVE the messages: BETWEEN TWO CALLS WITH NO DECLARATION CHANGE, THE
// EARLIER TOOLS ARRAY MUST BE A BYTE-EXACT PREFIX OF THE LATER ONE.
//
// Determinism is not lost: a JS `Set` preserves insertion order, so load order is every bit
// as reproducible as registry order — and it is the only order under which a load can never
// move a tool that was already there.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';
import {
  partitionToolsForApiCall,
  markToolsLoaded,
  clearSessionLoadedTools,
  resetRehydrationForTests,
  DEFAULT_ALWAYS_LOADED_TOOLS,
} from '../../tools/tool-docs.js';
import type { ToolDefinition } from '../../agent/tools/types.js';

const AGENT = 't72b-tools-lane';

function tool(name: string): ToolDefinition {
  return { name, description: `doc for ${name}`, input_schema: { type: 'object', properties: {} } } as ToolDefinition;
}

// Registry order. `aaa_*` sorts EARLY in the registry, `zzz_*` sorts LATE — the fixture
// exists so that loading them in the opposite order to the registry's is the natural case,
// which is what a real session does (the model loads what the ask needs, not what the
// registry lists first).
const PERMITTED = [
  'aaa_early_in_registry',
  'mmm_middle_of_registry',
  'load_tool_docs',
  'complete_task',
  'get_current_time',
  'convert_time',
  'channel_inspect',
  'zzz_late_in_registry',
].map(tool);

const ALWAYS = DEFAULT_ALWAYS_LOADED_TOOLS;

const names = (p: { tools: ToolDefinition[] }) => p.tools.map((t) => t.name);
const isPrefixOf = (earlier: string[], later: string[]) =>
  earlier.length <= later.length && earlier.every((n, i) => later[i] === n);

describe('T72b/3 — the tools lane is append-only across successive loads', () => {
  beforeEach(() => {
    clearSessionLoadedTools(AGENT);
    resetRehydrationForTests(AGENT);
  });

  it('THE DEFECT: a later load must not move an earlier one', () => {
    // Turn 3: the model needs the late-registry tool.
    markToolsLoaded(AGENT, ['zzz_late_in_registry']);
    const afterFirstLoad = names(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS));

    // Turn 7: it needs one that happens to sit EARLIER in the registry.
    markToolsLoaded(AGENT, ['aaa_early_in_registry']);
    const afterSecondLoad = names(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS));

    // RED at HEAD: registry order yields [...head, aaa_early, zzz_late] — the second load
    // inserted AHEAD of the first, so the first array is not a prefix of the second and
    // every byte from that point on is re-prefilled.
    expect(isPrefixOf(afterFirstLoad, afterSecondLoad)).toBe(true);
  });

  it('holds across three loads in descending registry order (the worst case)', () => {
    const snapshots: string[][] = [];
    for (const name of ['zzz_late_in_registry', 'mmm_middle_of_registry', 'aaa_early_in_registry']) {
      markToolsLoaded(AGENT, [name]);
      snapshots.push(names(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS)));
    }
    for (let i = 1; i < snapshots.length; i++) {
      expect(isPrefixOf(snapshots[i - 1], snapshots[i])).toBe(true);
    }
    // Each load added exactly one tool, and it landed at the END.
    expect(snapshots[2].slice(-3)).toEqual([
      'zzz_late_in_registry', 'mmm_middle_of_registry', 'aaa_early_in_registry',
    ]);
  });

  it('CONTROL — the cached head and its breakpoint never move (S1 preserved)', () => {
    const before = partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS);
    markToolsLoaded(AGENT, ['aaa_early_in_registry']);
    const after = partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS);

    expect(after.cacheBreakpointIndex).toBe(before.cacheBreakpointIndex);
    expect(JSON.stringify(after.tools.slice(0, after.cacheBreakpointIndex + 1)))
      .toBe(JSON.stringify(before.tools.slice(0, before.cacheBreakpointIndex + 1)));
    // The new tool arrived, and it is behind the breakpoint.
    expect(after.tools.findIndex((t) => t.name === 'aaa_early_in_registry'))
      .toBeGreaterThan(after.cacheBreakpointIndex);
  });

  it('CONTROL — determinism survives: same state, byte-identical array', () => {
    markToolsLoaded(AGENT, ['zzz_late_in_registry', 'aaa_early_in_registry']);
    const a = JSON.stringify(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS).tools);
    const b = JSON.stringify(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS).tools);
    expect(a).toBe(b);
  });

  it('CONTROL — a re-load of an already-loaded tool moves nothing', () => {
    markToolsLoaded(AGENT, ['zzz_late_in_registry', 'aaa_early_in_registry']);
    const before = names(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS));
    // load_tool_docs marks every name it hands back, including ones already loaded.
    markToolsLoaded(AGENT, ['zzz_late_in_registry']);
    const after = names(partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS));
    expect(after).toEqual(before);
  });

  it('CONTROL — an always-loaded tool marked by load_tool_docs stays in the head', () => {
    markToolsLoaded(AGENT, ['complete_task']);
    const p = partitionToolsForApiCall(AGENT, PERMITTED, ALWAYS);
    const idx = p.tools.findIndex((t) => t.name === 'complete_task');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(idx).toBeLessThanOrEqual(p.cacheBreakpointIndex);
    expect(p.sessionExtras.map((t) => t.name)).not.toContain('complete_task');
  });
});
