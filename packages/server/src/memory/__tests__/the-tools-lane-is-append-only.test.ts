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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  partitionToolsForApiCall,
  markToolsLoaded,
  clearSessionLoadedTools,
  resetRehydrationForTests,
  rehydrateSessionToolsFromHistory,
  DEFAULT_ALWAYS_LOADED_TOOLS,
} from '../../tools/tool-docs.js';
import type { ToolDefinition } from '../../agent/tools/types.js';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

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
  // T79: loaded in the same batch as another tool and then never CALLED. A session's
  // loaded set and its called set are different sets, and the restart path used to
  // rebuild the first from the second.
  'nnn_loaded_never_called',
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

// ════════════════════════════════════════════════════════════════════════════════════════
// T79 — ...AND ACROSS THE PROCESS BOUNDARY, WHICH IS WHERE THE PROPERTY WAS STILL LOST.
// ════════════════════════════════════════════════════════════════════════════════════════
//
// ── THE REPORT (owner's DS4-server agent, three driven data points) ──────────────────────
// Three sequential `load_tool_docs` calls in one conversation: load #1 invalidated 931
// tokens (a clean tail append — the block above, working), load #2 invalidated 8,582 with
// the prompts diverging at token 10,837, load #3 invalidated 17,916 diverging at 11,043.
// A near-constant divergence OFFSET with a cost that grows with the conversation: something
// upstream of the whole conversation is being rewritten, and the two offsets are 206 tokens
// apart — the width of ONE small schema.
//
// ── WHAT THE OFFSETS POINT AT, MEASURED ON THE LIVE BOX ─────────────────────────────────
// Replaying that agent's own three batches against its own permitted set: the head is
// 47,108 chars and head+first-loaded-tool is 48,265. At the tokenizer ratio his own two
// numbers imply (~4.35 chars/token) those are 10,834 and 11,041 — his 10,837 and 11,043.
// The divergences sit AT the head|tail boundary and ONE TAIL ENTRY IN. Nothing in the head
// moved and nothing in the system prompt moved (its sha is byte-constant across all three
// calls in the receipts). What moved is the ORDER AND MEMBERSHIP OF THE TAIL.
//
// ── THE MECHANISM ───────────────────────────────────────────────────────────────────────
// `partitionToolsForApiCall` reads the tail off a per-agent `Set` whose insertion order IS
// the load order — in ONE process. The set does not survive a restart, and the restart path
// (`rehydrateSessionToolsFromHistory`) rebuilt it by scanning the last 40 assistant messages
// for `tool_use` NAMES. That is the CALLED set, not the LOADED set, and it is in CALL order:
//
//   • a tool loaded and not yet called DISAPPEARS from the tail → the array SHRINKS and
//     every entry behind the gap moves;
//   • two tools loaded in one batch and called in the other order come back SWAPPED;
//   • loads older than the 40-message window are gone entirely.
//
// Driven on the live box's own history for the reported conversation: the load order is
// `email_search, plaud_list_recordings, plaud_recent_recordings, plaud_get_summary,
// plaud_get_transcript, plaud_account_info, plaud_search_recordings`; after a restart the
// same agent rebuilt it as `email_search, plaud_recent_recordings, plaud_list_recordings,
// plaud_account_info, plaud_search_recordings` — two dropped, two swapped, first divergence
// at char 48,280, i.e. one tail entry in. That is the reported offset, and on a server that
// renders the tools array ahead of the system prompt and the conversation it re-bills
// everything behind it, which is why the cost grows with the conversation and the offset
// does not.
//
// ── THE FIX THIS FILE DEMANDS ───────────────────────────────────────────────────────────
// The load SEQUENCE is already recorded durably, per conversation: every `load_tool_docs`
// call is an assistant `tool_use` block carrying the exact names it asked for, in order.
// Rehydration replays THAT, oldest first, instead of inferring an order from which tools
// happened to get called. A loaded tool keeps its first-load position for the life of the
// conversation, across any number of restarts.
// ════════════════════════════════════════════════════════════════════════════════════════

const RESTART_AGENT = 't79-across-a-restart';

function seedDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, session_started_at TEXT);
    CREATE TABLE messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT, agent_id TEXT, role TEXT, content TEXT, created_at INTEGER
    );
  `);
  db.prepare('INSERT INTO agents (id, session_started_at) VALUES (?, ?)')
    .run(RESTART_AGENT, null);
  return db;
}

let clock = 1_700_000_000_000;
function say(role: string, content: unknown, agentId = RESTART_AGENT): void {
  clock += 1000;
  mockDb.current!.prepare(
    'INSERT INTO messages (id, agent_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(`m${clock}`, agentId, role, typeof content === 'string' ? content : JSON.stringify(content), clock);
}

/** The model asking for docs — the record the load sequence actually lives in. */
const loadCall = (...tools: string[]) => [
  { type: 'tool_use', id: `call_${tools.join('_')}`, name: 'load_tool_docs', input: { tools } },
];
/** The model CALLING a tool afterwards — a different set, in a different order. */
const toolCall = (name: string) => [{ type: 'tool_use', id: `call_${name}_run`, name, input: {} }];

/** The process boundary, made addressable: the in-memory set is gone, the flag with it. */
function restart(agentId: string): void {
  clearSessionLoadedTools(agentId); // drops the set (and marks the agent rehydrated)
  resetRehydrationForTests(agentId); // ...which the restart itself undoes
}

describe('T79 — the load sequence survives the process boundary', () => {
  beforeEach(() => {
    mockDb.current = seedDb();
    clearSessionLoadedTools(RESTART_AGENT);
    resetRehydrationForTests(RESTART_AGENT);
  });
  afterEach(() => {
    mockDb.current?.close();
    mockDb.current = null;
  });

  it('THE DEFECT: three loads, then a restart — the array must still extend, not reshuffle', () => {
    // Three sequential load_tool_docs calls, the owner's reported shape. The middle batch
    // carries a tool that is loaded and never called.
    say('assistant', loadCall('zzz_late_in_registry'));
    markToolsLoaded(RESTART_AGENT, ['zzz_late_in_registry']);
    say('assistant', toolCall('zzz_late_in_registry'));

    say('assistant', loadCall('mmm_middle_of_registry', 'nnn_loaded_never_called'));
    markToolsLoaded(RESTART_AGENT, ['mmm_middle_of_registry', 'nnn_loaded_never_called']);

    say('assistant', loadCall('aaa_early_in_registry'));
    markToolsLoaded(RESTART_AGENT, ['aaa_early_in_registry']);
    // Called in the OPPOSITE order to the order they were loaded in — the natural case, and
    // the one the old rehydration reproduced instead of the load order.
    say('assistant', toolCall('aaa_early_in_registry'));
    say('assistant', toolCall('mmm_middle_of_registry'));

    const before = names(partitionToolsForApiCall(RESTART_AGENT, PERMITTED, ALWAYS));
    expect(before.slice(-4)).toEqual([
      'zzz_late_in_registry', 'mmm_middle_of_registry', 'nnn_loaded_never_called', 'aaa_early_in_registry',
    ]);

    restart(RESTART_AGENT);
    rehydrateSessionToolsFromHistory(RESTART_AGENT);
    const after = names(partitionToolsForApiCall(RESTART_AGENT, PERMITTED, ALWAYS));

    // RED at HEAD: the tail comes back as [aaa, zzz] — call order, called-only — so the
    // earlier array is not a prefix of the later one and every byte from the head boundary
    // on is re-prefilled.
    expect(isPrefixOf(before, after)).toBe(true);
    expect(after).toEqual(before);
  });

  it('a tool that was loaded and never called is not forgotten', () => {
    say('assistant', loadCall('aaa_early_in_registry', 'nnn_loaded_never_called'));
    markToolsLoaded(RESTART_AGENT, ['aaa_early_in_registry', 'nnn_loaded_never_called']);
    say('assistant', toolCall('aaa_early_in_registry'));

    restart(RESTART_AGENT);
    rehydrateSessionToolsFromHistory(RESTART_AGENT);
    const p = partitionToolsForApiCall(RESTART_AGENT, PERMITTED, ALWAYS);
    expect(p.sessionExtras.map((t) => t.name)).toEqual([
      'aaa_early_in_registry', 'nnn_loaded_never_called',
    ]);
  });

  it('the batch keeps the order the model asked for it in, not the order it got used in', () => {
    say('assistant', loadCall('zzz_late_in_registry', 'aaa_early_in_registry'));
    markToolsLoaded(RESTART_AGENT, ['zzz_late_in_registry', 'aaa_early_in_registry']);
    say('assistant', toolCall('aaa_early_in_registry'));
    say('assistant', toolCall('zzz_late_in_registry'));

    restart(RESTART_AGENT);
    rehydrateSessionToolsFromHistory(RESTART_AGENT);
    expect(partitionToolsForApiCall(RESTART_AGENT, PERMITTED, ALWAYS).sessionExtras.map((t) => t.name))
      .toEqual(['zzz_late_in_registry', 'aaa_early_in_registry']);
  });

  it('requirement preserved (#15) — a tool it was USING with no load on record still comes back, at the END', () => {
    // The pre-T79 recovery case: the agent is demonstrably using a tool whose load call is
    // not in this session's record (it predates the fix, or the load was lost with an
    // archived session). It must not have to re-call load_tool_docs for it — and it must
    // arrive BEHIND everything the record does name, so restoring it cannot move anything.
    say('assistant', loadCall('zzz_late_in_registry'));
    say('assistant', toolCall('aaa_early_in_registry'));

    rehydrateSessionToolsFromHistory(RESTART_AGENT);
    expect(partitionToolsForApiCall(RESTART_AGENT, PERMITTED, ALWAYS).sessionExtras.map((t) => t.name))
      .toEqual(['zzz_late_in_registry', 'aaa_early_in_registry']);
  });

  it('CONTROL — a pre-reset load is not re-imported after a restart', () => {
    // `clearSessionLoadedTools` is a DECISION to forget. A restart afterwards must not
    // hand the agent back the session it was told to drop, and the session boundary is
    // what makes that stick across the process boundary too.
    say('assistant', loadCall('zzz_late_in_registry'));
    const boundary = new Date(clock + 1000).toISOString().replace('T', ' ').slice(0, 19);
    mockDb.current!.prepare('UPDATE agents SET session_started_at = ? WHERE id = ?')
      .run(boundary, RESTART_AGENT);
    clock += 2000;
    say('assistant', loadCall('aaa_early_in_registry'));

    restart(RESTART_AGENT);
    rehydrateSessionToolsFromHistory(RESTART_AGENT);
    expect(partitionToolsForApiCall(RESTART_AGENT, PERMITTED, ALWAYS).sessionExtras.map((t) => t.name))
      .toEqual(['aaa_early_in_registry']);
  });

  it('CONTROL — rehydration still runs at most once per agent per process', () => {
    say('assistant', loadCall('zzz_late_in_registry'));
    rehydrateSessionToolsFromHistory(RESTART_AGENT);
    // A second call must be a no-op even if the history grew underneath it.
    say('assistant', loadCall('aaa_early_in_registry'));
    rehydrateSessionToolsFromHistory(RESTART_AGENT);
    expect(partitionToolsForApiCall(RESTART_AGENT, PERMITTED, ALWAYS).sessionExtras.map((t) => t.name))
      .toEqual(['zzz_late_in_registry']);
  });

  it('CONTROL — a re-load after a restart still moves nothing', () => {
    say('assistant', loadCall('zzz_late_in_registry'));
    markToolsLoaded(RESTART_AGENT, ['zzz_late_in_registry']);
    say('assistant', loadCall('mmm_middle_of_registry'));
    markToolsLoaded(RESTART_AGENT, ['mmm_middle_of_registry']);
    const before = names(partitionToolsForApiCall(RESTART_AGENT, PERMITTED, ALWAYS));

    restart(RESTART_AGENT);
    rehydrateSessionToolsFromHistory(RESTART_AGENT);
    // The model re-asks for one it already has, and then asks for a new one.
    markToolsLoaded(RESTART_AGENT, ['zzz_late_in_registry']);
    markToolsLoaded(RESTART_AGENT, ['aaa_early_in_registry']);
    const after = names(partitionToolsForApiCall(RESTART_AGENT, PERMITTED, ALWAYS));

    expect(isPrefixOf(before, after)).toBe(true);
    expect(after.slice(-1)).toEqual(['aaa_early_in_registry']);
  });
});
