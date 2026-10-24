// K36 — the Healer report names each agent's three largest standing-instruction sections.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb: { current: Database.Database | null } = { current: null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  closeDb: vi.fn(),
  getDbPath: () => ':memory:',
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../agent/runtime.js', () => ({ getAgentRuntime: () => ({}) }));
vi.mock('../../services/imessage-bridge.js', () => ({ sendAlert: vi.fn() }));

import { runMigrations } from '../../db/migrations.js';
import { compileDiagnosticReport } from '../diagnostic.js';
import { recordPromptSections } from '../../memory/prompt-sections.js';

const J = '\n\n---\n\n';
beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations(mockDb.current);
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES ('a1', 'Worker', 'idle', '{}')").run();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

const find = () => (compileDiagnosticReport() as { items: Array<{ code: string; detail: string }> }).items.find((i) => i.code === 'PROMPT_COST');

describe('Healer: what the standing instruction costs', () => {
  it('names the three largest sections per agent, biggest first, and no fourth', () => {
    const sizes = [400, 1600, 800, 1200, 200];
    recordPromptSections('a1', sizes.map((n, i) => 'x'.repeat(n - (i ? J.length : 0))).join(J), sizes.map((_, i) => `sys.s${i}`));
    const item = find()!;
    expect(item.detail).toContain('Worker');
    expect(item.detail).toMatch(/sys\.s1 400 tokens.*sys\.s3 300 tokens.*sys\.s2 200 tokens/s);
    expect(item.detail).not.toContain('sys.s0');
    expect(item.detail).not.toContain('sys.s4');
  });

  it('says how much a section grew since its reference', () => {
    const t0 = Date.now() - 20 * 86400000;
    recordPromptSections('a1', 'x'.repeat(400), ['sys.a'], undefined, t0);
    recordPromptSections('a1', 'x'.repeat(800), ['sys.a']);   // reference moves to 100; now 200
    expect(find()!.detail).toContain('sys.a 200 tokens (+100 since the last reference)');
  });

  it('an agent never assembled is not listed; with none, there is no section', () => {
    expect(find()).toBeUndefined();
  });
});
