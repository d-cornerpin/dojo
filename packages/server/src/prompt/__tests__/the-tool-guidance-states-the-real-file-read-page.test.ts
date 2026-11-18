// The tool text caps a file_read page at V2_MAX_TOOL_RESULT_TOKENS (15000); the
// always-on guidance must state that same page size, not a smaller one.

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

vi.mock('../../config/platform.js', () => ({
  isPrimaryAgent: (id: string) => id === 'primary',
  isPMAgent: () => false,
  isTrainerAgent: () => false,
  getOwnerName: () => 'TestUser',
  getPrimaryAgentId: () => 'primary',
  getPrimaryAgentName: () => 'Primary',
  getPMAgentId: () => 'pm',
  getPMAgentName: () => 'PM',
  getTrainerAgentId: () => 'trainer',
  getTrainerAgentName: () => 'Trainer',
  getHealerAgentId: () => 'healer',
  getHealerAgentName: () => 'Healer',
}));

vi.mock('../../google/auth.js', () => ({
  getAgentGoogleAccessLevel: () => 'none',
  getGoogleWorkspaceConfig: () => ({ accountEmail: '' }),
  isGoogleConnected: () => false,
  isEmailMonitoringEnabled: () => false,
  isEmailSendingEnabled: () => false,
}));

vi.mock('../../microsoft/auth.js', () => ({
  getAgentMicrosoftAccessLevel: () => 'none',
  getMsAccountType: () => 'msa',
  getMicrosoftWorkspaceConfig: () => ({ accountEmail: '' }),
  isMicrosoftConnected: () => false,
  isMsEmailMonitoringEnabled: () => false,
  isMsEmailSendingEnabled: () => false,
}));

// The one input that moves between cases: the agent's tool surface.
const surface = { tools: [] as ToolDefinition[] };
vi.mock('../../agent/tools/surface.js', () => ({
  getFilteredTools: () => surface.tools,
}));

// The manifest, the SOUL conditional's only authority.
const manifest = { canSpawn: true };
vi.mock('../../agent/manifest.js', () => ({
  getAgentPermissions: () => ({ can_spawn_agents: manifest.canSpawn }),
}));

const tool = (name: string): ToolDefinition => ({
  name,
  description: name,
  input_schema: { type: 'object', properties: {}, required: [] },
});

beforeEach(() => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agents (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, classification TEXT,
      group_id TEXT, parent_agent TEXT, status TEXT, charter TEXT,
      permissions TEXT, spawn_depth INTEGER, created_by TEXT,
      tools_policy TEXT NOT NULL DEFAULT '{}', config TEXT NOT NULL DEFAULT '{}'
    );
  `);
  db.prepare("INSERT INTO agents (id, name, status, classification) VALUES ('bot', 'Bot', 'idle', 'apprentice')").run();
  mockDb.current = db;
  surface.tools = [];
  manifest.canSpawn = true;
});

import { generateToolsGuidance_v2 } from '../assembler.js';

describe('generateToolsGuidance_v2', () => {
  it('the tool guidance states the real file_read page size', () => {
    const out = generateToolsGuidance_v2('bot');
    expect(out).toContain('returns up to ~15K tokens with line numbers');
    expect(out).not.toContain('~8K tokens');
  });
});
