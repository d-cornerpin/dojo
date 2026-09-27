// ════════════════════════════════════════════════════════════════════════════════════════
// W2 — `load_tool_docs` IS BOUNDED PER CALL AND PER SESSION, AND A MISSING MANUAL IS NOT A
// MISSING TOOL. (`.superpowers/sdd/BACKLOG-CAMPAIGN/caps-design.md` §2; the loader audit's W2.)
//
// ── THE THREE THINGS UNDER TEST, AND WHY EACH ONE IS A BOUND ────────────────────────────
//   PER CALL 12    The handler bounded ARITY and not SIZE: `length === 0` was refused and
//                  `length === 50` was not. Every loaded name rides in the API tools array
//                  behind the cache breakpoint, so one runaway array is per-call payload for
//                  the rest of the session.
//   SESSION 64     The set only ever GREW. Its single shrink was a whole-session reset, so a
//                  long-lived agent's array was a ratchet with no pawl.
//   MANUAL vs TOOL The existence test was a doc-FILE lookup, so a real tool whose generated
//                  `.md` never landed was reported as "Tools not found" — a lie about the
//                  tool, and one that hid a doc-generation failure behind a naming verdict.
//
// ── THE NUMBERS ARE MEASURED, AND THE MEASUREMENT IS WHAT PINS THE OTHER DIRECTION ──────
// 372 live `load_tool_docs` calls: max array 8, 98.4% at or under 4. 22 agents ever called
// it; the widest REAL agent accumulated 56 distinct names over its entire lifetime, the
// harness bot 74, and a post-restart rehydration was observed at 43. So §1 proves nothing
// that has ever happened is refused (12 > 8), and §2 proves the ceiling sits above every
// genuine working set (64 > 56 > 43). Both halves are the same argument: a guard that
// refuses real traffic is a defect, and a guard that admits a runaway is not a guard.
//
// Mutation-proven in both directions: removing the per-call check turns §1.2 RED, removing
// the ceiling turns §2 RED, and restoring the `readToolDoc`-as-existence-test turns §3 RED.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));

// §5 drives the REAL handler, so the only thing standing in for the platform is the agent's
// accessible-tool surface. `getAllToolDefinitions` stays real: it is static data.
vi.mock('../../agent/tools/surface.js', () => ({ getFilteredTools: vi.fn(() => []) }));

// Which tools have a generated manual on THIS install. The point of §3 is that this is a
// different question from "is this a tool", so the test has to be able to answer them apart.
const manualsPresent = new Set<string>();
vi.mock('../tool-doc-read.js', () => ({
  readToolDoc: (name: string) => (manualsPresent.has(name) ? `# ${name}\n\nthe manual for ${name}` : null),
  getToolsDir: () => '/tmp/nope',
  TOOLS_DIR: '/tmp/nope',
}));

import {
  LOAD_TOOL_DOCS_MAX_PER_CALL, SESSION_TOOL_SET_MAX, evictionNote,
  loadToolDocsOverflowRefusal, resetSessionToolSetsForTests,
} from '../tool-session-set.js';
import {
  executeLoadToolDocs, getSessionLoadedTools, markToolsLoaded, clearSessionLoadedTools,
  rehydrateSessionToolsFromHistory, resetRehydrationForTests,
} from '../tool-docs.js';
import { getFilteredTools } from '../../agent/tools/surface.js';
import { metaHandlers } from '../../agent/tools/cat/meta.js';
import type { ToolCall, ToolDefinition } from '@dojo/shared';

const AGENT = 'w2-bounded-agent';

function freshDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, session_started_at TEXT, always_loaded_tools TEXT, classification TEXT);
    CREATE TABLE config (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE messages (
      rowid_alias INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT, agent_id TEXT, role TEXT, content TEXT, created_at INTEGER, turn_number INTEGER
    );
  `);
  db.prepare('INSERT INTO agents (id, session_started_at) VALUES (?, NULL)').run(AGENT);
  return db;
}

let clock = 1_700_000_000_000;
/** An assistant row carrying `tool_use` blocks — the record the recency read already has. */
function called(turn: number, ...names: string[]): void {
  clock += 1000;
  const blocks = names.map((n, i) => ({ type: 'tool_use', id: `c${clock}_${i}`, name: n, input: {} }));
  mockDb.current!.prepare(
    'INSERT INTO messages (id, agent_id, role, content, created_at, turn_number) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`m${clock}`, AGENT, 'assistant', JSON.stringify(blocks), clock, turn);
}

const names = (prefix: string, n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `${prefix}_${String(i + from).padStart(3, '0')}`);

beforeEach(() => {
  mockDb.current = freshDb();
  manualsPresent.clear();
  resetSessionToolSetsForTests();
  resetRehydrationForTests();
  clock = 1_700_000_000_000;
});

describe('§1 THE PER-CALL CAP', () => {
  it('is 12, and the refusal names the cap, the overflow, and what to do instead', () => {
    expect(LOAD_TOOL_DOCS_MAX_PER_CALL).toBe(12);
    // The sentence verbatim — the model reads this and has to be able to act on it.
    expect(loadToolDocsOverflowRefusal(13)).toBe(
      'Error: load_tool_docs accepts at most 12 tool names per call (received 13). '
      + 'Load the ones you need for THIS step; you can call again for the rest.',
    );
  });

  it('refuses 13 names at the executor floor, and marks NOTHING as loaded', () => {
    const asked = names('tool', 13);
    for (const n of asked) manualsPresent.add(n);
    const out = executeLoadToolDocs(AGENT, asked);
    expect(out).toBe(loadToolDocsOverflowRefusal(13));
    // A refused call must not be a half-load: nothing entered the session set, so the next
    // API call's tools array is byte-identical to the one before it.
    expect(getSessionLoadedTools(AGENT).size).toBe(0);
  });

  it('accepts exactly 12 — the bound is inclusive', () => {
    const asked = names('tool', 12);
    for (const n of asked) manualsPresent.add(n);
    const out = executeLoadToolDocs(AGENT, asked);
    expect(out).not.toContain('at most');
    expect(out).toContain('Loaded documentation for 12 tool(s)');
    expect(getSessionLoadedTools(AGENT).size).toBe(12);
  });

  it('accepts 8 — the largest array in 372 live calls, so the corpus is untouched', () => {
    const asked = names('tool', 8);
    for (const n of asked) manualsPresent.add(n);
    const out = executeLoadToolDocs(AGENT, asked);
    expect(out).toContain('Loaded documentation for 8 tool(s)');
    expect([...getSessionLoadedTools(AGENT)]).toEqual(asked);
  });

  it.each([1, 2, 3, 4])('a %i-name call (98.4%% of the corpus) is byte-identical to the pre-cap behaviour', (n) => {
    const asked = names('tool', n);
    for (const x of asked) manualsPresent.add(x);
    const out = executeLoadToolDocs(AGENT, asked);
    // The pre-cap output shape, exactly: the count line, then the manuals joined by the
    // separator, and nothing appended.
    expect(out).toBe(
      `Loaded documentation for ${n} tool(s). These tools are now available to call directly.\n\n`
      + asked.map((x) => `# ${x}\n\nthe manual for ${x}`).join('\n\n---\n\n'),
    );
  });
});

