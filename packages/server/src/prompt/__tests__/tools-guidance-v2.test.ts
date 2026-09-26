// Phase 5 (Part IV) — verify v2 tools-guidance contains the required
// new sections AND has the v1 MANDATORY/CRITICAL blocks deleted.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolDefinition } from '../../agent/tools/types.js';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

// (config/runtime.js mock removed in Phase 9 Stage 2 — module deleted)

vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: (id: string) => id === 'primary',
  isPMAgent: () => false,
  getOwnerName: () => 'TestUser',
  getPrimaryAgentId: () => 'primary',
  getPrimaryAgentName: () => 'Primary',
  getPMAgentId: () => 'pm',
  getPMAgentName: () => 'PM',
}));

vi.mock('../../google/auth.js', () => ({
  getAgentGoogleAccessLevel: () => 'none',
}));

vi.mock('../../microsoft/auth.js', () => ({
  getAgentMicrosoftAccessLevel: () => 'none',
  getMsAccountType: () => 'msa',
  getMicrosoftWorkspaceConfig: () => ({ accountEmail: '' }),
}));

// T85: the surface is a mutable holder so a clause can state the agent's REAL tool surface
// (`null` = the four fakes every pre-T85 clause was written against, byte-for-byte).
const surfaceOverride: { current: ToolDefinition[] | null } = { current: null };

