// v3.5 owner test 2, fix rank 5 (DIAGNOSIS-test2.md, Problem 2). The field line: "The engine-injected technique hint is
// for the M365 Campaign Demo Builder ... Ignoring it." Three defects, three clauses:
//   1. FRAMING: the note named the mechanism ("engine-injected"), asserted a match ("This task matches") and handed the
//      model a decision ("Follow ... unless"). It is now a plain fact the model may use.
//   2. GATE: a technique whose procedure names an integration's tools is offered only when the agent can use that
//      integration now. Structural (the tool-name table), never prose.
//   3. NO KEYWORD FALLBACK: with no embedding service, no technique is offered (the token-overlap matcher is deleted).
// The real injector, the real store and the real classifier; faked: the embedding search and the agent's integrations.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../../../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../../../../../gateway/ws.js', () => ({ broadcast: vi.fn() }));
const search = vi.hoisted(() => ({ down: false, hits: [] as Array<{ sourceId: string; similarity: number }> }));
vi.mock('../../../../../memory/vector-search.js', () => ({
  vectorSearch: async () => { if (search.down) throw new Error('embedding service unavailable'); return search.hits; },
}));
const usable = vi.hoisted(() => ({ families: new Set<string>(['google']) }));
vi.mock('../../../../../memory/integration-status-lane.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../../memory/integration-status-lane.js')>()),
  usableIntegrationFamilies: async () => usable.families,
}));

import { runMigrations } from '../../../../../db/migrations.js';
import { advance, initState } from '../../../state.js';
import { injectTechniqueAndGapHints } from '../technique-hints.js';

const AGENT = 'agent-technique-note';
const dirs: string[] = [];

function technique(id: string, name: string, description: string, md: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'technique-note-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'TECHNIQUE.md'), md);
  mockDb.current!.prepare(`INSERT INTO techniques (id, name, description, state, directory_path, enabled) VALUES (?, ?, ?, 'published', ?, 1)`).run(id, name, description, dir);
}

async function inject(ask: string): Promise<Array<{ role: string; content: unknown }>> {
  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: ask }];
  const state = advance(initState({ agentId: AGENT } as Parameters<typeof initState>[0]), { loopCount: 1 });
  await injectTechniqueAndGapHints(state, { agentId: AGENT, lastUserMessageContent: ask, mctx: {} as never, messages: messages as never });
  return messages.slice(1);
}
const text = (ms: Array<{ content: unknown }>): string => ms.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  mockDb.current.prepare("INSERT INTO agents (id, name, status, config) VALUES (?, 'Note', 'idle', '{}')").run(AGENT);
  search.down = false; search.hits = [];
  usable.families = new Set(['google']);
  technique('t-m365', 'Campaign demo builder', 'Builds a campaign demo in the mailbox',
    '# Campaign demo\n1. Draft each message with outlook_create_draft.\n2. File it with outlook_move_to_folder.\n');
  technique('t-gmail', 'Receipt filing', 'Labels and archives receipts',
    '# Receipts\n1. Find them with user_gmail_search.\n2. Label them with gmail_label.\n');
  technique('t-plain', 'Weekly summary', 'Writes a weekly summary', '# Summary\nWrite three short paragraphs.\n');
});
afterEach(() => {
  mockDb.current?.close(); mockDb.current = null;
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('the technique note is a fact, for the integration the agent can use', () => {
  it('a STRONG match reads as a fact: no "engine-injected", no "This task matches", no "Follow"', async () => {
    search.hits = [{ sourceId: 't-gmail', similarity: 0.9 }];
    const out = text(await inject('Label and archive last week\'s receipts.'));
    expect(out).toContain('"Receipt filing"');
    expect(out).toMatch(/may be relevant/);
    expect(out).not.toMatch(/engine-injected|This task matches|Follow the procedure|unless the user/);
  });

  it('a WEAK match reads as a fact too: no "the DOJO matched", no "Load any that fit"', async () => {
    search.hits = [{ sourceId: 't-plain', similarity: 0.45 }];
    const out = text(await inject('Write me something for Friday.'));
    expect(out).toContain('"Weekly summary"');
    expect(out).not.toMatch(/the DOJO matched|Load any that fit|ignore otherwise|strong match|possible match/);
  });

  it('an M365 technique never rides a Gmail ask: an agent with only Google gets no note for it', async () => {
    search.hits = [{ sourceId: 't-m365', similarity: 0.9 }];
    const out = text(await inject('Label and archive last week\'s receipts.'));
    expect(out).not.toContain('Campaign demo builder');
  });

  it('CONTROL: the same technique is offered to an agent that can use Microsoft', async () => {
    usable.families = new Set(['google', 'microsoft']);
    search.hits = [{ sourceId: 't-m365', similarity: 0.9 }];
    expect(text(await inject('Build the campaign demo.'))).toContain('Campaign demo builder');
  });

  it('CONTROL: a technique that names no integration is not gated', async () => {
    usable.families = new Set();
    search.hits = [{ sourceId: 't-plain', similarity: 0.9 }];
    expect(text(await inject('Write the weekly summary.'))).toContain('Weekly summary');
  });

  it('with no embedding service, no technique is offered (no keyword fallback)', async () => {
    search.down = true;
    expect(await inject('Write the weekly summary, the receipt filing and the campaign demo builder.')).toEqual([]);
  });
});
