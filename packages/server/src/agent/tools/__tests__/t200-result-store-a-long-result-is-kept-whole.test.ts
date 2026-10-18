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
// capability itself is not under test here; its own contract suite owns it. It answers with the
// one field the process door reads from the real capability (t203): which agent's stop it is under.
vi.mock('../../effects/capability.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  requireAuthorized: () => ({ agentId: 'result-store-test-agent' }),
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

// ════════════════════════════════════════════════════════════════════════════════════════
// BEYOND THE RED: every tool, a batch, the rows recorded before t200, the lifetime, the reach.
// ════════════════════════════════════════════════════════════════════════════════════════
import { insertMessage } from '../../../memory/message-store.js';
import { getFilteredTools } from '../surface.js';
import { getAgentAlwaysLoadedTools } from '../../../tools/tool-docs.js';
import { pmMayCall } from '../../../tracker/pm-agent.js';
import { noteHandedCredentialValues, forgetHandedCredentialValues } from '../../../credentials/secret-values.js';
import { toolResultView, TOOL_RESULT_VIEW_CHARS, RESULT_READ_TOOL } from '../../../memory/tool-result-view.js';

const keptRows = (): Array<{ tool_use_id: string; message_id: string; content: string }> =>
  mockDb.current!.prepare('SELECT tool_use_id, message_id, content FROM kept_tool_results').all() as never;

/** Follow the reader's own "Continue" lines from line 1 to the end; return every line number seen. */
async function readToTheEnd(id: string): Promise<{ seen: number[]; pages: number }> {
  const seen: number[] = [];
  let from: number | null = 1;
  let pages = 0;
  while (from !== null) {
    const page = await run(`read-${pages}`, RESULT_READ_TOOL, { id, from_line: from });
    expect(page.content.length).toBeLessThanOrEqual(TOOL_RESULT_VIEW_CHARS);
    for (const r of page.content.split('\n')) {
      const m = r.match(/^\s*(\d+)\t/);
      if (m) seen.push(Number(m[1]));
    }
    const next = page.content.match(/"from_line":(\d+)\}\)\]$/);
    from = next ? Number(next[1]) : null;
    pages++;
    expect(pages).toBeLessThan(20);
  }
  return { seen, pages };
}

describe('t200 — any tool, not only exec', () => {
  it('a tool with no paging of its own (history_get of a long message) is kept whole and readable to its last line', async () => {
    const body = Array.from({ length: 3000 }, (_, i) => `paragraph ${i + 1} of a long pasted document, kept for the record`).join('\n');
    const msg = insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: body, turnNumber: 1 });
    const result = await run('call-t200-hget', 'history_get', { id: msg.id });
    expect(result.isError, result.content.slice(0, 300)).toBe(false);
    expect(result.content).toMatch(/KEPT WHOLE, NOT ALL SHOWN/);
    record([result]);
    const { seen, pages } = await readToTheEnd('call-t200-hget');
    expect(pages).toBeGreaterThan(1);
    const lines = (result.keptWhole ?? '').split('\n').length;
    expect(seen).toEqual(Array.from({ length: lines }, (_, i) => i + 1));
  });
});

describe('t200 — a batch of long results fits where one cut result used to (ctx 11)', () => {
  it('six 40K-token results in one response: the row the model sees stays under ONE view, and each is whole in the store', async () => {
    const results: TurnToolResult[] = [];
    for (let k = 1; k <= 6; k++) {
      const out = await run(`call-batch-${k}`, 'exec', {
        argv: ['/usr/bin/awk', `BEGIN { for (i = 1; i <= 2600; i++) printf "batch ${k} line %04d padding padding padding padding\\n", i; }`],
      });
      expect(out.content.length).toBeLessThan(TOOL_RESULT_VIEW_CHARS / 4);
      results.push(out);
    }
    record(results);
    const blocks = modelView();
    expect(blocks).toHaveLength(6);
    const viewTokens = estimateTokens(JSON.stringify(blocks));
    expect(viewTokens, 'six long results cost less than the one 15K-token view a single cut result used to take')
      .toBeLessThan(V2_MAX_TOOL_RESULT_TOKENS);
    expect(keptRows().map((r) => r.tool_use_id).sort()).toEqual(results.map((r) => r.toolCallId).sort());
    const tail = await run('read-batch', RESULT_READ_TOOL, { id: 'call-batch-4', search: 'line 2600' });
    expect(tail.content).toContain('batch 4 line 2600');
  });
});

