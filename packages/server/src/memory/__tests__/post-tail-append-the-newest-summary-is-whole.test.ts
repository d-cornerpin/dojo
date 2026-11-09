// ════════════════════════════════════════════════════════════════════════════════════════
// t210 — THE NEWEST SUMMARY IS ALWAYS WHOLE; OLDER ONES YIELD FIRST.
//
// The defect (re-derived at main `12f73cdc`, live on the dev box: 2,031 of 4,475 receipted
// summaries lanes since 2026-10-01 were `truncated`, every one at the 6,000 ceiling):
//   - the selector counted each summary's STORED `tokenCount`, but the lane renders more — a
//     header and an XML wrapper per summary — so a set packed to the ceiling always rendered
//     over it;
//   - the recency floor forced the two newest in even when they alone were over it;
//   - the fit then cut the block from the END, and the block is chronological, so the cut
//     always landed in the NEWEST summary, the one that bridges to the live conversation.
//
// Driven through the REAL assembler and the REAL fit on a migrated database. Each summary
// ends with its own END marker, so "whole" is checked by the bytes the model receives.
// ════════════════════════════════════════════════════════════════════════════════════════
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';

const mockDb = { current: null as Database.Database | null };
vi.mock('../../db/connection.js', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('test DB not initialized');
    return mockDb.current;
  },
  getDbPath: () => ':memory:',
}));
vi.mock('../embeddings.js', () => ({
  generateEmbedding: async () => null,
  queueEmbedding: () => { /* not exercised */ },
}));
vi.mock('../../gateway/ws.js', () => ({ broadcast: () => { /* not exercised */ } }));
vi.mock('../../tools/tool-docs.js', () => ({ measureAgentToolPayloadTokens: async () => 1000 }));

import { runMigrations } from '../../db/migrations.js';
import { insertMessage } from '../message-store.js';
import { assembleContext } from '../assembler.js';
import { LANE_TRUNCATION_MARKER } from '../lanes.js';

const AGENT = 'agent-sum';
const MODEL = 'model-sum';
const db = (): Database.Database => mockDb.current!;

function seed(contextWindow: number): void {
  db().prepare(
    "INSERT INTO providers (id, name, type, auth_type, base_url) VALUES ('p','P','openai-compatible','api_key','http://x')",
  ).run();
  db().prepare(
    `INSERT INTO models (id, provider_id, api_model_id, name, context_window, max_output_tokens, capabilities)
     VALUES (?, 'p', 'm', 'M', ?, 2048, '["tools"]')`,
  ).run(MODEL, contextWindow);
  db().prepare("INSERT INTO agents (id, name, status, model_id) VALUES (?, 'Summed', 'idle', ?)").run(AGENT, MODEL);
  insertMessage({ agentId: AGENT, role: 'user', lane: 'owner', senderId: 'owner', content: 'What did we settle last week?', turnNumber: 1 });
}

/** Summary `i` of `n`, `chars` long, ending in its own marker. Oldest first by `earliest_at`. */
function summary(i: number, chars: number): void {
  const id = `sum-${String(i).padStart(3, '0')}`;
  const end = ` END-OF-${id}`;
  let body = `Summary ${id}: the owner and the agent settled the shipping plan for bay ${i}. `;
  while (body.length < chars - end.length) body += 'The manifests were reconciled line by line and the totals agreed. ';
  const content = body.slice(0, chars - end.length) + end;
  const at = new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString();
  db().prepare(
    `INSERT INTO summaries (id, agent_id, depth, kind, content, token_count, descendant_count,
                            earliest_at, latest_at, created_at)
     VALUES (?, ?, 0, 'leaf', ?, ?, 3, ?, ?, ?)`,
  ).run(id, AGENT, content, Math.ceil(content.length / 4), at, at, at);
  db().prepare("INSERT INTO context_items (agent_id, item_type, item_id, ordinal) VALUES (?, 'summary', ?, ?)")
    .run(AGENT, id, i);
}

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `sum-${String(i).padStart(3, '0')}`);

