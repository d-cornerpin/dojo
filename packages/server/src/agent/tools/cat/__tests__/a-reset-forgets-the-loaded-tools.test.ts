// ════════════════════════════════════════════════════════════════════════════════════════
// T85 / W4 — A RESET THROUGH THE TOOL FORGETS THE LOADED TOOL DOCS, LIKE THE OTHER DOOR.
//
// ── THE FINDING, MEASURED (two-phase-loader code-path audit, 2026-09-26) ──
// There are two reset doors and they disagreed:
//
//   * the dashboard's "new session" route — `gateway/routes/chat.ts:418-422` — calls
//     `clearSessionLoadedTools(agentId)`;
//   * the `reset_session` TOOL — `agent/tools/cat/session.ts` — did not.
//     `grep -c clearSessionLoadedTools packages/server/src/agent/tools/cat/session.ts` → 0.
//
// So an agent reset through the TOOL (the Healer's path for a wedged agent, and an agent's own
// self-reset) was archived, given a session boundary, stripped of its continuity brief and its
// scratchpad, handed a reorientation message — and kept every tool it had loaded in the in-process
// set, so its tools array never returned to the always-loaded head until the process restarted.
// `tools/tool-docs.ts:281` states the doctrine the tool was not honouring: "A reset is a DECISION
// to forget."
//
// ── WHAT THIS FILE PROVES, AND WHY IT IS THE ARRAY IT ASSERTS ON ──
// Not "the function was called" — that is a spy assertion and it would pass a call that cleared the
// wrong agent. The claim is about the payload, so the clauses drive the REAL handler against a real
// in-memory DB (the idiom of `healer/__tests__/compaction-before-reset.test.ts`) and then ask
// `partitionToolsForApiCall` — the one expression `model.ts` builds every request's tools array
// from — whether the loaded tool still rides. Before the reset it does; after it must not.
//
// A control rides along: a reset that REFUSES must not forget anything. The clear sits behind the
// tool's guards, not in front of them, so a refused reset leaves the session's loaded tools exactly
// where they were.
//
// ⚠ NO `vi.resetModules()` IN THIS FILE, DELIBERATELY. The handler reaches `tools/tool-docs.ts`
// through `await import` (the route's idiom), and the state under test is that module's own
// `Map`. Resetting the registry between the test's import and the handler's would hand them two
// different maps and the clauses would be measuring nothing.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };

vi.mock('../../../../db/connection.js', async () => {
  const os = await import('node:os');
  const p = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => p.join(os.tmpdir(), 'dojo-t85-reset-forgets-tools', 'dojo.db'),
  };
});

vi.mock('../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../vault/archive.js', () => ({ archiveAgentConversation: vi.fn(() => 'archive-1') }));
vi.mock('../../../session-reset.js', () => ({ buildSessionResetMessage: vi.fn(() => '[System: reoriented]') }));
vi.mock('../../../v2/counterparty.js', () => ({ rehomeUnclaimedEngineEvents: vi.fn() }));
vi.mock('../../../../memory/message-store.js', () => ({ insertMessageIfAbsent: vi.fn(() => null) }));
vi.mock('../../../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));

import { runMigrations } from '../../../../db/migrations.js';
import { sessionHandlers } from '../session.js';
import {
  markToolsLoaded,
  getSessionLoadedTools,
  clearSessionLoadedTools,
  partitionToolsForApiCall,
  resetRehydrationForTests,
} from '../../../../tools/tool-docs.js';
import type { ToolDefinition } from '../../types.js';

const HEALER = 'healer';
const TARGET = 'wedged-agent';
const GHOST = 'already-terminated';

/** The tool the session LOADED — it must ride the array before the reset and not after. */
const LOADED = 'calendar_create';

const tool = (name: string): ToolDefinition =>
  ({ name, description: `doc for ${name}`, input_schema: { type: 'object', properties: {} } } as ToolDefinition);

const PERMITTED: ToolDefinition[] = [tool('load_tool_docs'), tool(LOADED)];
const ALWAYS_LOADED = ['load_tool_docs'];

/** What the transport would serialise for this agent right now, by name. */
function toolsOnTheWire(agentId: string): string[] {
  return partitionToolsForApiCall(agentId, PERMITTED, ALWAYS_LOADED).tools.map((t) => t.name);
}

/** Drives the REAL `reset_session` handler, the cast idiom every cat/* handler test uses. */
async function callReset(callerId: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
  const h = sessionHandlers['reset_session'];
  return h({ agentId: callerId, args } as unknown as Parameters<typeof h>[0]);
}

beforeEach(() => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  mockDb.current = db;
  runMigrations();
  db.prepare(
    "INSERT INTO agents (id, name, status) VALUES (?, 'Wedged', 'idle'), (?, 'Healer', 'idle'), (?, 'Ghost', 'terminated')",
  ).run(TARGET, HEALER, GHOST);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('healer_agent_id', ?)").run(HEALER);
  // The in-process session state outlives a DB, so each clause starts from a stated zero.
  clearSessionLoadedTools(TARGET);
  clearSessionLoadedTools(GHOST);
  resetRehydrationForTests();
});