describe('t200 — results recorded before t200 are read where they are, never copied', () => {
  it('a row stored whole the old way: its view is the pointer, the reader reads the row, the store stays empty', async () => {
    const old = Array.from({ length: 5000 }, (_, i) => `legacy line ${i + 1} padding padding padding padding padding`).join('\n');
    insertMessage({
      agentId: AGENT, role: 'tool', lane: 'owner', turnNumber: 1,
      content: JSON.stringify([{ type: 'tool_result', tool_use_id: 'call-legacy', content: old }]),
    });
    const [block] = modelView();
    expect(block.content).toBe(toolResultView(old, 'call-legacy'));
    expect(block.content).toContain('tool_result_read({"id":"call-legacy"');
    const page = await run('read-legacy', RESULT_READ_TOOL, { id: 'call-legacy', from_line: 4999 });
    expect(page.content).toContain('legacy line 5000');
    expect(keptRows()).toHaveLength(0);
  });

  it('the view is the same bytes every time it is rendered (the cached prefix does not move)', () => {
    const text = 'z\n'.repeat(80_000);
    expect(toolResultView(text, 'call-same')).toBe(toolResultView(text, 'call-same'));
  });
});

describe('t200 — a kept result lives exactly as long as its message row', () => {
  it('deleting the row removes it; deleting the agent removes it', async () => {
    record([await run('call-life-1', 'exec', { argv: LONG_OUTPUT_PROGRAM })]);
    expect(keptRows()).toHaveLength(1);
    mockDb.current!.prepare('DELETE FROM messages WHERE id = ?').run(keptRows()[0].message_id);
    expect(keptRows()).toHaveLength(0);
    expect((await run('read-gone', RESULT_READ_TOOL, { id: 'call-life-1' })).isError).toBe(true);

    record([await run('call-life-2', 'exec', { argv: LONG_OUTPUT_PROGRAM })], 2);
    expect(keptRows()).toHaveLength(1);
    mockDb.current!.prepare('DELETE FROM agents WHERE id = ?').run(AGENT);
    expect(keptRows()).toHaveLength(0);
  });

  it('one agent cannot read another agent\'s result by its id', async () => {
    record([await run('call-mine', 'exec', { argv: LONG_OUTPUT_PROGRAM })]);
    mockDb.current!.prepare("INSERT INTO agents (id, name, status, config) VALUES ('agent-other', 'Other', 'idle', '{}')").run();
    const theirs = toolResultOf(await executeTool('agent-other', { id: 'r-x', name: RESULT_READ_TOOL, arguments: { id: 'call-mine' } }));
    expect(theirs.isError).toBe(true);
    expect(theirs.content).toMatch(/No tool result with id "call-mine" is stored for you/);
  });

  it('a credential value the agent was handed is redacted in the kept whole, as on the row', async () => {
    const SECRET = 'sk-live-t200selftest-77c0e1';
    noteHandedCredentialValues(AGENT, [SECRET]);
    try {
      record([await run('call-secret', 'exec', {
        argv: ['/usr/bin/awk', `BEGIN { for (i = 1; i <= 4000; i++) printf "row %04d %s\\n", i, (i == 3000 ? "${SECRET}" : "padding padding padding padding padding padding"); }`],
      })]);
      expect(keptRows()[0].content).not.toContain(SECRET);
      expect(keptRows()[0].content).toContain('row 3000');
    } finally {
      forgetHandedCredentialValues(AGENT);
    }
  });
});

describe('t200 — every agent can act on the pointer it is shown', () => {
  it('the reader is always loaded, survives a curated allow list, and the PM may call it', () => {
    mockDb.current!.prepare(
      `INSERT INTO agents (id, name, status, config, tools_policy) VALUES ('agent-curated', 'Curated', 'idle', '{}', ?)`,
    ).run(JSON.stringify({ allow: ['get_current_time'], deny: [] }));
    expect(getFilteredTools('agent-curated').map((t) => t.name)).toContain(RESULT_READ_TOOL);
    expect(getAgentAlwaysLoadedTools(AGENT)).toContain(RESULT_READ_TOOL);
    expect(pmMayCall(RESULT_READ_TOOL)).toBe(true);
  });
});