describe('§2 THE SESSION CEILING, LRU BY LAST CALL', () => {
  it('is 64, above the widest real agent\'s lifetime accumulation and the observed rehydration', () => {
    expect(SESSION_TOOL_SET_MAX).toBe(64);
    expect(SESSION_TOOL_SET_MAX).toBeGreaterThan(56); // the widest REAL agent, lifetime
    expect(SESSION_TOOL_SET_MAX).toBeGreaterThan(43); // the observed post-restart rehydration
  });

  it('does not evict at or below the ceiling — a genuine working set is never touched', () => {
    const set = names('tool', SESSION_TOOL_SET_MAX);
    expect(markToolsLoaded(AGENT, set)).toEqual([]);
    expect(getSessionLoadedTools(AGENT).size).toBe(SESSION_TOOL_SET_MAX);
  });

  it('at the ceiling, one new name evicts exactly one — the least recently CALLED', () => {
    const set = names('tool', SESSION_TOOL_SET_MAX);
    markToolsLoaded(AGENT, set);
    // The record says: everything was called on turn 1, except the two below which were
    // called later. `tool_000` is therefore the least recently called name in the set.
    called(1, ...set);
    called(2, 'tool_000');
    called(3, 'tool_001');
    // ...and now `tool_000` is the OLDEST again, because turns 4 and 5 re-touch the rest.
    called(4, ...set.filter((n) => n !== 'tool_000'));
    const evicted = markToolsLoaded(AGENT, ['tool_new']);
    expect(evicted).toEqual(['tool_000']);
    expect(getSessionLoadedTools(AGENT).size).toBe(SESSION_TOOL_SET_MAX);
    expect(getSessionLoadedTools(AGENT).has('tool_000')).toBe(false);
    expect(getSessionLoadedTools(AGENT).has('tool_new')).toBe(true);
  });

  it('evicts a NEVER-CALLED name before a called one — loaded and unused is the coldest thing in the set', () => {
    const set = names('tool', SESSION_TOOL_SET_MAX);
    markToolsLoaded(AGENT, set);
    // Everything except the last two has been called; those two were loaded and never used.
    called(1, ...set.slice(0, SESSION_TOOL_SET_MAX - 2));
    const evicted = markToolsLoaded(AGENT, ['tool_new']);
    expect(evicted).toHaveLength(1);
    expect(set.slice(SESSION_TOOL_SET_MAX - 2)).toContain(evicted[0]);
  });

  it('NEVER evicts a name called in the newest turn on record — no prefix churn mid-turn', () => {
    const set = names('tool', SESSION_TOOL_SET_MAX);
    markToolsLoaded(AGENT, set);
    // `tool_000` is the coldest by load order AND by call order... except that it was called
    // in the newest turn, which pins it. The next-coldest goes instead.
    called(1, ...set);
    called(7, 'tool_000');
    const evicted = markToolsLoaded(AGENT, ['tool_new']);
    expect(evicted).toHaveLength(1);
    expect(evicted[0]).not.toBe('tool_000');
    expect(getSessionLoadedTools(AGENT).has('tool_000')).toBe(true);
  });

  it('NEVER evicts a name asked for in the very call that crossed the ceiling', () => {
    const set = names('tool', SESSION_TOOL_SET_MAX);
    markToolsLoaded(AGENT, set);
    // Calls spread over two turns, so only the NEWEST turn's names are pinned by the
    // current-turn rule and the rest are genuinely evictable — otherwise this clause would
    // be testing that pin instead of the just-loaded one.
    called(1, ...set);
    called(2, ...set.slice(2));
    const evicted = markToolsLoaded(AGENT, ['tool_new_a', 'tool_new_b']);
    expect(evicted).toHaveLength(2);
    expect(evicted).not.toContain('tool_new_a');
    expect(evicted).not.toContain('tool_new_b');
    const after = getSessionLoadedTools(AGENT);
    expect(after.has('tool_new_a') && after.has('tool_new_b')).toBe(true);
    expect(after.size).toBe(SESSION_TOOL_SET_MAX);
  });

  it('leaves the set OVER the ceiling rather than evicting a pinned name — over for one turn beats a broken prefix', () => {
    const set = names('tool', SESSION_TOOL_SET_MAX);
    markToolsLoaded(AGENT, set);
    // Every candidate was called in the newest turn on record, so every candidate is pinned.
    called(9, ...set);
    const evicted = markToolsLoaded(AGENT, ['tool_new']);
    expect(evicted).toEqual([]);
    expect(getSessionLoadedTools(AGENT).size).toBe(SESSION_TOOL_SET_MAX + 1);
  });

  it('REPORTS the eviction in the tool result — a name leaving the set is never silent', () => {
    const set = names('tool', SESSION_TOOL_SET_MAX);
    for (const n of [...set, 'tool_new']) manualsPresent.add(n);
    executeLoadToolDocs(AGENT, set.slice(0, 12));
    markToolsLoaded(AGENT, set);
    called(1, ...set);
    called(2, ...set.slice(1)); // `tool_000` is the one name not touched in the newest turn
    const out = executeLoadToolDocs(AGENT, ['tool_new']);
    expect(out).toContain('Evicted from your session set (unused longest):');
    expect(out).toContain('Re-load if you need them.');
    expect(out).toContain(evictionNote(['tool_000']));
  });

  it('an unreadable recency record does not break the load, and does not evict out of turn', () => {
    // The read is best effort by construction: no `messages` table at all must still answer
    // a load. Nothing was called, so load order is the only ranking left.
    mockDb.current!.exec('DROP TABLE messages');
    markToolsLoaded(AGENT, names('tool', SESSION_TOOL_SET_MAX));
    const evicted = markToolsLoaded(AGENT, ['tool_new']);
    expect(evicted).toEqual(['tool_000']);
  });
});