vi.mock('../../agent/tools/surface.js', () => {
  const fakeTools: ToolDefinition[] = [
    {
      name: 'imessage_send',
      description: 'Send iMessage',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'send_to_agent',
      description: 'Send to another agent',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'work_open',
      description: 'Create task',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'vault_search',
      description: 'Search vault',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
  ];
  return { getFilteredTools: () => surfaceOverride.current ?? fakeTools };
});

beforeEach(() => {
  surfaceOverride.current = null;
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      classification TEXT,
      group_id TEXT,
      parent_agent TEXT,
      status TEXT,
      tools_policy TEXT NOT NULL DEFAULT '{}',
      config TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.prepare(`INSERT INTO agents (id, name, status, classification) VALUES ('primary', 'Primary', 'idle', 'sensei')`).run();
  mockDb.current = db;
});

import { assembleSystemFromRegistry, buildAssemblyContext } from '../registry/assembler.js';

// The registry walker is the sole system-prompt assembler now (legacy
// assembleSystemPrompt/Parts deleted). This shim keeps the call sites readable.
function assembleSystemPrompt(agentId: string, modelId: string): string {
  return assembleSystemFromRegistry(buildAssemblyContext(agentId, modelId)).text;
}

describe('Phase 5 v2 tools-guidance content', () => {
  it('contains the "How You Communicate" terseness section verbatim', () => {
    const prompt = assembleSystemPrompt('primary', 'test-model');
    expect(prompt).toContain('## How You Communicate');
    expect(prompt).toContain("Be terse. Lead with the answer.");
    expect(prompt).toContain('"I went ahead and read the file and now I\'ll..."');
    expect(prompt).toContain("expand only if the task genuinely needs detail");
    expect(prompt).toContain("When you don't know, say so directly and search the vault");
    expect(prompt).toContain("report it once with the cause");
  });

  it('contains the "How Tools Return Content" pattern section', () => {
    const prompt = assembleSystemPrompt('primary', 'test-model');
    expect(prompt).toContain('## How Tools Return Content');
    expect(prompt).toContain('Tools default to **compact**');
  });

  it('does NOT contain v1 MANDATORY blocks', () => {
    const prompt = assembleSystemPrompt('primary', 'test-model');
    expect(prompt).not.toMatch(/MANDATORY: Project Tracker/);
    expect(prompt).not.toMatch(/MANDATORY: Acknowledge & Report/);
    expect(prompt).not.toMatch(/MANDATORY: Check Techniques/);
    expect(prompt).not.toMatch(/CRITICAL: Communicating With Other Agents/);
  });

  it('does NOT contain v1 verbose vault instructions block', () => {
    const prompt = assembleSystemPrompt('primary', 'test-model');
    // The 40-line v1 vault block had specific phrasing that we removed
    expect(prompt).not.toMatch(/Your Long-Term Memory \(The Vault\)/);
    expect(prompt).not.toMatch(/use vault_search instinctively/);
  });

  it('keeps short per-category notes (iMessage, vault, tracker, etc.)', () => {
    const prompt = assembleSystemPrompt('primary', 'test-model');
    // Brief 1-2 line notes are part of the v2 design
    expect(prompt).toMatch(/## iMessage/);
    expect(prompt).toMatch(/## Talking to Other Agents/);
    expect(prompt).toMatch(/## Tracker/);
    expect(prompt).toMatch(/## Vault \(Long-Term Memory\)/);
  });

  it('keeps the Available Tools index', () => {
    const prompt = assembleSystemPrompt('primary', 'test-model');
    expect(prompt).toContain('## Available Tools');
    expect(prompt).toContain('Always-loaded tools');
  });

  it('uses the trimmed "Project Manager" block (no FORBIDDEN paragraph)', () => {
    const prompt = assembleSystemPrompt('primary', 'test-model');
    // v2 trim mentions PM and what they do briefly; NOT "FORBIDDEN" / "NEVER" caps
    expect(prompt).not.toMatch(/Creating your own monitoring infrastructure is FORBIDDEN/);
    expect(prompt).not.toMatch(/NEVER create monitoring, pulse-check, or status-polling agents/);
  });

  it('uses the trimmed "Message Sources" block (source-tag table only, no Channel awareness essay)', () => {
    const prompt = assembleSystemPrompt('primary', 'test-model');
    expect(prompt).toMatch(/## Message Sources/);
    // The verbose "Channel awareness — keeping iMessage and dashboard separate" block
    // was a 15-line v1 essay; v2 must not include it.
    expect(prompt).not.toMatch(/keeping iMessage and dashboard conversations separate/);
  });

  it('total system prompt is materially smaller than v1 baseline (≥40% reduction target)', () => {
    // v1 typical primary agent prompt was 6-12K tokens. v2 target is <2K
    // for small tool inventories, but for primary agents with the full
    // platform (~165 tools) the tool index alone is ~1.4K. 4-5K total is
    // realistic and still a 50%+ cut from v1. Confirm we're in that range.
    const prompt = assembleSystemPrompt('primary', 'test-model');
    const approxTokens = Math.ceil(prompt.length / 4);
    expect(approxTokens).toBeLessThan(6000); // hard ceiling — would mean we missed something big
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════
// T85 — THE "Always-loaded tools" LINE ADVERTISES WHAT THE CALL CARRIES.
//
// ── THE GAP, MEASURED ON THE RELEASE GOLDEN (both auditors, independently) ──
// `checks/golden/cache-prefix.kevin.txt` is the real assembled prefix for the primary agent. Line
// 118 named THIRTY always-loaded tools, `complete_task` among them; the `===TOOLS===` array on the
// same request carried TWENTY-NINE. `getFilteredTools` strips `complete_task` from any agent that
// must not self-terminate (`agent/tools/surface.ts:301-309`) — the primary included, because it has
// nothing to complete to — while the line rendered `getAgentAlwaysLoadedTools`, the DECLARATION. So
// the cached system block promised a tool the call did not carry, and a model that trusted it spent
// a turn finding out.
//
// The fix is one expression, not a second opinion: the assembler now passes
// `partitionToolsForApiCall(...).alwaysLoaded` — the very head `model.ts` puts on the wire.
//
// ⚠ THIS MOVES THE CACHED PREFIX BY DESIGN (-15 bytes, `, complete_task`), so the kit's byte-exact
// cache-prefix golden goes red until it is deliberately re-blessed. That is the intended cost of
// the prompt stopping the lie; the delta is pinned below so the re-bless is auditable.
// ════════════════════════════════════════════════════════════════════════════════════════

import { PRIMARY_AGENT_ALWAYS_LOADED, partitionToolsForApiCall } from '../../tools/tool-docs.js';

const asTools = (names: string[]): ToolDefinition[] =>
  names.map((name) => ({
    name, description: `doc for ${name}`, input_schema: { type: 'object', properties: {}, required: [] },
  }));

/** Make `getAgentAlwaysLoadedTools('primary')` resolve to PRIMARY_AGENT_ALWAYS_LOADED: it reads the
 *  config table for the primary's id, and this harness's schema has no such table. */
function declarePrimaryInConfig(): void {
  mockDb.current!.exec('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT)');
  mockDb.current!.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('primary_agent_id', 'primary')").run();
}

const advertisedLine = (prompt: string): string => {
  const line = prompt.split('\n').find((l) => l.startsWith('**Always-loaded tools**:'));
  expect(line, 'the assembled prompt carries no **Always-loaded tools** line at all').toBeTruthy();
  return line as string;
};

describe('T85 — the advertised always-loaded set is the shipped one', () => {
  it('the primary\'s line does NOT name `complete_task`, because its array does not carry it', () => {
    declarePrimaryInConfig();
    // The primary's REAL surface: every declared name except the one `getFilteredTools` strips.
    const surface = asTools(PRIMARY_AGENT_ALWAYS_LOADED.filter((n) => n !== 'complete_task'));
    surfaceOverride.current = surface;

    const line = advertisedLine(assembleSystemPrompt('primary', 'test-model'));
    const expected = `**Always-loaded tools**: ${PRIMARY_AGENT_ALWAYS_LOADED.filter((n) => n !== 'complete_task').join(', ')}`;
    expect(line).toBe(expected);
    expect(line, 'the prompt still advertises a tool the request array does not carry').not.toContain('complete_task');

    // The re-bless delta, pinned where a reviewer can see it: the old line was the declaration.
    const declarationLine = `**Always-loaded tools**: ${PRIMARY_AGENT_ALWAYS_LOADED.join(', ')}`;
    expect(Buffer.byteLength(declarationLine) - Buffer.byteLength(line)).toBe(', complete_task'.length);
  });

  it('the advertised names EQUAL the shipped array\'s head names, in order', () => {
    declarePrimaryInConfig();
    // A surface narrower than the declaration in three more places, so the clause is about the
    // rule and not about `complete_task`: two permission strips and a policy strip.
    const withheld = new Set(['complete_task', 'exec', 'file_write', 'imessage_send']);
    const surface = asTools(PRIMARY_AGENT_ALWAYS_LOADED.filter((n) => !withheld.has(n)));
    surfaceOverride.current = surface;

    const advertised = advertisedLine(assembleSystemPrompt('primary', 'test-model'))
      .replace('**Always-loaded tools**: ', '').split(', ');
    const shippedHead = partitionToolsForApiCall('primary', surface, PRIMARY_AGENT_ALWAYS_LOADED)
      .alwaysLoaded.map((t) => t.name);

    expect(advertised).toEqual(shippedHead);
    for (const name of withheld) {
      expect(advertised, `${name} is advertised but is not on the agent's surface`).not.toContain(name);
    }
  });

  it('CONTROL: a surface that holds everything declared is advertised in full', () => {
    // Without this the clauses above would pass an implementation that simply dropped names.
    declarePrimaryInConfig();
    surfaceOverride.current = asTools(PRIMARY_AGENT_ALWAYS_LOADED);
    const line = advertisedLine(assembleSystemPrompt('primary', 'test-model'));
    expect(line).toBe(`**Always-loaded tools**: ${PRIMARY_AGENT_ALWAYS_LOADED.join(', ')}`);
    expect(line).toContain('complete_task');
  });
});