/** The summaries block exactly as the model receives it. */
async function block(): Promise<{ text: string; grant: { status: string } | undefined }> {
  const ctx = await assembleContext(AGENT, MODEL);
  const all = ctx.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
  const start = all.indexOf('═══ COMPRESSED HISTORY');
  const end = all.indexOf('═══ END COMPRESSED HISTORY ═══');
  const grant = ctx.allocation?.grants.find((g) => g.id === 'lane.summaries');
  return { text: start >= 0 && end > start ? all.slice(start, end) : '', grant };
}

const whole = (text: string, id: string): boolean => text.includes(`END-OF-${id}`);
const present = (text: string, id: string): boolean => text.includes(`Summary ${id}:`);

beforeEach(() => {
  mockDb.current = new Database(':memory:');
  runMigrations();
});
afterEach(() => { mockDb.current?.close(); mockDb.current = null; });

describe('t210 — the newest summary reaches the model whole', () => {
  it('a set packed to the ceiling by stored size: the newest is whole and the block is not cut', async () => {
    // 7 x 3,300 chars = ~5,780 stored tokens, under 6,000 — but the rendered wrapper and header
    // push it over. This is the dev box's common case (median overflow 594 tokens).
    seed(200_000);
    for (let i = 0; i < 7; i++) summary(i, 3_300);
    const { text, grant } = await block();
    const newest = ids(7)[6];
    expect(whole(text, newest), 'the newest summary must arrive whole').toBe(true);
    expect(text, 'no summary is cut mid-text').not.toContain(LANE_TRUNCATION_MARKER.trim());
    expect(grant?.status, 'the lane fits its grant, so the fit never cuts it').toBe('admitted');
  });

  it('many small summaries: the wrapper never costs the newest ones (the 62-summary case)', async () => {
    seed(200_000);
    for (let i = 0; i < 62; i++) summary(i, 340);
    const { text } = await block();
    const all = ids(62);
    for (const id of all.slice(-10)) expect(whole(text, id), `${id} (one of the ten newest) must be whole`).toBe(true);
    expect(text).not.toContain(LANE_TRUNCATION_MARKER.trim());
    // What yields is the OLDEST, whole, and the omission is said, not hidden.
    const shown = all.filter((id) => present(text, id));
    expect(shown.length).toBeLessThan(62);
    expect(shown, 'the shown set is the newest run').toEqual(all.slice(62 - shown.length));
    expect(text).toMatch(/\d+ older summar(y is|ies are) not shown here/);
  });

  it('two large newest summaries over the ceiling together: the newest is whole and the older yields whole', async () => {
    // The old recency floor forced both in; the fit then cut the newest by more than half.
    seed(200_000);
    summary(0, 16_000);
    summary(1, 16_000);
    const { text } = await block();
    expect(whole(text, 'sum-001'), 'the newest is whole').toBe(true);
    expect(present(text, 'sum-000'), 'the older one yields, whole').toBe(false);
    expect(text).not.toContain(LANE_TRUNCATION_MARKER.trim());
  });

  it('a newest summary larger than 6,000 tokens on its own is still whole when the room holds it (no hard limit)', async () => {
    seed(200_000);
    summary(0, 2_000);
    summary(1, 30_000);
    const { text } = await block();
    expect(whole(text, 'sum-001')).toBe(true);
    expect(text).not.toContain(LANE_TRUNCATION_MARKER.trim());
  });

  it('a small window: the room decides, older summaries yield first, the newest stays whole', async () => {
    seed(12_000);
    for (let i = 0; i < 6; i++) summary(i, 3_000);
    const { text } = await block();
    expect(whole(text, 'sum-005'), 'the newest is whole').toBe(true);
    expect(present(text, 'sum-000'), 'the oldest yields first').toBe(false);
    expect(text).not.toContain(LANE_TRUNCATION_MARKER.trim());
  });

  it('CONTROL (cache): two assemblies with no summary written between them send the same summaries bytes', async () => {
    seed(200_000);
    for (let i = 0; i < 9; i++) summary(i, 3_100);
    const a = await block();
    const b = await block();
    expect(a.text.length).toBeGreaterThan(0);
    expect(b.text).toBe(a.text);
  });
});
