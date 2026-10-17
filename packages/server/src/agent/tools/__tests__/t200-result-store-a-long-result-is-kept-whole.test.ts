// ════════════════════════════════════════════════════════════════════════════════════════
// t200 (D12, the owner's own design) — A LONG TOOL RESULT IS KEPT WHOLE, AND THE AGENT READS
// THE PART IT NEEDS.
//
// The owner: "Why can't we have the results go to a temporary file or scratchpad so the agent
// can load the part it needs into its context window?"
//
// What the agent got instead, measured at the base of this change:
//   · `exec`/`shell` cut each stream at 16,000 characters before anything was stored, so the
//     tail of a long command's output never existed anywhere the agent could reach;
//   · every tool with a declared `maxResultTokens` was cut the same way, and told to "narrow your
//     query", i.e. to run the tool again;
//   · everything else was stored whole and then cut to its first ~15,000 tokens in the model's
//     view, with advice to "call the same tool again with narrower arguments".
//
// Driven through the real doors: a real child process through `executeTool('exec')`, the loop's
// real recorder, the assembler's real view of the stored row, and `executeTool` again for the
// read. A real database built by the real migration chain.
// ════════════════════════════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../../db/connection.js', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  return {
    getDb: () => {
      if (!mockDb.current) throw new Error('test DB not initialized');
      return mockDb.current;
    },
    closeDb: vi.fn(),
    getDbPath: () => path.join((process.env.DOJO_TEST_HOME_ROOT || os.tmpdir()), 'dojo-t200-test', 'dojo.db'),
  };
});
vi.mock('../../../gateway/ws.js', () => ({ broadcast: () => { /* no-op */ } }));
// A real child process is spawned, so the capability facade answers rather than refuses. The
// capability itself is not under test here; its own contract suite owns it.
vi.mock('../../effects/capability.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireAuthorized: () => undefined,
}));

import { runMigrations } from '../../../db/migrations.js';
import { clearPlatformConfigCache } from '../../../config/platform.js';
import { executeTool } from '../index.js';
import { toolResultOf } from '../../tool-outcome.js';
import { persistXmlFallbackCollapse } from '../../v2/steps/execute/xml-fallback.js';
import type { ExecuteContext, TurnToolResult } from '../../v2/steps/execute/index.js';
import { getRecentMessages } from '../../../memory/store.js';
import { capLargeToolResultStrings } from '../../../memory/assembler.js';
import { V2_MAX_TOOL_RESULT_TOKENS } from '../../../memory/tool-result-view.js';
import { estimateTokens } from '../../../memory/budget.js';

const AGENT = 'agent-t200';

let migratedImage: Buffer | null = null;
function migratedDb(): Database.Database {
  if (migratedImage === null) {
    const seed = new Database(':memory:');
    mockDb.current = seed;
    runMigrations();
    migratedImage = seed.serialize();
    seed.close();
  }
  const db = new Database(migratedImage);
  db.pragma('foreign_keys = ON');
  return db;
}

beforeEach(() => {
  mockDb.current = migratedDb();
  mockDb.current.prepare(
    "INSERT INTO agents (id, name, status, config) VALUES (?, 'Main', 'idle', '{}')",
  ).run(AGENT);
  mockDb.current.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', ?)").run(AGENT);
  clearPlatformConfigCache();
});

/** 4,000 numbered lines of ~60 characters: about 240,000 characters, about 60,000 tokens.
 *  Line 3,500 alone carries the needle, far past anything a head-kept view could show. */
const LONG_OUTPUT_PROGRAM = [
  '/usr/bin/awk',
  'BEGIN { for (i = 1; i <= 4000; i++) printf "row %04d %s\\n", i, (i == 3500 ? "NEEDLE-IN-THE-TAIL" : "padding padding padding padding padding padding"); }',
];

/** Run one tool through the executor's real door and return what the loop would record. */
async function run(id: string, name: string, args: Record<string, unknown>): Promise<TurnToolResult> {
  const r = toolResultOf(await executeTool(AGENT, { id, name, arguments: args }));
  return r as unknown as TurnToolResult;
}

/** Record results exactly as the loop does at the end of an iteration. */
function record(results: TurnToolResult[], turnNumber = 1): void {
  const ctx = {
    agentId: AGENT, agent: { id: AGENT, name: 'Main' }, turnNumber,
    result: { toolCalls: results.map((r) => ({ id: r.toolCallId, name: r.name, arguments: {} })) },
    persistedContent: '', messageId: `assistant-${turnNumber}`,
    effectiveModelIdForPersist: null, interAgentTurn: false, hasXmlFallbackTools: false,
  } as unknown as ExecuteContext;
  persistXmlFallbackCollapse(ctx, results);
}

/** What the model is shown for each result on the newest tool row, through the assembler's own cap. */
function modelView(): Array<{ tool_use_id: string; content: string }> {
  const rows = getRecentMessages(AGENT, 20).filter((m) => m.role === 'tool');
  const [view] = capLargeToolResultStrings([rows[rows.length - 1]]);
  return JSON.parse(view.content) as Array<{ tool_use_id: string; content: string }>;
}

describe('t200 — a 60K-token exec result is kept whole and read in parts', () => {
  it('the view is small, says what it is and how to read the rest, and never says to run the tool again', async () => {
    const result = await run('call-t200-exec', 'exec', { argv: LONG_OUTPUT_PROGRAM });
    expect(result.isError).toBe(false);
    record([result]);

    const [block] = modelView();
    expect(estimateTokens(block.content)).toBeLessThanOrEqual(V2_MAX_TOOL_RESULT_TOKENS);
    // Labelled: the full size, and the call that reads the rest, by this result's own id.
    expect(block.content).toMatch(/kept whole/i);
    expect(block.content).toContain('tool_result_read');
    expect(block.content).toContain('call-t200-exec');
    expect(block.content).not.toMatch(/same tool again|narrow your query|re-run|re-call/i);
    // The head is in view, so a reader of the first lines is not sent away empty-handed.
    expect(block.content).toContain('row 0001');
  });

  it('the agent reads lines from the tail of the result, by line number', async () => {
    record([await run('call-t200-exec', 'exec', { argv: LONG_OUTPUT_PROGRAM })]);

    const page = await run('read-1', 'tool_result_read', { id: 'call-t200-exec', from_line: 3495, to_line: 3505 });
    expect(page.isError).toBe(false);
    expect(page.content).toContain('row 3500 NEEDLE-IN-THE-TAIL');
    expect(page.content).toContain('row 3496');
    expect(page.content).not.toContain('row 3520');
  });

  it('the agent searches the result and is told the line the text is on', async () => {
    record([await run('call-t200-exec', 'exec', { argv: LONG_OUTPUT_PROGRAM })]);

    const hits = await run('read-2', 'tool_result_read', { id: 'call-t200-exec', search: 'needle-in-the-tail' });
    expect(hits.isError).toBe(false);
    expect(hits.content).toContain('row 3500 NEEDLE-IN-THE-TAIL');
    expect(hits.content).toMatch(/1 match/);
    // The line number the agent would pass back to read around the hit.
    expect(hits.content).toMatch(/\b3501\b/);
  });
});
