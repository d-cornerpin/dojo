// ════════════════════════════════════════════════════════════════════════════════════════
// t269 fix round 2 (re-review, item 3) — THE NEWEST NOTE REACHES THE MODEL WHOLE, ON A SMALL WINDOW TOO.
//
// The re-review's 32K probe: the summaries lane's room was 2,394 tokens and the newest note 2,641, so the
// lane cut the newest note's text — against t210's rule "the newest is always whole". Two changes:
//   1. the LEAF is sized to the lane's room: what may be kept of it (1.5 × its target) fits the room the
//      lane has for its newest note on this agent's window;
//   2. a note that still cannot fit (an older, larger note left newest) is shown as the live view's kept-row
//      pointer — its start, its end and the read call — never cut.
// Driven through the REAL leaf fold, the REAL assembler and fit; only the writer's model call is scripted.
// All fixture text is invented filler; no real conversation, agent or person appears here.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => { if (!mockDb.current) throw new Error('test DB not initialized'); return mockDb.current; },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({ generateEmbedding: async () => null, queueEmbedding: () => {}, storeEmbedding: async () => {}, refreshEmbedding: () => {} }));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => {}, stampPersistedRow: (e: unknown) => e }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));
vi.mock('../../vault/archive.js', () => ({ archiveMessagesBeforeCompaction: vi.fn(() => 'archive-1'), isDreamerIgnored: vi.fn(() => false), getArchiveHighWaterMark: vi.fn(() => null) }));
/** The writer: always writes the most it may (1.5 × its target), ending in a marker. */
vi.mock('../../agent/model.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../agent/model.js')>()),
  callModel: async (p: { utilityTargetTokens?: number }) => {
    const end = ' END-OF-NEWEST-LEAF';
    const chars = Math.ceil((p.utilityTargetTokens ?? 100) * 1.5) * 4 - end.length - 8;
    return { content: 'The owner and the agent settled the plan. '.repeat(Math.ceil(chars / 42)).slice(0, chars) + end, toolCalls: [], inputTokens: 0, outputTokens: 0, stopReason: 'end_turn' };
  },
}));

// Imported FIRST: a module first loaded while the model mock's factory runs would bind the unmocked call.
import { runLeafCompaction, rebuildContextItems } from '../compaction.js';
import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { assembleContext } from '../assembler.js';
import { LANE_TRUNCATION_MARKER } from '../lanes.js';
import { findToolResult } from '../kept-results.js';

const AGENT = 'agent-t269-view';
const MODEL = 'model-t269-view';
const db = (): Database.Database => mockDb.current!;
const WINDOW = 32_768;

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
  db().prepare("INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')").run();
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities) VALUES (?, 'p', 'm', 'M', ?, 16384, '["tools"]')`).run(MODEL, WINDOW);   // a 32K model with 16K of output: a small content budget, as on the re-review's box
  // The summary writer is a large-window cloud model; the agent's own model has 32K (the re-review's shape).
  db().prepare(`INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities) VALUES ('writer-1m', 'p', 'w', 'W', 1000000, 16384, '["chat"]')`).run();
  db().prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Viewed', 'idle', ?)").run(AGENT, MODEL);
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

async function block(): Promise<string> {
  const ctx = await assembleContext(AGENT, MODEL);
  const all = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const start = all.indexOf('═══ COMPRESSED HISTORY');
  const end = all.indexOf('═══ END COMPRESSED HISTORY ═══');
  return start >= 0 && end > start ? all.slice(start, end) : '';
}

describe('t269 fix round 2 — on a 32K window the newest note is whole in view', () => {
  it('a leaf folded on a 32K window is sized to the lane: the writer writing the most it may still arrives whole', async () => {
    for (let t = 1; t <= 23; t += 1) {   // ~30K tokens: one full leaf span, so the newest note is a full one
      insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: `[ask ${t}] ${'please reconcile the manifest line by line. '.repeat(60)}`, turnNumber: t });
      insertMessage({ agentId: AGENT, role: 'assistant', lane: 'owner', content: `[answer ${t}] ${'the manifest lines agree with the totals. '.repeat(60)}`, turnNumber: t });
    }
    // Each row a minute apart, as a real conversation is (so "the newest note" is one note, not a tie).
    db().prepare('UPDATE messages SET created_at = ? + seq * 60000 WHERE agent_id = ?').run(Date.UTC(2026, 9, 1), AGENT);
    const created = await runLeafCompaction(AGENT, 'writer-1m', WINDOW, { floorRows: 4 });
    expect(created).toBeGreaterThan(0);
    rebuildContextItems(AGENT);
    const text = await block();
    expect(text, 'the newest note arrives').toContain('END-OF-NEWEST-LEAF');
    expect(text, '…whole: not as a pointer').not.toContain('KEPT WHOLE, NOT ALL SHOWN');
    expect(text).not.toContain(LANE_TRUNCATION_MARKER.trim());
  });

  it('a newest note larger than the lane\'s room is shown as its kept-row pointer, never cut; the pointer reads it whole', async () => {
    const content = `Summary of the plan. ${'The manifests were reconciled line by line and the totals agreed. '.repeat(700)} END-OF-BIG-NOTE`;   // ~11.6K tokens: more than the room
    const at = new Date(Date.UTC(2026, 9, 1)).toISOString();
    db().prepare(`INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count, earliest_at, latest_at, created_at)
                  VALUES ('sum-big', ?, 0, 'leaf', ?, ?, 3, ?, ?, ?)`).run(AGENT, content, Math.ceil(content.length / 4), at, at, at);
    db().prepare("INSERT INTO context_items (agent_id, item_type, item_id, ordinal) VALUES (?, 'summary', 'sum-big', 0)").run(AGENT);
    insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'What did we settle?', turnNumber: 1 });
    const text = await block();
    expect(text).not.toContain(LANE_TRUNCATION_MARKER.trim());
    expect(text, 'the pointer names the note').toContain('note:sum-big');
    expect(text, 'and shows its end').toContain('END-OF-BIG-NOTE');
    expect(findToolResult(AGENT, 'note:sum-big')?.content).toBe(content);
  });
});