afterEach(() => {
  mockDb.current?.close();
  mockDb.current = null;
});

describe('T85/W4 — the reset_session TOOL clears the session-loaded tool docs', () => {
  it('a tool loaded this session rides the array before the reset and is gone after it', async () => {
    markToolsLoaded(TARGET, [LOADED]);
    // The premise, asserted rather than assumed: without it the clause would pass on an
    // array that never carried the tool in the first place.
    expect(getSessionLoadedTools(TARGET).has(LOADED)).toBe(true);
    expect(toolsOnTheWire(TARGET)).toEqual(['load_tool_docs', LOADED]);

    const result = await callReset(HEALER, { agent_id: TARGET });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Session reset complete');

    expect(
      [...getSessionLoadedTools(TARGET)],
      'the tool reset the session and left the loaded tool docs in the in-process set',
    ).toEqual([]);
    expect(
      toolsOnTheWire(TARGET),
      'the loaded tool still rides the request array after a tool-driven reset — the array did not '
      + 'return to the always-loaded head, which is the whole observable point of a reset',
    ).toEqual(['load_tool_docs']);
  });

  it('a SELF-reset forgets too — the same door an agent uses on itself', async () => {
    markToolsLoaded(TARGET, [LOADED]);
    const result = await callReset(TARGET, { agent_id: TARGET });
    expect(result.isError).toBe(false);
    expect(toolsOnTheWire(TARGET)).toEqual(['load_tool_docs']);
  });

  it('the decision STICKS: the rehydration flag is set, so the next turn cannot re-import the session', async () => {
    // `clearSessionLoadedTools` is the function that both deletes the set AND marks the agent
    // rehydrated (`tool-docs.ts:279-285`), which is what stops the next turn replaying the
    // pre-reset load history back into the array. Asserting the flag here is how this clause
    // knows the tool called THAT function rather than deleting the map entry by hand.
    markToolsLoaded(TARGET, [LOADED]);
    await callReset(HEALER, { agent_id: TARGET });
    const { rehydrateSessionToolsFromHistory } = await import('../../../../tools/tool-docs.js');
    rehydrateSessionToolsFromHistory(TARGET);
    expect(toolsOnTheWire(TARGET)).toEqual(['load_tool_docs']);
  });

  it('CONTROL: a REFUSED reset forgets nothing — the clear sits behind the guards', async () => {
    // A terminated agent is refused by the earliest guard of all (`resolveAgentRef`, which will
    // not resolve a terminated row), so this is the strongest form of the control: the handler
    // returns before it archives, before it writes a boundary, and before the clear.
    markToolsLoaded(GHOST, [LOADED]);
    const result = await callReset(HEALER, { agent_id: GHOST });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('is terminated');
    expect(
      toolsOnTheWire(GHOST),
      'a reset the tool refused still wiped the session-loaded tools — the clear is in front of '
      + 'the guards instead of behind them',
    ).toEqual(['load_tool_docs', LOADED]);
  });

  it('CONTROL: the other agent\'s session is untouched — the clear names the RESOLVED target', async () => {
    markToolsLoaded(TARGET, [LOADED]);
    markToolsLoaded(HEALER, [LOADED]);
    await callReset(HEALER, { agent_id: TARGET });
    expect(toolsOnTheWire(TARGET)).toEqual(['load_tool_docs']);
    expect(
      toolsOnTheWire(HEALER),
      'resetting one agent cleared the CALLER\'s loaded tools — the clear is reading the wrong id',
    ).toEqual(['load_tool_docs', LOADED]);
  });
});