describe('§3 A MISSING MANUAL IS NOT A MISSING TOOL', () => {
  it('marks a known tool with no manual as LOADED, and says the manual is missing — not the tool', () => {
    manualsPresent.add('has_manual');
    const out = executeLoadToolDocs(AGENT, ['has_manual', 'no_manual_here']);
    // The old behaviour, and the lie: `Tools not found: no_manual_here`.
    expect(out).not.toContain('Tools not found');
    expect(out).toContain('no manual is available on this install for: no_manual_here');
    expect(out).toContain('real and callable');
    // THE LOAD STILL COUNTS. The tool is callable, so the API tools array must carry it —
    // otherwise the model is told it loaded and the array disagrees.
    expect([...getSessionLoadedTools(AGENT)]).toEqual(['has_manual', 'no_manual_here']);
  });

  it('counts the DOCS it actually returned, not the names it marked', () => {
    manualsPresent.add('has_manual');
    const out = executeLoadToolDocs(AGENT, ['has_manual', 'no_manual_here']);
    expect(out).toContain('Loaded documentation for 1 tool(s)');
  });

  it('a whole call of manual-less tools still loads them all, with no stray leading separator', () => {
    const out = executeLoadToolDocs(AGENT, ['a_tool', 'b_tool']);
    expect(out.startsWith('Loaded, but no manual')).toBe(true);
    expect(getSessionLoadedTools(AGENT).size).toBe(2);
  });

  it('still refuses an empty or non-array request exactly as before', () => {
    expect(executeLoadToolDocs(AGENT, [])).toBe('Error: tools parameter must be a non-empty array of tool names');
    // @ts-expect-error — the runtime guard exists for callers TypeScript cannot see
    expect(executeLoadToolDocs(AGENT, 'exec')).toBe('Error: tools parameter must be a non-empty array of tool names');
  });
});

