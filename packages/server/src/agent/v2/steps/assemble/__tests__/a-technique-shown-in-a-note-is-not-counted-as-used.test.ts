// A technique the engine only shows the agent in a note is not counted as used: only use_technique counts.
// The real injector and the real store; faked: the embedding search and the agent's integrations.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
vi.mock('../../../../../memory/vector-search.js', () => ({ vectorSearch: async () => [{ sourceId: 't-summary', similarity: 0.9 }] }));
vi.mock('../../../../../memory/integration-status-lane.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/integration-status-lane.js')>()),
  usableIntegrationFamilies: async () => new Set<string>(),
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { advance, initState } from '../../../state.js';
import { injectTechniqueAndGapHints } from '../technique-hints.js';

const AGENT = randomUUID();
let dir = '';

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES (?, 'Helper', 'idle', '{}')").run(AGENT);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'technique-used-'));
  fs.writeFileSync(path.join(dir, 'TECHNIQUE.md'), '# Summary\nWrite three short paragraphs.\n');
  mockDb.current.prepare("INSERT INTO techniques (id, name, description, state, directory_path, enabled) VALUES ('t-summary', 'Weekly summary', 'Writes a weekly summary', 'published', ?, 1)").run(dir);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; fs.rmSync(dir, { recursive: true, force: true }); });

describe('a technique shown in a note is not counted as used', () => {
  it('a strong match is shown, and no use is recorded', async () => {
    const ask = 'Write me the weekly summary.';
    const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: ask }];
    const state = advance(initState({ agentId: AGENT } as Parameters<typeof initState>[0]), { loopCount: 1 });
    await injectTechniqueAndGapHints(state, { agentId: AGENT, lastUserMessageContent: ask, mctx: {} as never, messages: messages as never });
    expect(messages.slice(1).map((m) => String(m.content)).join('\n')).toContain('"Weekly summary"');
    expect(mockDb.current!.prepare("SELECT COUNT(*) AS n FROM technique_usage WHERE technique_id = 't-summary'").get()).toEqual({ n: 0 });
    expect(mockDb.current!.prepare("SELECT usage_count FROM techniques WHERE id = 't-summary'").get()).toEqual({ usage_count: 0 });
  });
});
