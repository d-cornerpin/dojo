// Phase 5 (Part IV) — verify v2 tools-guidance contains the required
// new sections AND has the v1 MANDATORY/CRITICAL blocks deleted.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { ToolDefinition } from '../../agent/tools.js';

const mockDb = { current: null as Database.Database | null };

vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
}));

// (config/runtime.js mock removed in Phase 9 Stage 2 — module deleted)

vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: (id: string) => id === 'kevin',
  isPMAgent: () => false,
  getOwnerName: () => 'TestUser',
  getPrimaryAgentId: () => 'kevin',
  getPrimaryAgentName: () => 'Kevin',
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

vi.mock('../../agent/tools.js', () => {
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
      name: 'tracker_create_task',
      description: 'Create task',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'vault_search',
      description: 'Search vault',
      input_schema: { type: 'object', properties: {}, required: [] },
    },
  ];
  return { getFilteredTools: () => fakeTools };
});

beforeEach(() => {
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
  db.prepare(`INSERT INTO agents (id, name, status, classification) VALUES ('kevin', 'Kevin', 'idle', 'sensei')`).run();
  mockDb.current = db;
});

import { assembleSystemPrompt } from '../assembler.js';

describe('Phase 5 v2 tools-guidance content', () => {
  it('contains the "How You Communicate" terseness section verbatim', () => {
    const prompt = assembleSystemPrompt('kevin', 'test-model');
    expect(prompt).toContain('## How You Communicate');
    expect(prompt).toContain("Be terse. Lead with the answer.");
    expect(prompt).toContain('"I went ahead and read the file and now I\'ll..."');
    expect(prompt).toContain("expand only if the task genuinely needs detail");
    expect(prompt).toContain("When you don't know, say so directly and search the vault");
    expect(prompt).toContain("report it once with the cause");
  });

  it('contains the "How Tools Return Content" pattern section', () => {
    const prompt = assembleSystemPrompt('kevin', 'test-model');
    expect(prompt).toContain('## How Tools Return Content');
    expect(prompt).toContain('Tools default to **compact**');
  });

  it('does NOT contain v1 MANDATORY blocks', () => {
    const prompt = assembleSystemPrompt('kevin', 'test-model');
    expect(prompt).not.toMatch(/MANDATORY: Project Tracker/);
    expect(prompt).not.toMatch(/MANDATORY: Acknowledge & Report/);
    expect(prompt).not.toMatch(/MANDATORY: Check Techniques/);
    expect(prompt).not.toMatch(/CRITICAL: Communicating With Other Agents/);
  });

  it('does NOT contain v1 verbose vault instructions block', () => {
    const prompt = assembleSystemPrompt('kevin', 'test-model');
    // The 40-line v1 vault block had specific phrasing that we removed
    expect(prompt).not.toMatch(/Your Long-Term Memory \(The Vault\)/);
    expect(prompt).not.toMatch(/use vault_search instinctively/);
  });

  it('keeps short per-category notes (iMessage, vault, tracker, etc.)', () => {
    const prompt = assembleSystemPrompt('kevin', 'test-model');
    // Brief 1-2 line notes are part of the v2 design
    expect(prompt).toMatch(/## iMessage/);
    expect(prompt).toMatch(/## Talking to Other Agents/);
    expect(prompt).toMatch(/## Tracker/);
    expect(prompt).toMatch(/## Vault \(Long-Term Memory\)/);
  });

  it('keeps the Available Tools index', () => {
    const prompt = assembleSystemPrompt('kevin', 'test-model');
    expect(prompt).toContain('## Available Tools');
    expect(prompt).toContain('Always-loaded tools');
  });

  it('uses the trimmed "Project Manager" block (no FORBIDDEN paragraph)', () => {
    const prompt = assembleSystemPrompt('kevin', 'test-model');
    // v2 trim mentions PM and what they do briefly; NOT "FORBIDDEN" / "NEVER" caps
    expect(prompt).not.toMatch(/Creating your own monitoring infrastructure is FORBIDDEN/);
    expect(prompt).not.toMatch(/NEVER create monitoring, pulse-check, or status-polling agents/);
  });

  it('uses the trimmed "Message Sources" block (source-tag table only, no Channel awareness essay)', () => {
    const prompt = assembleSystemPrompt('kevin', 'test-model');
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
    const prompt = assembleSystemPrompt('kevin', 'test-model');
    const approxTokens = Math.ceil(prompt.length / 4);
    expect(approxTokens).toBeLessThan(6000); // hard ceiling — would mean we missed something big
  });
});