describe('§4 REHYDRATION IS BOUNDED WITHOUT LOSING THE REPLAYED ORDER', () => {
  it('replays the load sequence in order and applies the ceiling to the result', () => {
    // 70 names across 7 recorded load calls, all in one session: more than the ceiling, so
    // the replay must both preserve its own order and come back bounded.
    const all = names('tool', 70);
    for (let i = 0; i < 7; i++) {
      clock += 1000;
      const batch = all.slice(i * 10, i * 10 + 10);
      mockDb.current!.prepare(
        'INSERT INTO messages (id, agent_id, role, content, created_at, turn_number) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(`L${clock}`, AGENT, 'assistant', JSON.stringify(
        [{ type: 'tool_use', id: `l${i}`, name: 'load_tool_docs', input: { tools: batch } }],
      ), clock, i + 1);
    }
    rehydrateSessionToolsFromHistory(AGENT);
    const after = [...getSessionLoadedTools(AGENT)];
    // THE CEILING APPLIES AFTER REPLAY. Before the tiered eviction existed this came back at
    // 71 — every replayed name was "just loaded", so the pin meant for an ordinary call
    // disabled the bound entirely on the one path that can exceed it in a single step.
    expect(after.length).toBe(SESSION_TOOL_SET_MAX);
    // ORDER PRESERVED: what survives is still in replayed-load order, so the rebuilt tools
    // array is a prefix-stable reproduction of the pre-restart one rather than a reshuffle.
    // (`load_tool_docs` itself rides along from the CALLED pass — requirement #15 — and is
    // appended behind the replayed sequence, so it cannot move a name the record placed.)
    const replayedInOrder = [...all, 'load_tool_docs'].filter((n) => after.includes(n));
    expect(after).toEqual(replayedInOrder);
    // The names that went are the OLDEST loads, from the front of the sequence.
    expect(after).not.toContain(all[0]);
    expect(after).toContain(all[all.length - 1]);
  });

  it('under the ceiling, rehydration is byte-identical to before: every replayed name, in order', () => {
    const all = names('tool', 12);
    clock += 1000;
    mockDb.current!.prepare(
      'INSERT INTO messages (id, agent_id, role, content, created_at, turn_number) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('L1', AGENT, 'assistant', JSON.stringify(
      [{ type: 'tool_use', id: 'l1', name: 'load_tool_docs', input: { tools: all } }],
    ), clock, 1);
    rehydrateSessionToolsFromHistory(AGENT);
    // Every replayed name, in replayed order, with `load_tool_docs` behind them: the CALLED
    // pass (requirement #15) sees the load row itself and appends it, exactly as it did
    // before the ceiling existed. Nothing is evicted under the bound.
    expect([...getSessionLoadedTools(AGENT)]).toEqual([...all, 'load_tool_docs']);
  });

  it('a session reset still forgets the set, and still makes the decision stick across a restart', () => {
    markToolsLoaded(AGENT, ['tool_a', 'tool_b']);
    clearSessionLoadedTools(AGENT);
    expect(getSessionLoadedTools(AGENT).size).toBe(0);
    // The rehydration flag is set by the reset, so a replay cannot hand the session back.
    rehydrateSessionToolsFromHistory(AGENT);
    expect(getSessionLoadedTools(AGENT).size).toBe(0);
  });
});

describe('§5 THE HANDLER IS THE SEAM — the cap is measured on what the model ASKED for', () => {
  const def = (name: string): ToolDefinition =>
    ({ name, description: `d ${name}`, input_schema: { type: 'object', properties: {} } }) as ToolDefinition;
  const ask = (tools: unknown) => metaHandlers.load_tool_docs({
    agentId: AGENT, name: 'load_tool_docs', args: { tools },
    callId: 'c1', toolCall: { id: 'c1', name: 'load_tool_docs', arguments: { tools } } as ToolCall,
  });

  it('refuses 13 with the cap sentence and INVALID_ARGS — not a permission problem, not a crash', async () => {
    const asked = names('tool', 13);
    vi.mocked(getFilteredTools).mockReturnValue(asked.map(def));
    const r = await ask(asked);
    expect(r.content).toBe(loadToolDocsOverflowRefusal(13));
    expect(r.isError).toBe(true);
    // The code matters as much as the prose: a bad argument answered as a generic failure
    // tells the loop the tool CRASHED, and the loop retries a crash — with the same 13 names.
    expect(r.errorCode).toBe('INVALID_ARGS');
    expect(getSessionLoadedTools(AGENT).size).toBe(0);
  });

  it('refuses on the RAW request, even when the agent may only use a handful of the names', async () => {
    // THE REASON THE CAP IS NOT INSIDE `executeLoadToolDocs`: by there the array has been
    // narrowed to the accessible names, so this 40-name runaway would arrive as 3 and pass.
    const asked = names('tool', 40);
    vi.mocked(getFilteredTools).mockReturnValue(asked.slice(0, 3).map(def));
    const r = await ask(asked);
    expect(r.content).toBe(loadToolDocsOverflowRefusal(40));
    expect(r.isError).toBe(true);
  });

  it('passes 12 straight through to the real executor — the bound is inclusive at the handler too', async () => {
    const asked = names('tool', 12);
    for (const n of asked) manualsPresent.add(n);
    vi.mocked(getFilteredTools).mockReturnValue(asked.map(def));
    const r = await ask(asked);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('Loaded documentation for 12 tool(s)');
    expect(getSessionLoadedTools(AGENT).size).toBe(12);
  });

  it('leaves the two pre-existing shape refusals exactly as they were', async () => {
    expect((await ask(undefined)).content).toContain('must be a non-empty array');
    expect((await ask('exec')).content).toContain('must be an array of tool names');
  });
});
